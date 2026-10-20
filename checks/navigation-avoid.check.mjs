import test from 'node:test';
import assert from 'node:assert/strict';
import {AVOID_STORAGE,DEFAULT_AVOID,parseAvoid,toggleAvoid,avoidPolicy} from '../lib/navigation-avoid.mjs';
import {navigationGraph,calculateNavigation,validateNavigationRequest} from '../lib/navigation.mjs';
import {makePlanLeg,nextPlanActions,inspectLeg,rangeSystems,nearbyLandings,destinationJumpStatus} from '../lib/jump-planner.mjs';
import {METRES_PER_LIGHTYEAR as LY} from '../lib/star-map.mjs';
const graph=navigationGraph({systems:[1,2,3,4].map(id=>({id,nameZh:`星系${id}`,security:.2,regionId:1,x:id*LY,y:0,z:0})),gates:[[1,2],[2,3],[1,4],[4,3]]});
const ship={id:28846,groupId:902,baseRange:5,baseFuel:8200,shipFuelBonus:-10};
test('navigation modes have separate storage and preserve legacy normal blocks only',()=>{
  assert.notEqual(AVOID_STORAGE.regular,AVOID_STORAGE.jump);
  assert.deepEqual(parseAvoid({avoid:[2,2],triglavian:[3],edencom:[4],avoidTriglavian:true,avoidIncursions:true},true),{avoid:[2],avoidList:true,avoidIncursions:true});
  const value=toggleAvoid(DEFAULT_AVOID,2);assert.deepEqual(value.avoid,[2]);assert.deepEqual(DEFAULT_AVOID.avoid,[]);assert.deepEqual(toggleAvoid(value,2).avoid,[]);
  assert.throws(()=>parseAvoid({avoid:[0]}));assert.throws(()=>parseAvoid({avoid:[2],avoidList:'false'}));assert.throws(()=>toggleAvoid({...DEFAULT_AVOID,avoid:Array.from({length:500},(_,i)=>i+1)},501));
});
test('block and incursion switches operate independently, preserve list when off and fail closed on stale invasion data',()=>{
  const now=Date.now(),inc={ids:[3],modified:new Date(now).toISOString(),stale:false,error:null};
  for(const avoidList of [true,false])for(const avoidIncursions of [true,false]){
    const p=avoidPolicy({avoid:[2],avoidList,avoidIncursions},inc,now);assert.equal(p.blocked.has(2),avoidList);assert.equal(p.blocked.has(3),avoidIncursions);assert.equal(p.error,'');
  }
  assert.ok(avoidPolicy({...DEFAULT_AVOID,avoidIncursions:true},{...inc,stale:true},now).error);assert.equal(avoidPolicy(DEFAULT_AVOID,null,now).error,'');
  assert.equal(avoidPolicy({...DEFAULT_AVOID,avoidIncursions:true},{...inc,ids:[]},now).error,'');
});
test('normal routes honor the independently enabled list and do not silently permit blocked endpoints',()=>{
  const run=enabled=>calculateNavigation(graph,validateNavigationRequest({points:[1,3],modes:['shortest'],avoid:enabled?[2]:[]},graph))[0];
  assert.deepEqual(run(true).ids,[1,4,3]);assert.deepEqual(run(false).ids,[1,2,3]);
  assert.throws(()=>calculateNavigation(graph,validateNavigationRequest({points:[1,3],modes:['shortest'],avoid:[3]},graph)),/规避/);
});
test('capital gates avoid blocked intermediate systems; jumps, endpoints and completion never bypass blocks',()=>{
  const blocked=new Set([2]);assert.deepEqual(makePlanLeg(graph,1,3,'gate','shortest',ship,{},blocked).ids,[1,4,3]);
  assert.throws(()=>makePlanLeg(graph,1,2,'jump','shortest',ship,{},blocked),/规避/);
  assert.equal(nextPlanActions(graph,1,2,ship,{},'shortest',blocked).jump.leg,null);assert.equal(nextPlanActions(graph,1,2,ship,{},'shortest',blocked).gate.leg,null);
  assert.ok(inspectLeg(graph,{from:1,to:3,kind:'gate',ids:[1,2,3]},ship,{},blocked).issues.some(s=>s.includes('规避')));
  assert.ok(!rangeSystems(graph,1,10,blocked).some(s=>s.id===2));assert.ok(!nearbyLandings(graph,3,10,blocked).some(s=>s.id===2));
  assert.equal(destinationJumpStatus(graph,{origin:1,destination:2,waypoints:[]},[],ship,{}, {blocked}).leg,null);
  assert.equal(destinationJumpStatus(graph,{origin:1,destination:2,waypoints:[]},[],ship,{}).kind,'direct');
  const supers={...ship,groupId:30};const high=navigationGraph({systems:[{id:1,nameZh:'高安',security:.9,x:0,y:0,z:0},{id:2,nameZh:'低安',security:.2,x:LY,y:0,z:0}],gates:[[1,2]]});assert.throws(()=>makePlanLeg(high,1,2,'gate','shortest',supers,{},new Set()),/不能进入高安/);
});
