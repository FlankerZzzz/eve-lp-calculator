import test from 'node:test';
import assert from 'node:assert/strict';
import {automaticJumpPlan,autoRouteIssues,autoStationIssues} from '../lib/jump-auto-planner.mjs';
import {navigationGraph} from '../lib/navigation.mjs';
import {checkpointProgress,inspectLeg,makePlanLeg} from '../lib/jump-planner.mjs';
import {METRES_PER_LIGHTYEAR as LY} from '../lib/star-map.mjs';
const now=Date.parse('2026-10-19T04:00:00Z');
const feed=(ids=[])=>({ids,modified:new Date(now-1000).toISOString(),stale:false,error:null});
const system=(id,x,security=.2,y=0,z=0,regionId=1)=>({id,nameZh:`星系${id}`,nameEn:`S${id}`,regionId,security,x:x*LY,y:y*LY,z:z*LY});
const ship={id:28846,groupId:902,baseRange:5,baseFuel:8200,shipFuelBonus:-10};
const gateShip={...ship,baseRange:.000001};
const graph=(systems,gates=[])=>navigationGraph({systems,gates});
const run=(g,extra={})=>automaticJumpPlan(g,{origin:1,destination:3,ship,now,allowGates:true,...extra});
test('automatic planning ignores station presence and needs no invasion feed with the switch off',()=>{
 const g=graph([system(1,0),system(2,6),system(3,12)]),legs=run(g);
 assert.deepEqual(legs.map(l=>[l.kind,l.to]),[['jump',2],['jump',3]]);
 assert.equal(legs.reduce((n,l)=>n+inspectLeg(g,l,ship,{}).fuel,0),24600);
 assert.deepEqual(run(g,{incursions:feed([2,3])}),legs);assert.deepEqual(run(g,{incursions:{ids:null,stale:true,error:'offline'}}),legs);
});
test('enabled invasion avoidance blocks jump landings, endpoints and waypoints',()=>{
 const g=graph([system(1,0),system(2,6),system(3,12),system(4,8)]);
 assert.deepEqual(run(g,{avoidIncursions:true,incursions:feed([2])}).map(l=>l.to),[4,3]);
 for(const ids of [[1],[3]])assert.throws(()=>run(g,{avoidIncursions:true,incursions:feed(ids)}),/规避/);
 assert.throws(()=>run(g,{waypoints:[2],avoidIncursions:true,incursions:feed([2])}),/规避/);
});
test('invasion avoidance still excludes every legal highsec arrival gate',()=>{
 const g=graph([system(1,0,.9),system(2,100,0),system(3,500,.9),system(4,200,.9),system(5,300,.9)],[[1,2],[2,3],[1,4],[4,5],[5,3]]);
 for(const gateMode of ['shortest','secure','insecure']){
  assert.deepEqual(run(g,{gateMode})[0].ids,[1,4,5,3]);
  assert.deepEqual(run(g,{gateMode,avoidIncursions:true,incursions:feed([2])})[0].ids,[1,4,5,3]);
  assert.throws(()=>run(g,{gateMode,avoidIncursions:true,incursions:feed([4])}),/路径不可达/);
  assert.throws(()=>run(g,{gateMode,avoidIncursions:true,incursions:feed([2,4])}),/路径不可达/);
 }
});
test('fresh invasion data is required only while enabled and revalidation includes every gate system',()=>{
 const g=graph([system(1,0),system(2,6),system(3,12)],[[1,2],[2,3]]),leg={from:1,to:3,kind:'gate',ids:[1,2,3]};
 const bad=[null,{ids:[]},{...feed(),ids:null},{...feed(),ids:[NaN]},{...feed(),stale:true},{...feed(),error:'offline'},{...feed(),modified:new Date(now-80*60000).toISOString()},{...feed(),fresh_until:new Date(now-1).toISOString()}];
 for(const incursions of bad){assert.throws(()=>run(g,{avoidIncursions:true,incursions}),/入侵名单/);assert.ok(run(g,{incursions}).length);}
 assert.deepEqual(autoRouteIssues(g,leg,null,false,now),[]);assert.match(autoRouteIssues(g,leg,feed([2]),true,now).join('；'),/星系2/);
 assert.match(autoRouteIssues(g,{...leg,kind:'jump',ids:[1,3]},feed([3]),true,now).join('；'),/星系3/);
 assert.match(autoRouteIssues(g,leg,null,true,now).join('；'),/入侵名单/);assert.deepEqual(autoRouteIssues(g,leg,feed(),true,now),[]);
});
test('highsec targets require gates while stationless lowsec targets allow jumps',()=>{
 const g=graph([system(1,0,.9),system(2,9),system(3,12,.9),system(4,10)],[[2,4],[4,3]]),legs=run(g,{waypoints:[4]});
 assert.deepEqual(legs.map(l=>[l.kind,l.to]),[['jump',4],['gate',3]]);assert.equal(checkpointProgress(1,legs,[4]).remaining.length,0);
});
test('ordered repeated checkpoints and gate cycles retain actual revisit semantics',()=>{
 const g=graph([system(1,0),system(2,5),system(3,9)],[[1,2],[2,3]]),legs=run(g,{waypoints:[2,1,2]});
 assert.deepEqual(legs.map(l=>l.to),[2,1,2,3]);assert.equal(checkpointProgress(1,legs,[2,1,2]).completed,3);
 const gateGraph=graph([system(1,0,.9),system(2,5,.9),system(3,9,.9)],[[1,2],[2,3]]);
 assert.deepEqual(run(gateGraph,{ship:gateShip,waypoints:[2]}).map(l=>l.ids),[[1,2],[2,3]]);
 assert.deepEqual(run(gateGraph,{ship:gateShip,destination:1,waypoints:[1,1],maxLegs:2}).map(l=>l.ids),[[1,2],[2,1]]);
 assert.deepEqual(run(gateGraph,{ship:gateShip,destination:1,waypoints:[1,1],maxLegs:1}).map(l=>l.ids),[[1,2],[2,1]]);
 assert.deepEqual(run(g,{waypoints:[3]}).map(l=>l.to),[3]);assert.deepEqual(run(g,{destination:1}),[]);
});
test('repeated origin on a long jump-only route retains every required visit and station checks',()=>{
 const systems=Array.from({length:34},(_,i)=>system(i+1,i*9)),g=graph(systems);
 const stations=Object.fromEntries(systems.map(s=>[s.id,[{id:60000000+s.id,typeId:1531}]])),options={origin:1,destination:34,waypoints:[1,1],ship,stations,npcStationsOnly:true,incursions:feed(),avoidIncursions:true,now,maxLegs:30};
 const legs=automaticJumpPlan(g,options);assert.equal(legs.length,35);assert.deepEqual(legs.slice(0,2).map(l=>l.to),[2,1]);assert.equal(checkpointProgress(1,legs,[1,1]).remaining.length,0);
 for(const leg of legs){assert.deepEqual(inspectLeg(g,leg,ship,{}).issues,[]);assert.deepEqual(autoRouteIssues(g,leg,options.incursions,true,now),[]);assert.deepEqual(autoStationIssues(g,leg,stations,true),[]);}
 assert.deepEqual(automaticJumpPlan(g,{...options,maxLegs:29}),legs,'obsolete caller limits cannot truncate automatic routes');
});
test('repeated gate-only visits consume real nonzero legs without premature departure splits',()=>{
 const g=graph([system(1,0,.9),system(2,100,.9),system(3,200,.9)],[[1,2],[2,3]]);
 for(const gateMode of ['shortest','secure','insecure']){
  const legs=run(g,{ship:gateShip,destination:1,waypoints:[1,1,1],gateMode,maxLegs:4});
  assert.equal(legs.length,4);assert.equal(checkpointProgress(1,legs,[1,1,1]).completed,3);assert.ok(legs.every(l=>l.from!==l.to));
  assert.deepEqual(run(g,{ship:gateShip,destination:1,waypoints:[1,1,1],gateMode,maxLegs:3}),legs);
 }
});
test('range, 3D distance, Pochven, hull highsec restrictions and block lists still apply',()=>{
 for(const [s,works] of [[system(3,10),true],[system(3,6,.2,8),true],[system(3,10.000001),false],[system(3,3,.2,0,0,10000070),false]]){const g=graph([system(1,0),s]);if(works)assert.equal(run(g)[0].to,3);else assert.throws(()=>run(g),/路径不可达/);}
 const g=graph([system(1,0),system(2,20,.9),system(3,40),system(4,60),system(5,80)],[[1,2],[2,3],[1,4],[4,5],[5,3]]),restricted={...ship,id:671,groupId:30};
 assert.throws(()=>run(g,{ship:restricted}),/路径不可达/,'restricted hull cannot use highsec, and lowsec transit gates are now forbidden');assert.deepEqual(makePlanLeg(g,1,3,'gate','shortest',restricted).ids,[1,4,5,3],'manual hull-legal gate routes remain available');assert.throws(()=>run(g,{ship:restricted,origin:2}),/不能进入高安/);
 assert.throws(()=>run(g,{ship:restricted,blocked:new Set([4])}),/路径不可达/);assert.throws(()=>run(g,{blocked:new Set([3])}),/规避/);
});
test('automatic routes exceed 30 legs while malformed inputs still fail',()=>{
 const g=graph(Array.from({length:32},(_,i)=>system(i+1,i*9)));
 assert.equal(run(g,{destination:31}).length,30);assert.equal(run(g,{destination:32}).length,31);assert.equal(run(g,{destination:32,maxLegs:1}).length,31);
 for(const extra of [{ship:null},{destination:999},{avoidIncursions:'yes'},{waypoints:Array(11).fill(2)},{skills:{shipSkill:6}}])assert.throws(()=>run(g,extra));
});
test('automatic search is deterministic and lower fuel breaks equal gate/jump-count ties',()=>{
 const g=graph([system(1,0),system(2,7,.2,4),system(3,14),system(4,7)]),legs=run(g);assert.deepEqual(legs.map(l=>l.to),[4,3]);assert.deepEqual(run(g),legs);
});
test('automatic search retains its explicit time budget',t=>{
 let calls=0;t.mock.method(performance,'now',()=>calls++===0?0:3000);assert.throws(()=>run(graph([system(1,0),system(3,6)])),/搜索范围过大.*减少途经点或分段规划/);
});
test('optional NPC button only restricts jump landings, independently of invasion avoidance',()=>{
 const g=graph([system(1,0),system(2,6),system(3,12),{...system(4,7),y:LY},system(5,100,.9)],[[1,2],[2,3],[1,4],[4,3],[1,5],[5,3]]);
 const stations={3:[{id:60000003,typeId:1531}],4:[{id:60000004,typeId:1531}]};
 assert.deepEqual(run(g,{stations}).map(l=>l.to),[2,3]);
 assert.deepEqual(run(g,{stations,npcStationsOnly:true}).map(l=>l.to),[4,3]);
 assert.deepEqual(run(g,{stations,npcStationsOnly:true,incursions:feed([4])}).map(l=>l.to),[4,3]);
 assert.throws(()=>run(g,{stations,npcStationsOnly:true,avoidIncursions:true,incursions:feed([4])}),/路径不可达/);
 const gate={from:1,to:3,kind:'gate',ids:[1,2,3]},jump={from:1,to:2,kind:'jump',ids:[1,2]};
 assert.deepEqual(autoStationIssues(g,gate,{},true),[]);assert.deepEqual(autoStationIssues(g,jump,{},false),[]);
 assert.match(autoStationIssues(g,jump,{},true).join('；'),/NPC 空间站/);
 assert.match(autoStationIssues(g,jump,{2:[{id:1}]},true).join('；'),/NPC 空间站/);
 assert.throws(()=>run(g,{stations:{},npcStationsOnly:true}),/路径不可达/);
 assert.throws(()=>run(g,{npcStationsOnly:'yes'}),/开关/);
});
