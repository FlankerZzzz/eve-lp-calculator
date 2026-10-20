import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {navigationGraph} from '../lib/navigation.mjs';
import {METRES_PER_LIGHTYEAR as LY} from '../lib/star-map.mjs';
import {makePlanLeg,inspectLeg} from '../lib/jump-planner.mjs';
import {measureSystemDistance,oneJumpReach,sortJumpReach,filterJumpReach,formatJumpReachList,isWithinJumpReach} from '../lib/jump-tools.mjs';
import {jumpReachView,distanceLineView} from '../lib/star-map-presentation.mjs';

const ship={id:28846,groupId:902,baseRange:5,baseFuel:8200,shipFuelBonus:-10};
const s=(id,x,y=0,z=0,security=.2,regionId=1)=>({id,nameZh:`星系${id}`,nameEn:`S${id}`,regionId,regionName:'星域',security,x:x*LY,y:y*LY,z:z*LY});
const fixture=()=>navigationGraph({systems:[s(1,0),s(2,3,4),s(3,6),s(4,10),s(5,10.000001),s(6,1,0,0,.45),s(7,1,0,0,.2,10000070),s(8,0,0,5),s(9,2,11)],gates:[[1,5]]});
const now=Date.UTC(2026,9,19),feed=ids=>({ids,stale:false,error:null,modified:new Date(now).toISOString()});

test('reach list search supports names, ID and pinyin, retaining all matches and current distance order',()=>{
  const systems=Array.from({length:12},(_,index)=>({...s(index+1,index),nameZh:`测试${index+1}`,nameEn:`AB-${index+1}`,searchPinyin:`ceshi${index+1}`,searchInitials:`cs${index+1}`}));
  const graph=navigationGraph({systems,gates:[]});
  const rows=Object.freeze(systems.map(system=>({id:system.id,distance:system.id})).reverse());
  for(const query of ['', '测试','aB -','cé shì','cs'])assert.deepEqual(filterJumpReach(graph,rows,query),rows);
  for(const query of ['测试12','AB-12','12','ceshi12','CS12'])assert.deepEqual(filterJumpReach(graph,rows,query).map(row=>row.id),[12]);
  assert.deepEqual(filterJumpReach(graph,rows,'不存在'),[]);
  const filtered=filterJumpReach(graph,rows,'1');
  assert.deepEqual(filtered.map(row=>row.id),[12,11,10,1]);
  assert.match(formatJumpReachList(graph,filtered,'desc'),/^1\. 测试12 \/ AB-12 · 12 光年/);
  assert.deepEqual(rows.map(row=>row.id),Array.from({length:12},(_,i)=>12-i));
});

test('distance is symmetric true 3D geometry, including same-system, highsec and Pochven',()=>{
  const graph=fixture();
  assert.equal(measureSystemDistance(graph,1,2).distance,5);
  assert.equal(measureSystemDistance(graph,2,1).distance,5);
  assert.equal(measureSystemDistance(graph,2,2).distance,0);
  assert.equal(measureSystemDistance(graph,1,6).distance,1);
  assert.equal(measureSystemDistance(graph,1,7).distance,1);
  assert.equal(measureSystemDistance(graph,1,8).distance,5);
  assert.throws(()=>measureSystemDistance(graph,1,999),/有效星系/);
  assert.throws(()=>measureSystemDistance(null,1,2),/有效星系/);
  const invalid=navigationGraph({systems:[s(1,0),{...s(2,1),y:NaN}],gates:[]});
  assert.throws(()=>measureSystemDistance(invalid,1,2),/坐标无效/);
});

test('one jump includes exact range, excludes self, 3D-overrange, highsec and Pochven, never uses gates',()=>{
  const graph=fixture(),result=oneJumpReach(graph,1,ship);
  assert.equal(result.range,10);
  assert.deepEqual(result.rows.map(r=>r.id),[2,8,3,4]);
  assert.equal(result.rows.at(-1).distance,10);
  assert.equal(oneJumpReach(graph,1,ship,{calibration:0}).range,5);
  assert.deepEqual(oneJumpReach(graph,1,ship,{calibration:0}).rows.map(r=>r.id),[2,8]);
  for(const row of result.rows){
    const checked=inspectLeg(graph,makePlanLeg(graph,1,row.id,'jump','shortest',ship),ship,{});
    assert.equal(row.fuel,checked.fuel);assert.equal(row.distance,checked.distance);
  }
});

