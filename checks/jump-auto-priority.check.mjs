import test from 'node:test';
import assert from 'node:assert/strict';
import {automaticJumpPlan} from '../lib/jump-auto-planner.mjs';
import {navigationGraph} from '../lib/navigation.mjs';
import {checkpointProgress,inspectLeg,makePlanLeg,directDestinationLeg,destinationJumpStatus,formatJumpRoute} from '../lib/jump-planner.mjs';
import {METRES_PER_LIGHTYEAR as LY} from '../lib/star-map.mjs';
const ship={id:28846,groupId:902,baseRange:5,baseFuel:8200,shipFuelBonus:-10};
const s=(id,x,security=.2,y=0)=>({id,nameZh:`星系${id}`,nameEn:`S${id}`,regionId:1,security,x:x*LY,y:y*LY,z:0});
const graph=(systems,gates=[])=>navigationGraph({systems,gates});
const run=(g,options={})=>automaticJumpPlan(g,{origin:1,destination:3,ship,...options});
test('automatic routes always use a jump chain instead of a lowsec gate shortcut',()=>{
 const g=graph([s(1,0),s(2,9),s(4,18),s(5,27),s(6,36),s(3,45)],[[1,3]]);
 const legs=run(g);assert.equal(legs.length,5);assert.ok(legs.every(l=>l.kind==='jump'));
});
test('highsec arrival minimizes gates without replacing searched IDs with a manual detour',()=>{
 const g=graph([s(1,0),s(2,9),s(4,18),s(5,100,.9),s(6,200,.9),s(3,300,.9)],[[2,5],[5,6],[6,3],[4,3]]);
 assert.deepEqual(run(g).map(l=>l.ids),[[1,2],[2,4],[4,3]]);
});
test('legacy security preferences cannot enable non-highsec gates or change the fixed policy',()=>{
 const g=graph([s(1,0),s(2,100),s(3,200,.9)],[[1,2],[2,3]]);
 for(const gateMode of ['secure','shortest','insecure'])assert.throws(()=>run(g,{gateMode}),/路径不可达/);
 assert.deepEqual(makePlanLeg(g,1,3,'gate','shortest',ship).ids,[1,2,3]);
});
test('more jumps are allowed to reach a highsec border with fewer final gates',()=>{
 const g=graph([s(1,0),s(2,9),s(4,18),s(5,27),s(6,36),s(7,45),s(8,54),s(9,1000,.9),s(3,1100,.9)],[[1,9],[9,3],[8,3]]);
 const legs=run(g);assert.equal(legs.filter(l=>l.kind==='jump').length,6);assert.equal(legs.reduce((n,l)=>n+inspectLeg(g,l,ship).gates,0),1);
});
test('jump count precedes fuel for otherwise equal legal routes',()=>{
 const g=graph([s(1,0),s(2,6),s(4,12),s(5,9,.2,4),s(3,18)]),legs=run(g);
 assert.deepEqual(legs.map(l=>l.to),[5,3]);assert.ok(legs.reduce((n,l)=>n+inspectLeg(g,l,ship).fuel,0)>inspectLeg(g,makePlanLeg(g,1,2,'jump','shortest',ship),ship).fuel*3);
});
test('automatic plans longer than 30 complete, retain waypoints and remain copyable and extendable',()=>{
 const g=graph(Array.from({length:42},(_,i)=>s(i+1,i*9))),legs=run(g,{destination:41,waypoints:[16,32]});
 assert.equal(legs.length,40);assert.equal(checkpointProgress(1,legs,[16,32]).completed,2);assert.match(formatJumpRoute(g,1,legs),/40\. 旗舰跳/);
 const plan={origin:1,destination:42,waypoints:[16,32],automatic:true};assert.equal(directDestinationLeg(g,plan,legs,ship).to,42);assert.equal(destinationJumpStatus(g,plan,legs,ship).kind,'direct');
 assert.equal(directDestinationLeg(g,{...plan,automatic:false},legs,ship),null);
});
