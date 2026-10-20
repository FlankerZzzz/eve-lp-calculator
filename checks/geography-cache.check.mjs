import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {openV2} from '../scripts/v2/database.mjs';
import {validateGeography,publishNavigation,failNavigation,syncGeography,geographyFeeds} from '../scripts/v2/geography.mjs';
import {readNavigationCache,navigationFeedValue} from '../lib/navigation-store.mjs';
import {feedIsCurrent} from '../lib/star-hover-environment.mjs';
import {enqueueDueTasks,nextQueuedTask} from '../scripts/v2/scheduler.mjs';
const now=new Date('2026-10-18T10:00:00Z');
function fixture(t){const dir=mkdtempSync(join(tmpdir(),'geography-')),filename=join(dir,'test.db'),db=openV2(filename);t.after(()=>{db.close();rmSync(dir,{recursive:true,force:true});});return {db,filename,dir};}
const rows={system_jumps:[{system_id:1,ship_jumps:9}],system_kills:[{system_id:1,ship_kills:2,pod_kills:1,npc_kills:8}],incursions:[{constellation_id:2,infested_solar_systems:[1],influence:.2,state:'established'}],sovereignty:[{system_id:1,alliance_id:99}],industry:[{solar_system_id:1,cost_indices:[{activity:'manufacturing',cost_index:.01}]}]};
test('five feeds validate entire batch; malformed data, duplicate IDs and empty catalogues rejected',()=>{
  for(const [kind,data] of Object.entries(rows)){assert.equal(validateGeography(kind,data),data);assert.throws(()=>validateGeography(kind,{}));assert.throws(()=>validateGeography(kind,[...data,...data]));assert.throws(()=>validateGeography(kind,[{...data[0],system_id:0,solar_system_id:0,constellation_id:0}]));}
  assert.deepEqual(validateGeography('incursions',[]),[]);assert.deepEqual(validateGeography('system_kills',[]),[]);
  for(const kind of ['sovereignty','industry'])assert.throws(()=>validateGeography(kind,[]));
  assert.throws(()=>validateGeography('system_jumps',[{system_id:1,ship_jumps:-1}]));assert.throws(()=>validateGeography('industry',[{solar_system_id:1,cost_indices:[{activity:'manufacturing',cost_index:NaN}]}]));
});
test('cache persists across connections; failures never erase last successful data',t=>{
  const {db,filename}=fixture(t);publishNavigation(db,'system_jumps',rows.system_jumps,now.toUTCString(),now);
  failNavigation(db,'system_jumps',new Error('HTTP 503'),now);
  const saved=readNavigationCache('system_jumps',filename),value=navigationFeedValue(saved,now.getTime());
  assert.deepEqual(value.rows,rows.system_jumps);assert.equal(value.error,'HTTP 503');assert.equal(value.stale,true);
  publishNavigation(db,'system_jumps',[],now.toUTCString(),now);
  assert.deepEqual(navigationFeedValue(readNavigationCache('system_jumps',filename),now.getTime()).rows,[]);
  assert.equal(readNavigationCache('system_jumps',filename).error,null);
  failNavigation(db,'industry',new Error('unavailable'),now);assert.equal(navigationFeedValue(readNavigationCache('industry',filename),now.getTime()).rows,null);
});
test('official windows deduplicate, support revisions and expire after 72h; feeds stay independent',t=>{
  const {db}=fixture(t),old=new Date(now.getTime()-73*3600000);
  publishNavigation(db,'system_jumps',[],old.toUTCString(),old);
  publishNavigation(db,'system_jumps',rows.system_jumps,now.toUTCString(),now);
  publishNavigation(db,'system_jumps',[{system_id:1,ship_jumps:10}],now.toUTCString(),now);
  const earlier=new Date(now.getTime()-1200000);publishNavigation(db,'system_kills',rows.system_kills,earlier.toUTCString(),now);
  const samples=db.prepare('SELECT * FROM navigation_samples ORDER BY kind').all();assert.equal(samples.length,2);assert.notEqual(samples[0].window_end,samples[1].window_end);assert.equal(JSON.parse(samples[0].payload)[0].ship_jumps,10);
  assert.throws(()=>publishNavigation(db,'system_jumps',[],null,now),/Last-Modified/);
  assert.throws(()=>publishNavigation(db,'system_jumps',[],old.toUTCString(),now),/较旧/);
  assert.throws(()=>publishNavigation(db,'system_jumps',[],new Date(now.getTime()+120000).toUTCString(),now),/未来/);
});
test('hourly freshness does not mislabel a valid cached incursion as expired after five minutes',t=>{
  const {db,filename}=fixture(t);publishNavigation(db,'incursions',rows.incursions,now.toUTCString(),now);
  const value=navigationFeedValue(readNavigationCache('incursions',filename),now.getTime()+30*60000);
  assert.equal(value.stale,false);assert.equal(feedIsCurrent(value,300000,now.getTime()+30*60000),true);assert.equal(feedIsCurrent(value,300000,now.getTime()+76*60000),false);
  assert.equal(navigationFeedValue(null,now.getTime()).rows,null);
});
test('geography defaults hourly, scheduler enqueues once and runs before long history',t=>{
  const {db}=fixture(t),task=db.prepare("SELECT * FROM tasks WHERE module='geography'").get();assert.equal(task.automatic,1);assert.equal(task.cron,'0 * * * *');
  db.prepare("UPDATE tasks SET automatic=0 WHERE module!='geography'").run();enqueueDueTasks(db,now);enqueueDueTasks(db,now);assert.equal(nextQueuedTask(db).module,'geography');
  db.prepare("UPDATE tasks SET status='queued' WHERE module='history'").run();assert.equal(nextQueuedTask(db).module,'geography');
});
test('sync independently publishes valid feeds, reports a failed feed and preserves old value',async t=>{
  const {db,filename}=fixture(t),requests=[],events=[];
  publishNavigation(db,'industry',rows.industry,null,new Date());
  const sync={db,filename,context:{signal:new AbortController().signal},progress(){},async request(path){requests.push(path);if(path==='/universe/names/')return {data:[{id:99,category:'alliance',name:'测试联盟'}]};const kind=Object.keys(geographyFeeds).find(k=>geographyFeeds[k]===path);if(kind==='industry')throw new Error('HTTP 503');return {data:rows[kind],modified:new Date().toUTCString()};}};
  await assert.rejects(syncGeography(sync,'test',{info:(...args)=>events.push(args)}),/industry/);
  assert.equal(requests.length,6);assert.equal(JSON.parse(readNavigationCache('system_jumps',filename).payload)[0].ship_jumps,9);assert.deepEqual(JSON.parse(readNavigationCache('industry',filename).payload),rows.industry);assert.match(readNavigationCache('industry',filename).error,/503/);
  assert.ok(events.some(e=>e[0]==='geography_feed_failed'));
});
test('production navigation readers have no network fallback, writable DB or file snapshots',()=>{
  for(const file of ['lib/navigation-feed.ts','lib/navigation-snapshot.ts','app/api/navigation/jump/catalog/route.ts','app/api/navigation/jump/stations/route.ts']){
    const text=readFileSync(new URL('../'+file,import.meta.url),'utf8');assert.doesNotMatch(text,/RequestPool|fetch\(|readFile|createNavigationFeed/);assert.match(text,/readNavigationCache/);
  }
  assert.match(readFileSync(new URL('../lib/navigation-store.mjs',import.meta.url),'utf8'),/readOnly:true/);
});