test('one jump fails clearly for illegal origins, invalid inputs and skills; empty range is valid',()=>{
  const graph=fixture();
  assert.throws(()=>oneJumpReach(graph,7,ship),/波赫文/);
  assert.throws(()=>oneJumpReach(graph,6,{...ship,id:671,groupId:30}),/不能进入高安/);
  assert.ok(oneJumpReach(graph,6,ship).rows.length);
  assert.throws(()=>oneJumpReach(graph,1,null),/舰船/);
  assert.throws(()=>oneJumpReach(graph,1,ship,{calibration:6}),/技能/);
  assert.throws(()=>oneJumpReach(graph,999,ship),/有效星系/);
  assert.deepEqual(oneJumpReach(graph,1,{...ship,baseRange:.01}).rows,[]);
});

test('NPC, blacklist and incursion switches affect only legal reach and never raw distance',()=>{
  const graph=fixture(),blocked=new Set([2]);
  const stations={3:[{id:100,typeId:200}],8:[{id:101,typeId:0}]};
  const options={blocked,incursions:feed([3,6]),avoidIncursions:true,now};
  assert.deepEqual(oneJumpReach(graph,1,ship,{},options).rows.map(r=>r.id),[8,4]);
  assert.deepEqual([...blocked],[2],'caller data remains untouched');
  assert.deepEqual(oneJumpReach(graph,1,ship,{}, {...options,avoidIncursions:false}).rows.map(r=>r.id),[8,3,4]);
  assert.deepEqual(oneJumpReach(graph,1,ship,{}, {stations,npcStationsOnly:true}).rows.map(r=>r.id),[3]);
  assert.deepEqual(oneJumpReach(graph,1,ship,{}, {stations,npcStationsOnly:true,...options}).rows,[]);
  assert.throws(()=>oneJumpReach(graph,2,ship,{},options),/规避/);
  assert.throws(()=>oneJumpReach(graph,3,ship,{},options),/入侵/);
  assert.throws(()=>oneJumpReach(graph,1,ship,{}, {...options,incursions:null}),/入侵/);
  assert.throws(()=>oneJumpReach(graph,1,ship,{}, {...options,incursions:feed([NaN])}),/入侵/);
  assert.throws(()=>oneJumpReach(graph,1,ship,{}, {...options,now:now+77*60000}),/入侵/);
  assert.ok(oneJumpReach(graph,1,ship,{}, {incursions:null,avoidIncursions:false}).rows.length);
  assert.equal(measureSystemDistance(graph,1,3).distance,6);
});

test('ascending/descending uses unrounded distances, stable ties and no source mutation',()=>{
  const rows=Object.freeze([{id:8,distance:5},{id:3,distance:5},{id:2,distance:5.00001}]);
  assert.deepEqual(sortJumpReach(rows).map(r=>r.id),[3,8,2]);
  assert.deepEqual(sortJumpReach(rows,'desc').map(r=>r.id),[2,3,8]);
  assert.deepEqual(rows.map(r=>r.id),[8,3,2]);
  assert.throws(()=>sortJumpReach(rows,'unknown'),/排序/);
  assert.equal(formatJumpReachList(fixture(),[{id:3,distance:6},{id:2,distance:5}]),'1. 星系2 / S2 · 5 光年\n2. 星系3 / S3 · 6 光年');
  assert.equal(formatJumpReachList(fixture(),[{id:3,distance:6},{id:2,distance:5}],'desc'),'1. 星系3 / S3 · 6 光年\n2. 星系2 / S2 · 5 光年');
  assert.equal(formatJumpReachList(fixture(),[]),'');
});

