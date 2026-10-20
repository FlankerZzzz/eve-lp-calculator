import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import ts from 'typescript';
import {METRES_PER_LIGHTYEAR as LY} from '../lib/star-map.mjs';
import {inspectLeg} from '../lib/jump-planner.mjs';
import {navigationGraph} from '../lib/navigation.mjs';

const ship={id:28846,groupId:902,baseRange:5,baseFuel:8200,shipFuelBonus:-10};
const system=(id,x,security=.2)=>({id,nameZh:`星系${id}`,nameEn:`S${id}`,regionId:1,security,x:x*LY,y:0,z:0});
const stations=(...ids)=>Object.fromEntries(ids.map(id=>[id,[{id:60000000+id,typeId:1531}]]));
const fresh=(ids=[])=>({rows:ids.length?[{infested_solar_systems:ids}]:[],modified:new Date().toISOString(),fetched:new Date().toISOString(),fresh_until:new Date(Date.now()+60000).toISOString(),stale:false,error:null});
const payload=()=>({origin:1,destination:3,waypoints:[],shipId:ship.id,skills:{calibration:5,conservation:5,shipSkill:5},gateMode:'shortest',avoid:{avoid:[],avoidList:true,avoidIncursions:false}});
const moduleUrl=source=>`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`;
async function partial(response){assert.equal(response.status,200);const body=await response.json();assert.equal(body.complete,false);assert.ok(Array.isArray(body.legs));assert.equal(body.interruptionAt,body.legs.at(-1)?.to??1);assert.match(body.message,/路径不可达，请自行规划/);return body;}

