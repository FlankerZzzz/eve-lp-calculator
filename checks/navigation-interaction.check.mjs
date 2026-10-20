import test from 'node:test';
import assert from 'node:assert/strict';
import {assignNavigationPoint,moveWaypoint,waypointSlot} from '../lib/waypoint-order.mjs';
import {navigationViewPolicy} from '../lib/navigation-view.mjs';
import {readFileSync} from 'node:fs';
test('manual point moves preserve objects, duplicates, all points and original array',()=>{
  const points=[{key:1,id:3},{key:2,id:4},{key:3,id:3},{key:4,id:5}];
  const moved=moveWaypoint(points,3,1);assert.deepEqual(moved.map(p=>p.key),[3,1,2,4]);assert.equal(moved[0],points[2]);assert.deepEqual(points.map(p=>p.key),[1,2,3,4]);
  assert.deepEqual(moveWaypoint(points,1,4).map(p=>p.key),[2,3,4,1]);
  assert.equal(moveWaypoint(points,9,1),points);assert.equal(moveWaypoint(points,1,1),points);
});
test('drag insertion follows nearest slots and clamps outside list bounds',()=>{
  const slots=[{top:100,height:90},{top:190,height:90},{top:280,height:110}];
  assert.equal(waypointSlot(145,slots),0);assert.equal(waypointSlot(250,slots),1);assert.equal(waypointSlot(335,slots),2);assert.equal(waypointSlot(-100,slots),0);assert.equal(waypointSlot(9999,slots),2);
});
test('route emphasis fits available routes while retaining the background star map',()=>{
  assert.deepEqual(navigationViewPolicy(false,true),{view:'overview',showBackground:true,fitRoutes:false});
  assert.deepEqual(navigationViewPolicy(false,false),{view:'overview',showBackground:true,fitRoutes:false});
  assert.deepEqual(navigationViewPolicy(true,true),{view:'routes',showBackground:true,fitRoutes:true});
  assert.equal(navigationViewPolicy(true,false).fitRoutes,false);
});
test('view and sorting changes stay local to presentation, not route order optimisation',()=>{
  const page=readFileSync(new URL('../app/navigation/page.tsx',import.meta.url),'utf8');
  assert.match(page,/const showDetails=desktop===false/);assert.match(page,/showDetails\?<>/);assert.doesNotMatch(page,/\/api\/navigation\/optimize/);
  assert.doesNotMatch(page,/聚焦分析|setFocus|nav-focus-list|nav-focus-summary/);
  const map=readFileSync(new URL('../app/navigation/star-map.tsx',import.meta.url),'utf8');assert.match(map,/if\(focus&&!wasFocused\)\{/);assert.match(map,/overview=\{position:camera.position.clone\(\),target:controls.target.clone\(\)/);assert.match(map,/if\(wasFocused&&!focus\)/);assert.match(map,/refit&&policy\.fitRoutes/);
});
test('focused waypoint raises its stacking context above later inputs, preserving drag animations',()=>{
  const css=readFileSync(new URL('../app/navigation/navigation.css',import.meta.url),'utf8');
  assert.match(css,/\.nav-point:focus-within\s*\{\s*z-index:\s*30\s*\}/);
  assert.match(css,/\.nav-point\{will-change:transform\}/);
  assert.match(css,/\.nav-picker-results\{[^}]*z-index:20/);
});
test('map point assignment preserves endpoint keys and inserts ordered waypoints before the destination',()=>{
  const a={key:1,id:null,text:''},b={key:2,id:null,text:''},point={key:3,id:42,text:'目标星系'},points=[a,b];
  const origin=assignNavigationPoint(points,point,'origin');assert.deepEqual(origin,[{key:1,id:42,text:'目标星系'},b]);assert.equal(origin[1],b);
  const destination=assignNavigationPoint(points,point,'destination');assert.deepEqual(destination,[a,{key:2,id:42,text:'目标星系'}]);assert.equal(destination[0],a);
  const first=assignNavigationPoint(origin,point,'waypoint'),second=assignNavigationPoint(first,{...point,key:4},'waypoint');
  assert.deepEqual(second.map(p=>p.key),[1,3,4,2]);assert.deepEqual(second.map(p=>p.id),[42,42,42,null]);assert.equal(second.at(-1),b);
  assert.deepEqual(points,[a,b]);assert.equal(a.id,null);assert.equal(b.id,null);
});
test('map assignment enforces the same 12 point limit while still allowing endpoint edits',()=>{
  const points=Array.from({length:12},(_,i)=>({key:i+1,id:i,text:String(i)})),point={key:13,id:99,text:'新星系'};
  assert.equal(assignNavigationPoint(points,point,'waypoint'),points);
  assert.equal(assignNavigationPoint(points,point,'origin').length,12);assert.equal(assignNavigationPoint(points,point,'origin')[0].id,99);
  assert.equal(assignNavigationPoint(points,point,'destination').at(-1).key,12);
  assert.equal(assignNavigationPoint(points,point,'invalid'),points);const empty=[];assert.equal(assignNavigationPoint(empty,point,'origin'),empty);
});
test('regular map has right-click and detail-card point actions without triggering recalculation',()=>{
  const page=readFileSync(new URL('../app/navigation/page.tsx',import.meta.url),'utf8');
  assert.match(page,/onContext=\{context\}/);assert.match(page,/aria-label="常规导航星系操作"/);assert.match(page,/pointButtons\(selected\)/);assert.match(page,/pointButtons\(menu.system\)/);
  assert.match(page,/disabled=\{points.length>=12\}/);assert.match(page,/追加在终点之前/);
  const assign=page.slice(page.indexOf('function setPoint('),page.indexOf('async function loadActivity('));
  assert.match(assign,/assignNavigationPoint\(rows,point,role\)/);assert.doesNotMatch(assign,/calculate\(|fetch\(|\.focus\(/);
  assert.match(page,/removeEventListener\('scroll',close,true\)/);
  const css=readFileSync(new URL('../app/navigation/navigation.css',import.meta.url),'utf8');
  assert.match(css,/\.nav-card-actions\{flex-wrap:wrap\}/);assert.match(css,/\.navigation-page \.nav-system-card\{box-sizing:border-box;max-height:calc\(100% - 400px\);overflow-y:auto\}/);
});