test('seeded random graph reach exactly matches shared manual jump legality for multiple hulls and skills',()=>{
  let seed=20261019;const random=()=>((seed=(Math.imul(seed,1664525)+1013904223)>>>0)/2**32);
  const systems=Array.from({length:100},(_,i)=>s(i+1,random()*20,random()*20,random()*20,i%7===0?.8:.2,i%19===0?10000070:1));
  const graph=navigationGraph({systems,gates:[]}),blocked=new Set([5,8]);let cases=0;
  for(const craft of [ship,{...ship,id:671,groupId:30,baseRange:3.5}])for(const calibration of [0,3,5])for(const origin of systems.filter(s=>s.regionId!==10000070&&s.security<.45&&!blocked.has(s.id)).slice(0,15)){
    const expected=[];
    for(const to of systems){try{makePlanLeg(graph,origin.id,to.id,'jump','shortest',craft,{calibration},blocked);expected.push(to.id);}catch{}}
    assert.deepEqual(oneJumpReach(graph,origin.id,craft,{calibration},{blocked}).rows.map(r=>r.id).sort((a,b)=>a-b),expected.sort((a,b)=>a-b));cases++;
  }
  assert.equal(cases,90);
});

test('range view targets chosen system, frames range and retains 2D display-only projection',()=>{
  const system=s(1,2,3,4),three=jumpReachView(system,10),two=jumpReachView(system,10,'2d');
  assert.equal(three.distance,32);assert.equal(two.distance,32);
  assert.equal(two.target[1],0);assert.notEqual(three.target[1],0);
  assert.equal(three.target[0],two.target[0]);assert.equal(three.target[2],two.target[2]);
  assert.equal(jumpReachView(system,10,'2d',.5).distance,64);
  assert.throws(()=>jumpReachView(system,NaN),/航程/);
});

test('distance line view centers and frames both stars, including same system and vertical 2D projection',()=>{
  const a=s(1,0),b=s(2,12,6,8),view=distanceLineView(a,b);
  assert.deepEqual(view.target,[6,3,-4]);
  assert.ok(Math.abs(view.distance-Math.hypot(12,6,8)*1.6)<1e-10);
  assert.equal(distanceLineView(a,b,'3d',.5).distance,view.distance*2);
  assert.equal(distanceLineView(a,a).distance,6);
  assert.deepEqual(distanceLineView(a,s(3,0,10),'2d').target.map(n=>n||0),[0,0,0]);
  assert.equal(distanceLineView(a,s(3,0,10),'2d').distance,6);
});

test('map and list selections only focus/inspect stars without cancelling either tool calculation',()=>{
  const page=readFileSync(new URL('../app/navigation/jump/page.tsx',import.meta.url),'utf8');
  const hook=readFileSync(new URL('../app/navigation/jump/use-jump-tools.ts',import.meta.url),'utf8');
  const bar=readFileSync(new URL('../app/navigation/jump/jump-tools-bar.tsx',import.meta.url),'utf8');
  const css=readFileSync(new URL('../app/navigation/jump/jump-tools.css',import.meta.url),'utf8');
  assert.match(page,/MapDimensionControl.*JumpToolsBar/);
  const select=page.slice(page.indexOf('const select=useCallback'),page.indexOf('useEffect(()=>{cancelAutomatic()'));
  assert.match(select,/select=useCallback.*controls.current\?\.focus\(s\)/);
  assert.match(select,/context=useCallback.*setSelected\(s\)/);
  assert.doesNotMatch(select,/cancelEffects|clearCalculations|setActive|onSystemSelect/);
  assert.doesNotMatch(hook,/onSystemSelect|selectionContext|isWithinJumpReach/);
  assert.match(page,/reachOverlay=\{tools.reachOverlay\} distanceOverlay=\{tools.distanceOverlay\}/);
  assert.match(hook,/active==='reach'&&reach.result/);
  assert.match(hook,/active==='distance'&&distance.result/);
  assert.match(hook,/cancelEffects=useCallback\(\(\)=>setActive\(null\),\[\]\)/);
  assert.match(bar,/onSubmit=.*tools.showReach/);assert.match(bar,/onSubmit=.*tools.measure/);
  assert.match(bar,/aria-label="一跳可达距离排序"/);
  assert.doesNotMatch(bar,/关闭一跳可达结果|关闭距离计算结果/);
  assert.match(bar,/点击任意星系仅放大/);
  assert.match(css,/\.jump-distance-result\{pointer-events:none\}/);
  assert.match(css,/\.jump-distance-result>button\{pointer-events:auto\}/);
});