// Exercise the real POST handler and engine through the compute-service seam.
// Pool admission and real worker isolation have dedicated integration checks.
async function fixture(t){
  const slot=`jump-auto-api-${crypto.randomUUID()}`,state={
    catalog:{ships:[ship],systems:[system(1,0),system(2,6),system(3,12)],gates:[[1,2],[2,3]],stations:stations(2,3)},
    catalogStatus:200,catalogCalls:0,feed:fresh(),feedCalls:[],
  };
  globalThis[slot]=state;t.after(()=>delete globalThis[slot]);
  const sourceUrl=new URL('../app/api/navigation/jump/auto/route.ts',import.meta.url);
  const output=ts.transpileModule(readFileSync(sourceUrl,'utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ESNext}}).outputText;
  const wired=output.replace(/from (["'])(\.\.?\/[^"']+)\1/g,(_,quote,spec)=>{
    let target;
    if(spec.endsWith('/lib/jump-compute-service.mjs'))target=moduleUrl(`
      export {readJumpRequestBody} from ${JSON.stringify(new URL('../lib/jump-compute-service.mjs',import.meta.url).href)};
      import {calculateJumpRequest} from ${JSON.stringify(new URL('../lib/jump-auto-request.mjs',import.meta.url).href)};
      import {navigationGraph} from ${JSON.stringify(new URL('../lib/navigation.mjs',import.meta.url).href)};
      export const jumpComputeService={admit(){return {source:'fixture',owner:'fixture',requestId:'fixture'};},async calculate(input){
        const state=globalThis[${JSON.stringify(slot)}];state.catalogCalls++;
        if(state.catalogStatus!==200)return {status:503,body:{error:'跳跃基础资料不可用，请重新加载后计算。'}};
        if(!state.catalog.ships.some(s=>s.id===input.shipId))return {status:400,body:{error:'请选择有效舰船'}};
        state.feedCalls.push('incursions');return calculateJumpRequest({catalog:state.catalog,graph:navigationGraph(state.catalog),feed:state.feed},input);
      }};
    `);
    else target=new URL(spec.endsWith('.mjs')?spec:`${spec}.ts`,sourceUrl).href;
    return `from ${JSON.stringify(target)}`;
  });
  const api=await import(moduleUrl(wired));
  const post=(body=payload())=>api.POST(new Request('http://localhost/api/navigation/jump/auto',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)}));
  return {state,post,raw:body=>api.POST(new Request('http://localhost/api/navigation/jump/auto',{method:'POST',body}))};
}

test('automatic jump API rejects malformed IDs, waypoint limits and skills before loading data',async t=>{
  const {state,post,raw}=await fixture(t);
  const bad=[null,[],{},...[
    {origin:'1'},{destination:0},{shipId:1.5},{waypoints:null},{waypoints:Array(11).fill(2)},{waypoints:[NaN]},
    {skills:null},{skills:{calibration:6,conservation:5,shipSkill:5}},
    {skills:{calibration:5,conservation:'5',shipSkill:5}},{skills:{calibration:5,conservation:5}},
  ].map(change=>({...payload(),...change}))];
  for(const body of bad){const response=await post(body);assert.equal(response.status,400);assert.equal(response.headers.get('cache-control'),'no-store');assert.ok((await response.json()).error);}
  assert.equal((await raw('{not JSON')).status,400);
  assert.equal(state.catalogCalls,0);assert.deepEqual(state.feedCalls,[]);
});

test('automatic jump API returns unavailable catalog as 503 without treating it as an empty map',async t=>{
  const {state,post}=await fixture(t);state.catalogStatus=503;state.catalog={error:'fixture unavailable'};
  const response=await post();assert.equal(response.status,503);assert.match((await response.json()).error,/基础资料不可用/);
  assert.equal(response.headers.get('cache-control'),'no-store');assert.deepEqual(state.feedCalls,[]);
});

test('automatic jump API requires a current invasion feed only when its button is enabled',async t=>{
  const {state,post}=await fixture(t);
  for(const feed of [
    {...fresh(),rows:null},{...fresh(),stale:true},{...fresh(),error:'fixture offline'},
    {...fresh(),fresh_until:new Date(Date.now()-1000).toISOString()},
    {rows:[],modified:null,fetched:null,fresh_until:null,stale:false,error:null},
  ]){
    state.feed=feed;assert.equal((await post()).status,200);const response=await post({...payload(),avoid:{...payload().avoid,avoidIncursions:true}});assert.equal(response.status,400);assert.match((await response.json()).error,/入侵名单/);
  }
  assert.ok(state.feedCalls.every(kind=>kind==='incursions'));
});

test('automatic jump API ignores stations and applies the invasion button to all visited systems',async t=>{
  const {state,post}=await fixture(t);state.catalog.stations={};const response=await post();assert.equal(response.status,200);assert.equal(response.headers.get('cache-control'),'no-store');
  const body=await response.json();assert.deepEqual(body.incursions.ids,[]);
  assert.deepEqual(body.legs.map(l=>[l.kind,l.from,l.to]),[['jump',1,2],['jump',2,3]]);
  const graph=navigationGraph(state.catalog);
  for(const leg of body.legs)assert.deepEqual(inspectLeg(graph,leg,ship,payload().skills).issues,[]);
  assert.deepEqual(state.feedCalls,['incursions']);
  state.feed=fresh([2]);const invaded=await (await post()).json();
  assert.equal(invaded.legs.some(l=>l.kind==='jump'&&l.to===2),true);
  await partial(await post({...payload(),avoid:{...payload().avoid,avoidIncursions:true}}));
  state.catalog.systems.push(system(4,8));const bypass=await (await post({...payload(),avoid:{...payload().avoid,avoidIncursions:true}})).json();assert.deepEqual(bypass.legs.map(l=>l.to),[4,3]);
});

test('automatic jump API trusts server range and invasion data rather than client substitutes',async t=>{
  const {state,post}=await fixture(t);
  assert.equal((await post({...payload(),shipId:999,ship:{...ship,id:999,baseRange:1000}})).status,400);
  state.catalog.gates=[];state.catalog.stations=stations(3);
  const response=await post({...payload(),skills:{...payload().skills,calibration:0},ship:{...ship,baseRange:1000},range:1000,distance:0,stations:stations(2,3),incursions:{ids:[]}});
  await partial(response);
  state.catalog.stations=stations(2,3);state.feed=fresh([2]);
  const invaded=await post({...payload(),avoid:{...payload().avoid,avoidIncursions:true},incursions:{ids:[],stale:false},stations:stations(2,3)});
  await partial(invaded);
});

test('automatic jump API validates actual point membership and respects enabled versus disabled block lists',async t=>{
  const {post}=await fixture(t);
  const unknown=await post({...payload(),destination:999});assert.equal(unknown.status,400);assert.match((await unknown.json()).error,/有效星系/);
  for(const avoid of [null,{avoid:[],avoidList:'yes'}, {avoid:[0]}, {avoid:Array(501).fill(2)}])assert.equal((await post({...payload(),avoid})).status,400);
  const enabled=await post({...payload(),avoid:{avoid:[2],avoidList:true,avoidIncursions:false}});await partial(enabled);
  const disabled=await post({...payload(),avoid:{avoid:[2],avoidList:false,avoidIncursions:false}});assert.equal(disabled.status,200);
});

test('automatic jump API enforces final highsec gates regardless of legacy preference or gate overrides',async t=>{
  const {state,post}=await fixture(t);
  state.catalog={ships:[ship],systems:[system(1,0,.9),system(2,100),system(3,500,.9),system(4,200,.9),system(5,300,.9)],gates:[[1,2],[2,3],[1,4],[4,5],[5,3]],stations:{}};
  for(const [gateMode,ids] of [['shortest',[1,4,5,3]],['secure',[1,4,5,3]],['insecure',[1,4,5,3]]]){
    const response=await post({...payload(),gateMode,allowGates:true});assert.equal(response.status,200);const body=await response.json();
    assert.deepEqual(body.legs,[{from:1,to:3,kind:'gate',ids}]);
  }
  state.catalog.gates=[[1,2],[2,3],[1,4],[4,3]];
  for(const [gateMode,ids] of [['secure',[1,4,3]],['insecure',[1,4,3]]]){
    const response=await post({...payload(),gateMode,allowGates:true});assert.equal(response.status,200);assert.deepEqual((await response.json()).legs[0].ids,ids);
  }
  state.catalog.systems.find(s=>s.id===3).security=.2;
  for(const allowGates of [false,true])await partial(await post({...payload(),allowGates,gateMode:'insecure'}));
});
test('automatic jump API returns complete routes exceeding 30 legs',async t=>{
 const {state,post}=await fixture(t);
 state.catalog={ships:[ship],systems:Array.from({length:41},(_,i)=>system(i+1,i*9)),gates:[],stations:{}};
 const response=await post({...payload(),destination:41,waypoints:[16,32],maxLegs:30});assert.equal(response.status,200);
 const {legs}=await response.json();assert.equal(legs.length,40);assert.equal(legs.at(-1).to,41);assert.ok(legs.every(l=>l.kind==='jump'));
});
test('NPC station option uses server station data and leaves gate intermediates unrestricted',async t=>{
 const {state,post}=await fixture(t);state.catalog.stations=stations(3);state.catalog.systems.push(system(4,100,.9));state.catalog.gates.push([1,4],[4,3]);
 assert.equal((await post({...payload(),npcStationsOnly:'true'})).status,400);
 const normal=await (await post()).json();assert.deepEqual(normal.legs.map(l=>l.kind),['jump','jump']);
 state.catalog.systems.find(s=>s.id===3).security=.9;
 const limited=await (await post({...payload(),npcStationsOnly:true,allowGates:true})).json();assert.equal(limited.legs[0].kind,'gate');assert.ok(limited.legs[0].ids.includes(4));
 state.catalog.gates=[];
 const missing=await post({...payload(),npcStationsOnly:true,stations:stations(2,3)});await partial(missing);
 state.catalog.systems.find(s=>s.id===3).security=.2;assert.equal((await post({...payload(),npcStationsOnly:false})).status,200);
});
test('API returns the reachable prefix and explicit interruption point, never marks it complete',async t=>{
 const {state,post}=await fixture(t);state.catalog={ships:[ship],systems:[system(1,0),system(2,9),system(3,100)],gates:[[2,3]],stations:stations(2,3)};
 const body=await partial(await post());assert.equal(body.interruptionAt,2);assert.deepEqual(body.legs.map(l=>l.to),[2]);
});

test('API joins two-point segments in checkpoint order and retains earlier segments on later interruption',async t=>{
 const {state,post}=await fixture(t);
 state.catalog={ships:[ship],systems:[system(1,0),system(2,9),system(3,27),system(4,18)],gates:[],stations:stations(2,3,4)};
 const response=await post({...payload(),waypoints:[2],npcStationsOnly:true});assert.equal(response.status,200);
 const body=await response.json();assert.equal(body.complete,true);assert.deepEqual(body.legs.map(l=>l.to),[2,4,3]);
 state.catalog.systems.find(s=>s.id===3).x=100*LY;
 const interrupted=await partial(await post({...payload(),waypoints:[2],npcStationsOnly:true}));
 assert.deepEqual(interrupted.legs.map(l=>l.to),[2,4]);assert.equal(interrupted.interruptionAt,4);
});

test('API reaches an explicit highsec checkpoint through a lowsec border then legally jumps to the next stop',async t=>{
 const {state,post}=await fixture(t);
 state.catalog={ships:[ship],systems:[system(1,0,-.2),system(2,9),system(3,109),system(4,100,.9)],gates:[[1,4],[2,4]],stations:stations(2,3)};
 const response=await post({...payload(),waypoints:[4],npcStationsOnly:true});assert.equal(response.status,200);
 const body=await response.json();assert.equal(body.complete,true);assert.deepEqual(body.legs.map(l=>[l.kind,l.from,l.to]),[['jump',1,2],['gate',2,4],['jump',4,3]]);
 state.catalog.ships.push({...ship,id:671,groupId:30});const restricted=await post({...payload(),shipId:671,waypoints:[4]});assert.equal(restricted.status,400);assert.match((await restricted.json()).error,/不能进入高安/);
 state.feed=fresh([4]);const invaded=await post({...payload(),waypoints:[4],avoid:{...payload().avoid,avoidIncursions:true}});assert.equal(invaded.status,400);assert.match((await invaded.json()).error,/规避/);
});
