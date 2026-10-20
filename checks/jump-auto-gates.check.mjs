import test from 'node:test';
import assert from 'node:assert/strict';
import {automaticJumpPlan,autoGateIssues} from '../lib/jump-auto-planner.mjs';
import {navigationGraph} from '../lib/navigation.mjs';
import {inspectLeg} from '../lib/jump-planner.mjs';
import {METRES_PER_LIGHTYEAR as LY} from '../lib/star-map.mjs';
const ship={id:28846,groupId:902,baseRange:5,baseFuel:8200,shipFuelBonus:-10};
const s=(id,x,security=.2)=>({id,nameZh:`S${id}`,nameEn:`S${id}`,regionId:1,security,x:x*LY,y:0,z:0});
const graph=(systems,gates=[])=>navigationGraph({systems,gates});
const run=(g,options={})=>automaticJumpPlan(g,{origin:1,destination:4,ship,...options});
test('screenshot-shaped nullsec departure gates are forbidden, including legacy client overrides',()=>{
 const g=graph([s(1,0),s(2,100),s(3,200),s(4,209)],[[1,2],[2,3]]);
 for(const allowGates of [undefined,false,true])for(const gateMode of ['secure','insecure','shortest'])assert.throws(()=>run(g,{allowGates,gateMode}),/路径不可达，请自行规划/);
});
test('only highsec final destinations can be reached by gate, never a low/null destination',()=>{
 for(const security of [-.2,0,.2])assert.throws(()=>run(graph([s(1,0),s(4,100,security)],[[1,4]])),/路径不可达，请自行规划/);
 assert.deepEqual(run(graph([s(1,0),s(4,100,.9)],[[1,4]])),[{from:1,to:4,kind:'gate',ids:[1,4]}]);
});
test('highsec arrival is a final suffix; highsec transit followed by jumping is forbidden',()=>{
 const g=graph([s(1,0),s(2,100,.9),s(3,200),s(4,209)],[[1,2],[2,3]]);
 assert.throws(()=>run(g),/路径不可达/);
 const highB=graph([s(1,0),s(2,100,.9),s(3,109),s(4,200,.9)],[[1,2],[3,4]]);
 assert.throws(()=>run(highB),/路径不可达/);
});
test('jump to a lowsec border then gate through highsec to B, without lowsec transit gates',()=>{
 const g=graph([s(1,0),s(2,9),s(3,100,.9),s(4,200,.9),s(5,300)],[[2,3],[3,4],[1,5],[5,4]]);
 const legs=run(g);assert.deepEqual(legs.map(l=>[l.kind,l.ids]),[['jump',[1,2]],['gate',[2,3,4]]]);
 for(const l of legs)assert.deepEqual(inspectLeg(g,l,ship).issues,[]);
});
test('each highsec waypoint is a segment endpoint, but leaving it still requires a legal jump',()=>{
 const g=graph([s(1,0),s(2,9),s(3,100,.9),s(4,200,.9)],[[2,3],[3,4]]);
 assert.deepEqual(run(g,{waypoints:[2,3]}).map(l=>l.to),[2,3,4]);
 assert.throws(()=>run(g,{waypoints:[3,2]}),/路径不可达/);
 assert.deepEqual(run(g,{origin:3,destination:3,waypoints:[3]}),[]);
 const stops=graph([s(1,0),s(2,9),s(3,100,.9),s(4,109)],[[2,3]]);
 const legs=run(stops,{waypoints:[3]});assert.deepEqual(legs.map(l=>[l.kind,l.to]),[['jump',2],['gate',3],['jump',4]]);
 assert.deepEqual(autoGateIssues(stops,legs,4,[3],1),[]);
 assert.throws(()=>run(stops),/路径不可达/);
});
test('NPC landing filter cannot be bypassed via lowsec gates; highsec gate landings need no station',()=>{
 const g=graph([s(1,0),s(2,9),s(3,18),s(4,27)],[[1,4]]),stations=Object.fromEntries([2,3,4].map(id=>[id,[{id:60000000+id,typeId:1531}]]));
 assert.deepEqual(run(g,{npcStationsOnly:true,stations}).map(l=>l.kind),['jump','jump','jump']);
 assert.throws(()=>run(g,{npcStationsOnly:true,stations:{4:stations[4]}}),/路径不可达/);
 const highB=graph([s(1,0),s(2,9),s(4,100,.9)],[[2,4]]);
 assert.equal(run(highB,{npcStationsOnly:true,stations})[1].kind,'gate');
});
test('shared client/server gate validation blocks forbidden routes and later departure',()=>{
 const g=graph([s(1,0),s(2,100),s(3,200,.9),s(4,300,.9)]),gate=ids=>({from:ids[0],to:ids.at(-1),kind:'gate',ids}),jump=(a,b)=>({from:a,to:b,kind:'jump',ids:[a,b]});
 assert.ok(autoGateIssues(g,[gate([1,2])],2).length);
 assert.ok(autoGateIssues(g,[gate([1,2,4])],4).length);
 assert.deepEqual(autoGateIssues(g,[jump(1,2),gate([2,3,4])],4),[]);
 assert.ok(autoGateIssues(g,[gate([1,3]),jump(3,2),gate([2,4])],4).length);
});

test('highsec arrival selects the nearest reachable lowsec border by gate count, never a nullsec gate shortcut',()=>{
 const g=graph([s(1,0,-.2),s(2,9),s(3,18),s(4,100,.9),s(5,200,.9)],[[1,5],[2,4],[4,5],[3,5]]);
 const legs=run(g,{destination:5});assert.deepEqual(legs.map(l=>[l.kind,l.ids]),[['jump',[1,2]],['jump',[2,3]],['gate',[3,5]]]);
 assert.deepEqual(autoGateIssues(g,legs,5),[]);
 assert.match(autoGateIssues(g,[{from:1,to:5,kind:'gate',ids:[1,5]}],5).join('；'),/低安边界/);
 const onlyNull=graph([s(1,0,-.2),s(4,100,.9)],[[1,4]]);assert.throws(()=>run(onlyNull),/路径不可达/);
});

test('ordered highsec stop allows later departure only for hulls allowed in highsec, retaining independent NPC/invasion guards',()=>{
 const g=graph([s(1,0,-.2),s(2,9),s(3,100,.9),s(4,109)],[[2,3]]),stations={2:[{id:60000002,typeId:1531}],4:[{id:60000004,typeId:1531}]};
 const legs=run(g,{waypoints:[3],npcStationsOnly:true,stations});assert.deepEqual(legs.map(l=>[l.kind,l.to]),[['jump',2],['gate',3],['jump',4]]);
 assert.throws(()=>run(g,{waypoints:[3],ship:{...ship,id:671,groupId:30}}),/不能进入高安/);
 assert.throws(()=>run(g,{waypoints:[3],npcStationsOnly:true,stations:{4:stations[4]}}),/路径不可达/);
 const now=Date.now(),incursions={ids:[3],modified:new Date(now).toISOString(),stale:false,error:null};
 assert.throws(()=>run(g,{waypoints:[3],avoidIncursions:true,incursions,now}),/规避/);
 assert.deepEqual(run(g,{waypoints:[3],avoidIncursions:false,incursions}).map(l=>l.to),[2,3,4]);
});
