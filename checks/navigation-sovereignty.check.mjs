import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {openV2} from '../scripts/v2/database.mjs';
import {syncSovereigntyNames} from '../scripts/v2/geography.mjs';
import {sovereigntyForSystem,sovereigntySummary} from '../lib/navigation-sovereignty.mjs';
const names=[{id:500001,category:'faction',name:'加达里合众国'},{id:99000001,category:'alliance',name:'晨曦联盟'},{id:98000001,category:'corporation',name:'晨曦军团'}];
const feed={rows:[{system_id:1,faction_id:500001},{system_id:2,alliance_id:99000001,corporation_id:98000001},{system_id:3,corporation_id:98000001},{system_id:4}],names,stale:false,error:null};
test('compact sovereignty labels retain icons but omit type and source while preserving unknowns and quality',()=>{
  const env={sovereignty:feed};
  for(const [id,text] of [[1,'主权：加达里合众国'],[2,'主权：晨曦联盟'],[3,'主权：晨曦军团'],[4,'主权：未宣称主权'],[5,'主权：未提供归属']])assert.equal(sovereigntySummary(sovereigntyForSystem(id,env)).text,text);
  const summary=sovereigntySummary(sovereigntyForSystem(1,{sovereignty:{...feed,stale:true,namesError:'failed'}}));
  assert.match(summary.title,/资料待更新/);assert.match(summary.title,/名称缓存待更新/);assert.equal(sovereigntySummary(sovereigntyForSystem(1,null)).text,'主权：待核实');
  const selected=readFileSync(new URL('../app/navigation/selected-system-card.tsx',import.meta.url),'utf8'),hover=readFileSync(new URL('../app/navigation/star-hover-card.ts',import.meta.url),'utf8'),line=readFileSync(new URL('../app/navigation/sovereignty-line.tsx',import.meta.url),'utf8');
  assert.match(selected,/<\/h2><span className="nav-system-security"/);
  assert.match(selected,/<\/span><\/div><SovereigntyLine/);assert.match(hover,/title.append\(warning,name,security\)/);assert.match(hover,/header.append\(ownerLine\)/);
  assert.doesNotMatch(line,/<small|owner.label/);assert.match(line,/owner.icon&&<img/);assert.match(hover,/ownerIcon.hidden=!owner.icon/);assert.match(hover,/ownerIcon.removeAttribute\('src'\)/);
  assert.match(line,/loading="eager"/);assert.match(line,/onError=/);assert.match(hover,/ownerIcon.onload=/);assert.match(hover,/ownerIcon.onerror=/);
  assert.doesNotMatch(selected,/<small>SDE<\/small>|className="nav-selected-windows"/);
  assert.doesNotMatch(hover,/windows.replaceChildren|hint.textContent|\$\{npcStationLabel\(system\)\} · SDE/);
});
test('sovereignty differentiates NPC, player alliance, player corporation, unclaimed and unknown',()=>{
  const env={sovereignty:feed},npc=sovereigntyForSystem(1,env),ally=sovereigntyForSystem(2,env),corp=sovereigntyForSystem(3,env);
  assert.equal(npc.label,'NPC势力');assert.equal(npc.name,'加达里合众国');assert.match(npc.icon,/kind=faction/);
  assert.equal(ally.label,'玩家联盟');assert.equal(ally.name,'晨曦联盟');assert.match(ally.icon,/kind=alliance/);
  assert.equal(corp.label,'玩家军团');assert.match(corp.icon,/kind=player-corporation/);
  assert.equal(sovereigntyForSystem(4,env).kind,'unclaimed');assert.equal(sovereigntyForSystem(5,env).kind,'unknown');assert.equal(sovereigntyForSystem(1,null).kind,'unknown');
  assert.equal(sovereigntyForSystem(1,{sovereignty:{...feed,stale:true}}).stale,true);assert.equal(sovereigntyForSystem(1,{sovereignty:{...feed,names:[]}}).name,'名称待补齐');
});
test('background names use one deduplicated batch per run and preserve previous data on invalid replies',async t=>{
  const dir=mkdtempSync(join(tmpdir(),'sovereignty-')),db=openV2(join(dir,'test.db'));t.after(()=>{db.close();rmSync(dir,{recursive:true,force:true});});
  let calls=0;const sync={db,async request(path,params,options){calls++;assert.equal(path,'/universe/names/');assert.equal(options.retrySafe,true);assert.equal(options.method,'POST');assert.deepEqual(options.body,[500001,98000001,99000001]);return {data:names};}},log={info(){}};
  await syncSovereigntyNames(sync,feed.rows,log);await syncSovereigntyNames(sync,feed.rows,log);assert.equal(calls,2);
  const old=db.prepare("SELECT payload FROM navigation_cache WHERE kind='sovereignty_names'").get().payload;
  sync.request=async()=>({data:[]});await assert.rejects(syncSovereigntyNames(sync,feed.rows,log),/不完整/);assert.equal(db.prepare("SELECT payload FROM navigation_cache WHERE kind='sovereignty_names'").get().payload,old);
});
test('jump and regular selection use smooth focus, same detail card and one shared environment source',()=>{
  const jump=readFileSync(new URL('../app/navigation/jump/page.tsx',import.meta.url),'utf8');assert.match(jump,/const select=useCallback\(\(s:StarSystem\)=>\{setSelected\(s\);setMenu\(null\);controls.current\?\.focus\(s\)/);assert.match(jump,/selected&&!menu&&<SelectedSystemCard/);assert.match(jump,/environment=\{environment\}/);assert.match(jump,/useMapEnvironment\(desktop===true\)/);
});