test('reach selection retains all geometrically inside systems, not just legal destinations',()=>{
  const graph=fixture(),query={origin:1,range:10};
  for(const id of [1,2,3,4,6,7,8])assert.equal(isWithinJumpReach(graph,query,id),true,`inside: ${id}`);
  for(const id of [5,9,999])assert.equal(isWithinJumpReach(graph,query,id),false,`outside/unknown: ${id}`);
  assert.equal(isWithinJumpReach(graph,{origin:1,range:5},3),false);
  assert.equal(isWithinJumpReach(graph,{origin:1,range:5},2),true);
  assert.equal(isWithinJumpReach(graph,null,2),false);
  assert.equal(isWithinJumpReach(graph,{origin:1,range:NaN},2),false);
  assert.equal(isWithinJumpReach(null,query,2),false);
});

test('headless controller exposes query/list/overlay without route mutations or entrance placement',()=>{
  const hook=readFileSync(new URL('../app/navigation/jump/use-jump-tools.ts',import.meta.url),'utf8');
  const map=readFileSync(new URL('../app/navigation/star-map.tsx',import.meta.url),'utf8');
  assert.match(hook,/rows:sortJumpReach|sortJumpReach\(reach.result\?\.rows/);
  assert.match(hook,/candidates:reach.result.rows.map/);
  assert.match(hook,/\[graph,ship,skills,blocked,incursions,avoidIncursions,npcStationsOnly,stations,now,reachInput\]/);
  assert.doesNotMatch(hook,/setPlan|setLegs|fetch\(|localStorage|<button/);
  assert.match(map,/reachOverlay=null/);assert.match(map,/clearReach\(\);clearJump\(\)/);
  assert.match(map,/if\(key!==previousReachKey\)flyTo\(jumpReachView/);
  assert.match(map,/jumpGroup.visible=jumpLabels.visible=!hasReachOverlay/);
});

test('clear-calculation button is separate from reset and only clears tool query state',()=>{
  const compass=readFileSync(new URL('../app/navigation/map-compass.ts',import.meta.url),'utf8');
  const hook=readFileSync(new URL('../app/navigation/jump/use-jump-tools.ts',import.meta.url),'utf8');
  const page=readFileSync(new URL('../app/navigation/jump/page.tsx',import.meta.url),'utf8');
  assert.match(compass,/button.onclick=\(\)=>onView/);
  assert.match(compass,/clear.textContent='清除计算';clear.disabled=true/);
  assert.match(compass,/clear.onclick=\(\)=>onClearCalculation\?\.\(\)/);
  assert.match(compass,/setCalculation\(active:boolean\)\{if\(clear\)clear.disabled=!active/);
  assert.match(hook,/clearCalculations=useCallback\(\(\)=>\{setActive\(null\);setDistanceInput\(null\);setReachInput\(null\);setDirection\('asc'\);\},\[\]\)/);
  assert.doesNotMatch(hook,/\.reset\(|\.focus\(|\.zoom\(/);
  assert.match(page,/hasCalculation=\{hasCalculation\} onClearCalculation=\{clearAllCalculations\}/);
});

test('global clear removes route endpoints, checkpoints, legs and pending requests without changing view or preferences',()=>{
  const page=readFileSync(new URL('../app/navigation/jump/page.tsx',import.meta.url),'utf8');
  const clear=page.slice(page.indexOf('const clearAllCalculations=useCallback'),page.indexOf('const select=useCallback'));
  assert.match(clear,/cancelAutomatic\(\)/);
  const cancel=page.slice(page.indexOf('const cancelAutomatic=useCallback'),page.indexOf('const clearAllCalculations=useCallback'));
  assert.match(cancel,/autoRequest.current\?\.abort\(\)/);assert.match(cancel,/method:'DELETE'/);
  for(const statement of ["setPoints([{key:1,text:'',id:null},{key:2,text:'',id:null}])","setPlan(null)","setLegs([])","setSelected(null)","setMenu(null)","clearCalculations()"] )assert.ok(clear.includes(statement),statement);
  assert.doesNotMatch(clear,/\.reset\(|\.focus\(|\.zoom\(|setShipId\(|setCalibration\(|setConservation\(|setShipSkill\(|setAvoid\(|setDimension\(/);
  assert.match(page,/hasCalculation=tools.active!==null\|\|!!plan\|\|legs.length>0\|\|!!origin.text\|\|!!destination.text\|\|waypoints.length>0\|\|autoBusy/);
  assert.match(page,/desktop===false&&<button type="button" disabled=\{!hasCalculation\} onClick=\{clearAllCalculations\}>清除计算/);
});
