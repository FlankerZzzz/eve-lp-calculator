import test from 'node:test';
import assert from 'node:assert/strict';
import {Worker} from 'node:worker_threads';
import {DatabaseSync} from 'node:sqlite';
import {mkdtempSync,rmSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {JumpComputePool} from '../lib/jump-compute-pool.mjs';
import {createJumpComputation} from '../lib/jump-compute-snapshot.mjs';
import {normalizeJumpRequest} from '../lib/jump-auto-request.mjs';
import {readNavigationCaches} from '../lib/navigation-store.mjs';
const LY=9460000000000000;
const input=()=>normalizeJumpRequest({origin:1,destination:3,shipId:28846,waypoints:[],skills:{calibration:5,conservation:5,shipSkill:5},avoid:{avoid:[],avoidList:true,avoidIncursions:true}});
function rows(){
 const now=new Date().toISOString(),systems=[0,9,18].map((x,i)=>({id:i+1,nameZh:`星系${i+1}`,nameEn:`S${i+1}`,regionId:1,regionName:'测试星域',security:.2,x:x*LY,y:0,z:0}));
 const map={schema:1,systems,gates:[]},jump={schema:1,stationSource:'SDE',shipsVerifiedAt:now,ships:[{id:28846,name:'游牧者级',group:'战略货舰',groupId:902,fuelId:17889,fuelName:'氢同位素',baseRange:5,baseFuel:8200,shipFuelBonus:-10}],stations:{2:[{id:60000002,typeId:1}],3:[{id:60000003,typeId:1}]}};
 return Object.fromEntries(Object.entries({map,jump,incursions:[]}).map(([kind,payload])=>[kind,{kind,payload:JSON.stringify(payload),version:`${kind}-1`,fetched:now,modified:now,error:null}]));
}
const who=n=>({source:`source-${n}`,owner:`owner-${n}`,requestId:`request-${n}`});
test('worker snapshot cache uses both map and ship/station versions; changed data is not reused',()=>{
 let current=rows();const compute=createJumpComputation({read:()=>current});
 const first=compute(input());assert.equal(first.status,200);assert.deepEqual(first.body.legs.map(l=>l.to),[2,3]);assert.deepEqual(compute(input()).body.legs,first.body.legs);
 const stationOnly={...input(),npcStationsOnly:true};assert.equal(compute(stationOnly).body.complete,true);
 const jump=JSON.parse(current.jump.payload);jump.stations={};current.jump={...current.jump,version:'jump-2',payload:JSON.stringify(jump)};assert.equal(compute(stationOnly).body.complete,false);
 current=rows();const map=JSON.parse(current.map.payload);map.systems[2].x=100*LY;current.map={...current.map,version:'map-2',payload:JSON.stringify(map)};assert.equal(compute(input()).body.complete,false);
});
test('each task reads current invasion errors, expiry and IDs even when the graph is cached',()=>{
 const current=rows(),compute=createJumpComputation({read:()=>current});assert.equal(compute(input()).body.complete,true);
 current.incursions={...current.incursions,version:'inc-2',payload:JSON.stringify([{infested_solar_systems:[2]}])};assert.equal(compute(input()).body.complete,false);
 current.incursions.error='offline';assert.equal(compute(input()).status,400);assert.equal(compute({...input(),avoid:{...input().avoid,avoidIncursions:false}}).body.complete,true);
 current.incursions.error=null;current.incursions.fetched=new Date(Date.now()-76*60000).toISOString();assert.equal(compute(input()).status,400);
});
test('snapshot change or data failure during computation rejects the result instead of publishing stale safety decisions',()=>{
 const current=rows();let reads=0;const compute=createJumpComputation({read:()=>{reads++;return reads>1?{...current,incursions:{...current.incursions,error:'new error'}}:current;}});
 const result=compute(input());assert.equal(result.status,503);assert.equal(result.body.code,'JUMP_SNAPSHOT_CHANGED');assert.equal(result.body.legs,undefined);
 const unavailable=createJumpComputation({read:()=>{throw new Error('/private/database/path');}});const error=unavailable(input());assert.equal(error.status,503);assert.ok(!JSON.stringify(error).includes('/private'));
 const malformed=createJumpComputation({read:()=>({...current,jump:{...current.jump,payload:'broken'}})});assert.equal(malformed(input()).status,503);
});
test('fresh-at-start invasion data expiring during work is not returned as current',t=>{
 const current=rows(),begin=Date.parse(current.incursions.fetched);let reads=0;t.mock.method(Date,'now',()=>begin+(reads>1?76*60000:0));
 const compute=createJumpComputation({read:()=>{reads++;return current;}}),result=compute(input());assert.equal(result.status,400);assert.match(result.body.error,/入侵名单/);
});
test('real CPU worker leaves the HTTP thread event loop responsive and cancellation stops the work',async t=>{
 let started;const workers=[],pool=new JumpComputePool({size:1,createWorker:()=>{const worker=new Worker(new URL('./fixtures/jump-compute-test-worker.mjs',import.meta.url));workers.push(worker);worker.on('message',m=>{if(m.type==='started')started?.();});return worker;}});t.after(()=>pool.close());
 const began=new Promise(resolve=>{started=resolve;}),abort=new AbortController(),slow=pool.submit('slow',{spinMs:800,value:1},{...who(1),signal:abort.signal});slow.catch(()=>{});await began;
 let finished=false;slow.finally(()=>{finished=true;}).catch(()=>{});await new Promise(resolve=>setTimeout(resolve,20));assert.equal(finished,false,'main-thread timer runs while CPU task is still active');
 abort.abort();await assert.rejects(slow,e=>e.code==='JUMP_CANCELLED');
 const fast=await pool.submit('fast',{value:2},who(2));assert.equal(fast.body.value,2);assert.ok(fast.body.threadId>0);assert.equal(workers.length,2);
});
test('actual worker crash rejects its task and replacement processes the next task',async t=>{
 const pool=new JumpComputePool({size:1,createWorker:()=>new Worker(new URL('./fixtures/jump-compute-test-worker.mjs',import.meta.url))});t.after(()=>pool.close());
 await assert.rejects(pool.submit('crash',{crash:true},who(1)),e=>e.code==='JUMP_WORKER_FAILED');const next=await pool.submit('next',{value:3},who(2));assert.equal(next.body.value,3);
});
test('production worker computes from a real read-only database and observes later snapshot versions',async t=>{
 const dir=mkdtempSync(join(tmpdir(),'jump-worker-')),filename=join(dir,'fixture.db'),db=new DatabaseSync(filename);t.after(()=>{db.close();rmSync(dir,{recursive:true,force:true});});
 db.exec('CREATE TABLE navigation_cache(kind TEXT PRIMARY KEY,payload TEXT,version TEXT,fetched TEXT,modified TEXT,error TEXT)');
 const current=rows(),insert=db.prepare('INSERT INTO navigation_cache(kind,payload,version,fetched,modified,error) VALUES(?,?,?,?,?,?)');for(const r of Object.values(current))insert.run(r.kind,r.payload,r.version,r.fetched,r.modified,r.error);
 const snapshot=readNavigationCaches(['map','jump','incursions'],filename);assert.deepEqual(JSON.parse(JSON.stringify(snapshot)),current);
 const pool=new JumpComputePool({size:2,createWorker:()=>new Worker(new URL('../lib/jump-compute-worker.mjs',import.meta.url),{workerData:{filename}})});t.after(()=>pool.close());
 const result=await pool.submit('first',input(),who(1));assert.equal(result.status,200);assert.equal(result.body.complete,true);assert.deepEqual(result.body.legs.map(l=>l.to),[2,3]);
 db.prepare("UPDATE navigation_cache SET payload=?,version='inc-2' WHERE kind='incursions'").run(JSON.stringify([{infested_solar_systems:[2]}]));
 const updated=await pool.submit('second',input(),who(2));assert.equal(updated.body.complete,false);assert.equal(updated.body.interruptionAt,1);
});
test('compute route has no synchronous solver or catalog construction; both gateway configs bound the compute endpoint',()=>{
 const route=readFileSync(new URL('../app/api/navigation/jump/auto/route.ts',import.meta.url),'utf8'),service=readFileSync(new URL('../lib/jump-compute-service.mjs',import.meta.url),'utf8'),page=readFileSync(new URL('../app/navigation/jump/page.tsx',import.meta.url),'utf8');
 assert.doesNotMatch(route,/automaticJumpPlan|navigationGraph|jumpCatalog|navigationFeed/);assert.match(route,/jumpComputeService.calculate/);assert.match(route,/retry-after/);assert.match(service,/new Worker\(/);assert.match(service,/maxOldGenerationSizeMb:384/);
 const nginx=readFileSync(new URL('../nginx/nginx.conf',import.meta.url),'utf8');assert.match(nginx,/location = \/api\/navigation\/jump\/auto/);assert.match(nginx,/client_max_body_size 16k/);assert.match(nginx,/limit_req_status 429/);assert.match(nginx,/POST \$binary_remote_addr/);assert.match(nginx,/X-Real-IP/);
 assert.match(page,/if\(autoRequest.current\|\|retryDelay>0\)return/);assert.match(page,/jump\/cancel',\{method:'DELETE'/);assert.match(page,/keepalive:true/);assert.match(page,/取消计算/);assert.match(page,/r.status===429/);assert.match(page,/autoRequest.current===abort/);assert.match(page,/addEventListener\('pagehide',cancelAutomatic\)/);assert.match(page,/removeEventListener\('pagehide',cancelAutomatic\)/);
});
