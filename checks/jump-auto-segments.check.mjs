import test from 'node:test';
import assert from 'node:assert/strict';
import {automaticJumpPlan,AutomaticJumpUnreachableError,autoGateIssues} from '../lib/jump-auto-planner.mjs';
import {checkpointProgress,inspectLeg} from '../lib/jump-planner.mjs';
import {navigationGraph} from '../lib/navigation.mjs';
import {METRES_PER_LIGHTYEAR as LY} from '../lib/star-map.mjs';

const ship={id:28846,groupId:902,baseRange:5,baseFuel:8200,shipFuelBonus:-10};
const s=(id,x,security=.2)=>({id,nameZh:`S${id}`,nameEn:`S${id}`,regionId:1,security,x:x*LY,y:0,z:0});
const graph=(systems,gates=[])=>navigationGraph({systems,gates});
const run=(g,origin,destination,waypoints=[],options={})=>automaticJumpPlan(g,{origin,destination,waypoints,ship,...options});

test('three-point route equals two independent legal two-point routes in order',()=>{
  const g=graph(Array.from({length:7},(_,i)=>s(i+1,i*9)));
  const expected=[...run(g,1,4),...run(g,4,7)],legs=run(g,1,7,[4]);
  assert.deepEqual(legs,expected);
  assert.equal(checkpointProgress(1,legs,[4]).remaining.length,0);
  for(const leg of legs)assert.deepEqual(inspectLeg(g,leg,ship).issues,[]);
});

test('each two-point search gets its own bounded time budget instead of sharing a multi-point deadline',t=>{
  let calls=0;t.mock.method(performance,'now',()=>1200*calls++);
  const g=graph([s(1,0),s(2,9),s(3,18),s(4,27)]);
  assert.deepEqual(run(g,1,4,[2,3]).map(leg=>leg.to),[2,3,4]);
  assert.equal(calls,6,'one start and one budget check for each of the three short searches');
});

test('a budget failure in a later segment is an explicit error, never a fake unreachable prefix',t=>{
  const times=[0,1000,1500,4000];t.mock.method(performance,'now',()=>times.shift()??5000);
  const g=graph([s(1,0),s(2,9),s(3,18)]);
  assert.throws(()=>run(g,1,3,[2]),e=>!(e instanceof AutomaticJumpUnreachableError)&&/搜索范围过大/.test(e.message));
});

test('later unreachable segment retains completed checkpoints and the reachable part of the failing segment',()=>{
  const g=graph([s(1,0),s(2,9),s(3,18),s(4,100)]);
  assert.throws(()=>run(g,1,4,[2]),e=>{
    assert.ok(e instanceof AutomaticJumpUnreachableError);
    assert.deepEqual(e.legs.map(leg=>leg.to),[2,3]);assert.equal(e.interruptionAt,3);
    assert.equal(checkpointProgress(1,e.legs,[2]).completed,1);return true;
  });
  assert.throws(()=>run(g,1,2,[4]),e=>e instanceof AutomaticJumpUnreachableError&&checkpointProgress(1,e.legs,[4]).completed===0);
});

test('only an explicit ordered highsec stop allows a later jump; incidental highsec transit remains forbidden',()=>{
  const g=graph([s(1,0),s(2,100,.9),s(3,109)],[[1,2]]);
  assert.equal(run(g,1,2)[0].kind,'gate');assert.equal(run(g,2,3)[0].kind,'jump');
  assert.throws(()=>run(g,1,3),e=>e instanceof AutomaticJumpUnreachableError);
  const legs=run(g,1,3,[2]);assert.deepEqual(legs.map(l=>l.kind),['gate','jump']);
  assert.deepEqual(autoGateIssues(g,legs,3,[2],1),[]);assert.ok(autoGateIssues(g,legs,3).length);
});

test('repeated checkpoints still require revisits and the final highsec suffix may contain ordered highsec stops',()=>{
  const g=graph([s(1,0),s(2,9),s(3,18),s(4,100,.9),s(5,200,.9)],[[3,4],[4,5]]);
  const legs=run(g,1,5,[1,1,2,3,4]);
  assert.deepEqual(legs.slice(0,3).map(leg=>leg.to),[2,1,2]);
  assert.equal(checkpointProgress(1,legs,[1,1,2,3,4]).remaining.length,0);
  assert.deepEqual(legs.slice(-2).map(leg=>leg.ids),[[3,4],[4,5]]);
  assert.deepEqual(autoGateIssues(g,legs,5),[]);
});
