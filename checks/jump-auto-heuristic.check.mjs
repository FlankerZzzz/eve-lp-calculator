import test from 'node:test';
import assert from 'node:assert/strict';
import {automaticJumpPlan} from '../lib/jump-auto-planner.mjs';
import {navigationGraph} from '../lib/navigation.mjs';
import {checkpointProgress,inspectLeg} from '../lib/jump-planner.mjs';
import {METRES_PER_LIGHTYEAR as LY,securityBand} from '../lib/star-map.mjs';
const ship={id:28846,groupId:902,baseRange:5,baseFuel:8200,shipFuelBonus:-10};
const cmp=(a,b)=>{for(let i=0;i<a.length;i++)if(a[i]!==b[i])return a[i]-b[i];return 0;};
function cost(graph,legs){
 const result=[0,0,0,0];for(const leg of legs){if(leg.kind==='jump'){result[2]++;result[3]+=inspectLeg(graph,leg,ship,{}).fuel;}else result[0]+=leg.ids.length-1;}return result;
}
function oracle(graph,blocked,waypoints=[],stationIds=null){
 const advance=(id,p)=>waypoints[p]===id?p+1:p,key=(id,p,arrival)=>`${id}:${p}:${arrival}`,progress=advance(1,0);
 const queue=[{id:1,progress,arrival:false,cost:[0,0,0,0]}],best=new Map([[key(1,progress,false),[0,0,0,0]]]);
 while(queue.length){queue.sort((a,b)=>cmp(a.cost,b.cost));const current=queue.shift();if(cmp(current.cost,best.get(key(current.id,current.progress,current.arrival))))continue;if(current.id===6&&current.progress===waypoints.length)return current.cost;
  for(const target of graph.systems.keys())for(const kind of ['gate','jump']){
   if(target===current.id||blocked.has(target))continue;
   if(kind==='gate'&&!graph.adjacent.get(current.id).includes(target))continue;
   const segmentTarget=waypoints[current.progress]??6;
   if(kind==='gate'&&(securityBand(graph.systems.get(segmentTarget).security)!=='high'||securityBand(graph.systems.get(target).security)!=='high'))continue;
   if(kind==='gate'&&securityBand(graph.systems.get(current.id).security)==='null')continue;
   if(kind==='jump'&&current.arrival)continue;
   if(kind==='jump'&&stationIds&&!stationIds.has(target))continue;
   const leg={from:current.id,to:target,kind,ids:[current.id,target]};if(inspectLeg(graph,leg,ship,{}).issues.length)continue;
   const delta=cost(graph,[leg]),candidate=current.cost.map((n,i)=>n+delta[i]),progress=advance(target,current.progress),arrival=kind==='gate'&&progress===current.progress,state=key(target,progress,arrival);if(best.has(state)&&cmp(candidate,best.get(state))>=0)continue;best.set(state,candidate);queue.push({id:target,progress,arrival,cost:candidate});
  }
 }return null;
}
test('optimistic gate heuristic preserves exact mixed-route costs against an independent oracle',()=>{
 let seed=120719;const random=()=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed/2**32;};
 for(let trial=0;trial<150;trial++){
  const systems=Array.from({length:6},(_,i)=>({id:i+1,nameZh:`S${i+1}`,nameEn:`S${i+1}`,regionId:1,x:(random()*30)*LY,y:random()*5*LY,z:0,security:random()<.5?.9:.2})),gates=[];
  for(let a=1;a<=6;a++)for(let b=a+1;b<=6;b++)if(random()<.3)gates.push([a,b]);
  const graph=navigationGraph({systems,gates}),blocked=random()<.4?new Set([2]):new Set();
  for(const gateMode of ['shortest','secure','insecure']){
   const expected=oracle(graph,blocked);let legs,error;try{legs=automaticJumpPlan(graph,{origin:1,destination:6,ship,gateMode,blocked});}catch(e){error=e;}
   if(expected===null)assert.ok(error,'disconnected graph must fail');else{assert.equal(error,undefined,error?.message);assert.deepEqual(cost(graph,legs,gateMode),expected,`trial ${trial} / ${gateMode}`);}
  }
 }
});
test('independent oracle covers repeated checkpoints and all NPC/invasion switch combinations',()=>{
 let seed=191026;const random=()=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed/2**32;};
 const now=Date.now(),incursions={ids:[3],modified:new Date(now).toISOString(),stale:false,error:null};
 for(let trial=0;trial<150;trial++){
  const systems=Array.from({length:6},(_,i)=>({id:i+1,nameZh:`S${i+1}`,nameEn:`S${i+1}`,regionId:1,x:random()*30*LY,y:random()*8*LY,z:random()*5*LY,security:random()<.4?.9:.2})),gates=[];
  for(let a=1;a<=6;a++)for(let b=a+1;b<=6;b++)if(random()<.3)gates.push([a,b]);
  const graph=navigationGraph({systems,gates}),waypoints=trial%3===0?[1,1]:trial%3===1?[2,4,2]:[4],stationIds=new Set(systems.filter(()=>random()<.6).map(s=>s.id)),stations=Object.fromEntries([...stationIds].map(id=>[id,[{id:60000000+id,typeId:1531}]]));
  for(const gateMode of ['shortest','secure','insecure'])for(const npcStationsOnly of [false,true])for(const avoidIncursions of [false,true]){
   const blocked=new Set([...(trial%5===0?[5]:[]),...(avoidIncursions?[3]:[])]),expected=oracle(graph,blocked,waypoints,npcStationsOnly?stationIds:null);
   let legs,error;try{legs=automaticJumpPlan(graph,{origin:1,destination:6,ship,gateMode,waypoints,stations,npcStationsOnly,avoidIncursions,incursions,blocked,now});}catch(e){error=e;}
   const label=`trial ${trial} / legacy ${gateMode} / NPC ${npcStationsOnly} / invasion ${avoidIncursions}`;
   if(expected===null)assert.ok(error,label);else{assert.equal(error,undefined,`${label}: ${error?.message}`);assert.deepEqual(cost(graph,legs,gateMode),expected,label);assert.equal(checkpointProgress(1,legs,waypoints).remaining.length,0,label);}
  }
 }
});
