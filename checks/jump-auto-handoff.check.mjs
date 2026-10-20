import test from 'node:test';
import assert from 'node:assert/strict';
import {automaticJumpPlan,AutomaticJumpUnreachableError,autoStationIssues,autoRouteIssues} from '../lib/jump-auto-planner.mjs';
import {navigationGraph} from '../lib/navigation.mjs';
import {checkpointProgress,inspectLeg,directDestinationLeg,destinationJumpStatus} from '../lib/jump-planner.mjs';
import {METRES_PER_LIGHTYEAR as LY} from '../lib/star-map.mjs';
const ship={id:28846,groupId:902,baseRange:5,baseFuel:8200,shipFuelBonus:-10};
const s=(id,x)=>({id,nameZh:`S${id}`,nameEn:`S${id}`,regionId:1,security:.2,x:x*LY,y:0,z:0});
function unreachable(graph,options){try{automaticJumpPlan(graph,{origin:1,destination:5,ship,...options});assert.fail('expected unreachable');}catch(e){assert.ok(e instanceof AutomaticJumpUnreachableError,e.message);return e;}}
test('unreachable route retains legal progress to the closest reachable point and no invented gate',()=>{
 const g=navigationGraph({systems:[s(1,0),s(2,9),s(3,18),s(4,100),s(5,109)],gates:[[3,4]]}),e=unreachable(g);
 assert.equal(e.interruptionAt,3);assert.deepEqual(e.legs.map(l=>[l.kind,l.to]),[['jump',2],['jump',3]]);
 assert.ok(e.legs.every(l=>inspectLeg(g,l,ship).issues.length===0));
});
test('handoff maximizes ordered checkpoint progress, including repeated origin visits',()=>{
 const g=navigationGraph({systems:[s(1,0),s(2,9),s(3,18),s(5,109)],gates:[]}),e=unreachable(g,{waypoints:[1,1,2]});
 assert.deepEqual(e.legs.slice(0,2).map(l=>l.to),[2,1]);assert.equal(checkpointProgress(1,e.legs,[1,1,2]).completed,3);assert.equal(e.interruptionAt,3);
});
test('no first jump hands control back at the original A with an empty prefix',()=>{
 const e=unreachable(navigationGraph({systems:[s(1,0),s(5,109)],gates:[[1,5]]}));assert.equal(e.interruptionAt,1);assert.deepEqual(e.legs,[]);
});
test('partial route still enforces station and invasion switches before handing over',()=>{
 const g=navigationGraph({systems:[s(1,0),s(2,9),s(3,18),s(5,109)],gates:[]}),now=Date.now(),incursions={ids:[3],modified:new Date(now).toISOString(),stale:false,error:null},stations={2:[{id:60000002,typeId:1531}]};
 const e=unreachable(g,{npcStationsOnly:true,stations,avoidIncursions:true,incursions,now});assert.equal(e.interruptionAt,2);
 for(const l of e.legs){assert.deepEqual(autoStationIssues(g,l,stations,true),[]);assert.deepEqual(autoRouteIssues(g,l,incursions,true,now),[]);}
});
test('manual continuation can extend an automatic prefix longer than 30 and preserve direct suggestions',()=>{
 const g=navigationGraph({systems:[...Array.from({length:41},(_,i)=>s(i+1,i*9)),s(42,500),s(43,509)],gates:[[41,42]]}),{legs,interruptionAt}=unreachable(g,{destination:43}),plan={origin:1,destination:43,waypoints:[],automatic:false,autoContinuation:true};
 assert.equal(legs.length,40);assert.equal(interruptionAt,41);
 const continued=[...legs,{from:41,to:42,kind:'gate',ids:[41,42]}];assert.equal(directDestinationLeg(g,plan,continued,ship).to,43);assert.equal(destinationJumpStatus(g,plan,continued,ship).kind,'direct');
});
test('input errors and expired invasion feeds never masquerade as a usable partial route',()=>{
 const g=navigationGraph({systems:[s(1,0),s(5,109)],gates:[]});
 for(const options of [{origin:999},{skills:{calibration:6}},{avoidIncursions:true,incursions:null}]){
  assert.throws(()=>automaticJumpPlan(g,{origin:1,destination:5,ship,...options}),e=>!(e instanceof AutomaticJumpUnreachableError));
 }
});
