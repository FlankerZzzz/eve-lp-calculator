import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {navigationGraph} from '../lib/navigation.mjs';
import {shipParameters,canEnterHighsec,rangeSystems,nearbyLandings,makePlanLeg,inspectLeg,nextPlanActions,planEndpointIssues,checkpointProgress,routePlanState,directDestinationLeg,formatJumpRoute,destinationJumpStatus} from '../lib/jump-planner.mjs';
import {METRES_PER_LIGHTYEAR as LY} from '../lib/star-map.mjs';
const s=(id,x,security=.2,y=0,z=0,regionId=1)=>({id,nameZh:`星系${id}`,nameEn:`S${id}`,x:x*LY,y:y*LY,z:z*LY,security,regionId});
const graph=()=>navigationGraph({systems:[s(1,0,.9),s(2,3),s(3,6,-.1),s(4,2,.9),s(5,10),s(6,3,.2,4),s(7,20,.2,0,0,10000070)],gates:[[1,2],[2,3],[1,4],[4,5],[5,3],[3,7]]});
const ship={id:28846,groupId:902,baseRange:5,baseFuel:8200,shipFuelBonus:-10};
const make=(g,from,to,kind,mode='shortest',craft=ship,skills={})=>makePlanLeg(g,from,to,kind,mode,craft,skills);
test('Mifrata to SB-23C is beyond 10 LY: no offer, no candidate and no false completion',()=>{
  const a={id:30000046,nameZh:'米弗拉塔',regionId:10000001,security:.303803,x:-78639929616777980,y:42640460112816640,z:-94549571824356260};
  const b={id:30000991,nameZh:'SB-23C',regionId:10000011,security:-.017876,x:16026676476889654,y:21688903594591350,z:-102441720104936100};
  const g=navigationGraph({systems:[a,b],gates:[]}),plan={origin:a.id,destination:b.id,waypoints:[]};
  const status=destinationJumpStatus(g,plan,[],ship,{});
  assert.equal(status.kind,'out-of-range');assert.equal(status.range,10);assert.ok(Math.abs(status.distance-10.283092521734218)<1e-10);assert.ok(Math.abs(status.gap-.283092521734218)<1e-10);assert.equal(status.leg,null);
  assert.equal(rangeSystems(g,a.id,10).some(s=>s.id===b.id),false);assert.equal(directDestinationLeg(g,plan,[],ship,{}),null);assert.throws(()=>make(g,a.id,b.id,'jump'),/超过跳跃范围/);
});
test('destination status distinguishes geometry, gate-only, pending and invalid plans without inventing jumps',()=>{
  const g=graph(),plan={origin:1,destination:3,waypoints:[]};
  assert.equal(destinationJumpStatus(g,null,[],ship,{}).kind,'unplanned');
  const ready=destinationJumpStatus(g,plan,[],ship,{});assert.equal(ready.kind,'direct');assert.ok(ready.leg);
  assert.equal(destinationJumpStatus(g,plan,[],ship,{}, {dirty:true}).kind,'dirty');
  assert.equal(destinationJumpStatus(g,{...plan,waypoints:[2]},[],ship,{}).kind,'pending');
  assert.equal(destinationJumpStatus(g,{...plan,origin:2,destination:1},[],ship,{}).kind,'gate-only');
  assert.equal(destinationJumpStatus(g,{...plan,destination:7},[],{...ship,baseRange:20},{}).kind,'blocked');
  const leg=make(g,1,3,'jump');assert.equal(destinationJumpStatus(g,plan,[leg],ship,{}).kind,'complete');
  assert.equal(destinationJumpStatus(g,plan,[leg],ship,{calibration:0}).kind,'blocked');
  assert.equal(destinationJumpStatus(g,{...plan,waypoints:[2]},[leg],ship,{}).kind,'pending');
  const boundary=navigationGraph({systems:[s(1,0),s(2,10),s(3,10.0000001)],gates:[]});
  assert.equal(destinationJumpStatus(boundary,{origin:1,destination:2,waypoints:[]},[],ship,{}).kind,'direct');
  assert.equal(destinationJumpStatus(boundary,{origin:1,destination:3,waypoints:[]},[],ship,{}).kind,'out-of-range');
});
test('direct destination offer applies strict jump rules, old-route validity and segment limit',()=>{
  const g=graph(),plan={origin:1,destination:3,waypoints:[]};
  assert.deepEqual(directDestinationLeg(g,plan,[],ship,{}).ids,[1,3]);
  assert.equal(directDestinationLeg(g,plan,[],ship,{calibration:0}),null);
  assert.equal(directDestinationLeg(g,plan,[],ship,{}, {dirty:true}),null);
  assert.equal(directDestinationLeg(g,null,[],ship,{}),null);
  assert.equal(directDestinationLeg(g,{...plan,origin:2,destination:1},[],ship,{}),null,'highsec destination cannot be a jump target');
  assert.equal(directDestinationLeg(g,{...plan,destination:7},[],{...ship,baseRange:20},{}),null,'Pochven remains illegal even inside geometric range');
  assert.equal(directDestinationLeg(g,plan,[],{...ship,id:671,groupId:30},{}),null,'ship cannot start in highsec');
  assert.equal(directDestinationLeg(g,plan,[make(g,1,3,'jump')],ship,{}),null,'already arrived');
  const first=make(g,1,3,'jump');assert.equal(directDestinationLeg(g,{...plan,destination:5},[first],ship,{calibration:0}),null,'old invalid leg cannot be completed');
  assert.equal(directDestinationLeg(g,plan,Array(30).fill(make(g,1,2,'jump')),ship,{}),null);
});
test('direct finish never skips ordered waypoints and consumes a final checkpoint at destination',()=>{
  const g=graph(),plan={origin:1,destination:3,waypoints:[2]};
  assert.equal(directDestinationLeg(g,plan,[],ship,{}),null);
  assert.ok(directDestinationLeg(g,plan,[make(g,1,2,'gate')],ship,{}));
  assert.ok(directDestinationLeg(g,{...plan,waypoints:[3]},[],ship,{}));
  assert.equal(directDestinationLeg(g,{...plan,waypoints:[3,3]},[],ship,{}),null);
});
test('copied route preserves every gate intermediate and labels jumps separately',()=>{
  const g=graph(),legs=[make(g,1,3,'jump'),{from:3,to:5,kind:'gate',ids:[3,2,1,4,5]}];
  assert.equal(formatJumpRoute(g,1,legs),'起点：星系1\n1. 旗舰跳：星系1 → 星系3\n2. 星门（4 跳）：星系3 → 星系2 → 星系1 → 星系4 → 星系5\n终点：星系5');
  assert.equal(formatJumpRoute(g,1,[]),'起点：星系1\n终点：星系1');
});
test('shared gate strategies remain valid while flagship manual gates use only shortest legal routing',()=>{
  const g=navigationGraph({systems:[s(1,0,.9),s(2,1),s(3,2,.9),s(4,3,.9),s(5,4)],gates:[[1,2],[2,5],[1,3],[3,4],[4,5]]});
  assert.deepEqual(make(g,1,5,'gate','secure').ids,[1,3,4,5]);
  assert.deepEqual(make(g,1,5,'gate','shortest').ids,[1,2,5]);
  assert.deepEqual(make(g,1,5,'gate','insecure').ids,[1,2,5]);
  const page=readFileSync(new URL('../app/navigation/jump/page.tsx',import.meta.url),'utf8');assert.doesNotMatch(page,/过门路径偏好|jump-gate-mode/);assert.match(page,/const gateMode='shortest'/);
});
test('completion follows valid current settings, not just the old line arriving at B',()=>{
  assert.equal(routePlanState().kind,'unplanned');
  const arrived={planned:true,arrived:true,legs:[{issues:[]}],endpointIssues:[]};
  assert.equal(routePlanState(arrived).kind,'complete');
  assert.equal(routePlanState({...arrived,arrived:false}).kind,'incomplete');
  assert.equal(routePlanState({...arrived,dirty:true}).kind,'dirty');
  assert.deepEqual(routePlanState({...arrived,legs:[{issues:['超过跳跃范围']}]}),{kind:'invalid',issues:['超过跳跃范围']});
  assert.equal(routePlanState({...arrived,endpointIssues:['不能进入高安'],legs:[]}).kind,'invalid','endpoint restriction matters even with no legs');
  const g=graph(),leg=make(g,1,3,'jump');
  assert.equal(routePlanState({...arrived,legs:[inspectLeg(g,leg,ship,{calibration:0})]}).kind,'invalid');
  assert.equal(routePlanState({...arrived,legs:[inspectLeg(g,leg,ship,{calibration:5})]}).kind,'complete','restoring skills restores a valid completed plan');
  assert.equal(routePlanState({...arrived,arrived:false,legs:[]}).kind,'incomplete','undo removes completion');
});
test('completed route popup is tied to valid copy text and remembers dismissed route per planning run',()=>{
  const page=readFileSync(new URL('../app/navigation/jump/page.tsx',import.meta.url),'utf8');
  const dialog=readFileSync(new URL('../app/navigation/jump/completion-dialog.tsx',import.meta.url),'utf8');
  assert.match(page,/routeState.kind==='complete'&&graph&&plan\?formatJumpRoute/);
  assert.match(page,/completionKey=routeText\?JSON.stringify\(\[planRun,routeText\]\)/);
  assert.match(page,/showCompletion=!!completionKey&&!dismissedCompletion.has\(completionKey\)/);
  assert.match(page,/showCompletion&&<JumpCompletionDialog/);
  assert.match(dialog,/element.showModal\(\)/);
  assert.match(dialog,/onCancel=.*onDismiss\(\)/);
  assert.match(dialog,/路线已完成，请在下方复制路径/);
  assert.match(dialog,/onClick=\{onViewRoute\}>前往复制路径/);
});
test('completed maps retain route overlay but stop drawing all jump range spheres and next-hop highlights',()=>{
  const page=readFileSync(new URL('../app/navigation/jump/page.tsx',import.meta.url),'utf8');
  assert.match(page,/const complete=routeState.kind==='complete'/);
  assert.match(page,/circleIds:complete\?\[\]:history\?/);
  assert.match(page,/candidates:complete\?\[\]:candidates.map/);
  assert.match(page,/landings:complete\?\[\]:landings.map/);
  assert.match(page,/legs:inspected,circleIds:/);
});
test('fuel bonus, overflow and derived fuel failures reject instead of returning zero/negative/NaN',()=>{
  for(const bonus of [null,NaN,Infinity,-Infinity,-20,-101,'-10'])assert.throws(()=>shipParameters({...ship,shipFuelBonus:bonus}),/加成/);
  assert.throws(()=>shipParameters({...ship,baseRange:Number.MAX_VALUE}),/结果/);
  assert.throws(()=>shipParameters({...ship,baseFuel:Number.MAX_VALUE,shipFuelBonus:100}),/结果/);
  const g=graph();assert.throws(()=>make(g,1,3,'jump','shortest',{...ship,baseFuel:Number.MAX_VALUE}),/燃料/);
});
test('ordered draft checkpoints consume gate intermediates and jump landings, not mere proximity',()=>{
  const legs=[{ids:[1,2,3]},{ids:[3,5]}];
  assert.deepEqual(checkpointProgress(1,legs,[2,5]),{completed:2,remaining:[]});
  assert.deepEqual(checkpointProgress(1,legs,[5,2]),{completed:1,remaining:[2]});
  assert.deepEqual(checkpointProgress(1,[{ids:[1,5]}],[2,5]),{completed:0,remaining:[2,5]});
  assert.equal(checkpointProgress(1,[],[1,1]).completed,1);
  assert.equal(checkpointProgress(1,[{ids:[1,2,1]}],[1,1]).completed,2);
  assert.equal(checkpointProgress(1,legs.slice(0,1),[2,5]).completed,1,'undo rolls progress back');
  assert.deepEqual(checkpointProgress(1,legs),{completed:0,remaining:[]});
});
test('jump demo uses linear calibration and independently multiplicative fuel skills',()=>{
  assert.deepEqual(shipParameters(ship),{range:10,fuelPerLy:2050});
  assert.deepEqual(shipParameters(ship,{calibration:0,conservation:0,shipSkill:0}),{range:5,fuelPerLy:8200});
  assert.equal(shipParameters({...ship,shipFuelBonus:0}).fuelPerLy,4100);
  for(const bad of [-1,6,2.5,NaN,'5'])assert.throws(()=>shipParameters(ship,{calibration:bad}));
  assert.throws(()=>shipParameters({...ship,baseRange:0}));
});
test('range is true 3D, inclusive at boundary, no NPC station or incursion exclusion',()=>{
  const g=graph();assert.deepEqual(rangeSystems(g,1,5).map(s=>s.id),[2,6]);
  assert.deepEqual(rangeSystems(g,1,3).map(s=>s.id),[2]);
  assert.ok(rangeSystems(g,1,20).some(s=>s.id===7),'even special areas remain available for manual inspection');
  assert.deepEqual(rangeSystems(g,999,10),[]);assert.deepEqual(rangeSystems(g,1,NaN),[]);
});
test('destination nearby candidates use gate distance, not LY distance, traverse stationless systems',()=>{
  const g=graph();assert.deepEqual(nearbyLandings(g,1,5),[{id:2,hops:1},{id:3,hops:2},{id:5,hops:2},{id:7,hops:3}]);
  assert.equal(nearbyLandings(g,1,1).length,1);
});
test('manual gate segments reuse navigation, jump segments never invent intermediate points',()=>{
  const g=graph();assert.deepEqual(make(g,1,3,'jump').ids,[1,3]);
  assert.deepEqual(make(g,1,3,'gate').ids,[1,2,3]);
  assert.throws(()=>make(g,1,1,'jump'));
  assert.throws(()=>make(g,1,6,'gate'),/连通/);
  assert.throws(()=>make(g,1,999,'jump'));
  assert.throws(()=>make(g,1,2,'other'));
  assert.throws(()=>makePlanLeg(g,1,2,'jump'),/舰船/);
});
test('previously valid legs are rechecked when skills change; new illegal legs are rejected',()=>{
  const g=graph(),skills={calibration:0,conservation:5,shipSkill:5};
  const over=inspectLeg(g,make(g,1,3,'jump'),ship,skills);assert.equal(over.distance,6);assert.equal(over.fuel,12300);assert.ok(over.issues.includes('超过跳跃范围'));assert.deepEqual(over.ids,[1,3]);
  assert.throws(()=>make(g,1,3,'jump','shortest',ship,skills),/超过跳跃范围/);
  assert.throws(()=>make(g,2,1,'jump'),/高安/);
  assert.throws(()=>make(g,1,7,'jump'),/波赫文/);
  const gate=inspectLeg(g,make(g,1,3,'gate'),ship,skills);assert.equal(gate.fuel,0);assert.equal(gate.gates,2);
  assert.equal(inspectLeg(g,make(g,1,2,'jump'),ship,skills).issues.length,0);
});
test('Serenity highsec hull exceptions come from the agreed whitelist, not all carriers',()=>{
  for(const groupId of [898,902,4622])assert.equal(canEnterHighsec({...ship,groupId}),true);
  assert.equal(canEnterHighsec({...ship,id:76009,groupId:547}),true);
  assert.equal(canEnterHighsec({...ship,id:23911,groupId:547}),false);
  const g=graph(),restricted={...ship,id:23911,groupId:547};
  assert.throws(()=>make(g,1,2,'gate','shortest',restricted),/不能进入高安/);
  assert.ok(planEndpointIssues(g,[2,1],restricted).some(s=>s.includes('不能进入高安')));
  const v=inspectLeg(g,{from:1,to:2,kind:'gate',ids:[1,2]},restricted,{});assert.ok(v.issues.some(i=>i.includes('不能进入高安')));
});
test('gate search removes all highsec nodes for restricted hulls and finds a legal lowsec detour',()=>{
  const restricted={...ship,id:671,groupId:30};
  const g=navigationGraph({systems:[s(1,0),s(2,1,.9),s(3,2),s(4,3),s(5,4)],gates:[[1,2],[2,3],[1,4],[4,5],[5,3]]});
  for(const mode of ['shortest','secure','insecure'])assert.deepEqual(make(g,1,3,'gate',mode,restricted).ids,[1,4,5,3]);
  assert.deepEqual(make(g,1,3,'gate').ids,[1,2,3]);
  const disconnected=navigationGraph({systems:[s(1,0),s(2,1,.9),s(3,2)],gates:[[1,2],[2,3]]});
  assert.equal(nextPlanActions(disconnected,1,3,restricted,{}).gate.leg,null);
});
test('menu availability and route insertion share strict range and security rules',()=>{
  const g=graph();
  const atBoundary=nextPlanActions(g,1,2,ship,{calibration:0});assert.ok(atBoundary.jump.leg);
  const over=nextPlanActions(g,1,3,ship,{calibration:0});assert.equal(over.jump.leg,null);assert.match(over.jump.error,/超过/);assert.ok(over.gate.leg);
  assert.equal(nextPlanActions(g,2,1,ship,{}).jump.leg,null);
  assert.equal(nextPlanActions(g,1,1,ship,{}).gate.leg,null);
  const exact=navigationGraph({systems:[s(1,0,.9),s(2,5),s(3,5.00001)],gates:[[1,2],[2,3]]});
  assert.ok(nextPlanActions(exact,1,2,ship,{calibration:0}).jump.leg);assert.equal(nextPlanActions(exact,1,3,ship,{calibration:0}).jump.leg,null);
});
test('UI distinguishes advisory information from exclusions; mobile does not mount a map',()=>{
  const page=readFileSync(new URL('../app/navigation/jump/page.tsx',import.meta.url),'utf8');
  assert.match(page,/desktop===true&&/);assert.match(page,/手机端不加载三维星图/);
  assert.match(page,/按当前规避开关筛选，不按站点筛除/);assert.match(page,/仅保留规划线/);assert.match(page,/useNavigationAvoid\('jump'\)/);
  assert.match(page,/onContext=\{context\}/);assert.match(page,/hoverDetails=\{hoverDetails\}/);
  assert.doesNotMatch(page,/\/api\/navigation\/route/);
});
