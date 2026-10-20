import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {routeBounds} from '../lib/star-map-presentation.mjs';
import {METRES_PER_LIGHTYEAR as LY} from '../lib/star-map.mjs';
const s=(id,x,z,y=0)=>({id,x:x*LY,y:y*LY,z:z*LY});
const systems=new Map([s(1,-5,0),s(2,5,0),s(3,0,20),s(4,-30,0),s(5,3,1,50)].map(s=>[s.id,s]));
const a={ids:[1,2]},b={ids:[1,3,2]},c={ids:[1,4,2]};
test('one, two and three displayed routes frame the full union including detours and repeated points',()=>{
 const one=routeBounds(systems,[a]),two=routeBounds(systems,[a,b]),three=routeBounds(systems,[a,b,c]);
 assert.deepEqual(one.target,[0,0,0]);assert.equal(one.radius,5);
 assert.deepEqual(two.target,[0,0,-10]);assert.equal(two.radius,Math.hypot(10,20)/2);
 assert.deepEqual(three.target,[-12.5,0,-10]);assert.equal(three.radius,Math.hypot(35,20)/2);
 assert.deepEqual(routeBounds(systems,[a,a]),one);assert.deepEqual(routeBounds(systems,[c,b,a]),three);
});
test('empty and single-system results are safe; 2D framing only changes projection',()=>{
 assert.equal(routeBounds(systems,[]),null);assert.equal(routeBounds(systems,[{ids:[]}]),null);
 assert.deepEqual(routeBounds(systems,[{ids:[2,2]}]),{target:[5,0,0],radius:1});
 const routes=[{ids:[1,5,2]}],two=routeBounds(systems,routes,'2d'),three=routeBounds(systems,routes);
 assert.equal(two.target[1],0);assert.equal(three.target[1],25);assert.ok(three.radius>two.radius);
 assert.equal(systems.get(5).y,50*LY);assert.throws(()=>routeBounds(systems,[{ids:[999]}]),/未知星系/);
});
test('successful recalculation refits even an identical route; labels and background stars remain without busy rings',()=>{
 const page=readFileSync(new URL('../app/navigation/page.tsx',import.meta.url),'utf8'),map=readFileSync(new URL('../app/navigation/star-map.tsx',import.meta.url),'utf8');
 assert.match(page,/setRouteViewRequest\(value=>value\+1\)/);assert.match(page,/focusRoutes=\{visibleRoutes.length>0\} routeViewRequest=\{routeViewRequest\}/);
 assert.match(map,/\+focus\+':'\+request/);assert.match(map,/routeBounds\(byId,routes,dimension\)/);
 assert.match(map,/if\(focused\|\|hasReachOverlay\|\|hasDistanceOverlay\)material.opacity=\.12/);
 assert.match(map,/scene.background=null/);assert.doesNotMatch(map,/ShaderMaterial|ship_jumps|const rings=/);
 assert.match(map,/const pointMaterial=nodeMaterial/);assert.match(map,/routes.map\(r=>\[r.mode,r.ids\]\)/);
 assert.match(map,/engine.current\?\.routes\(routes,focusRoutes,routeViewRequest\)/);
 assert.doesNotMatch(map,/data.systems.forEach\(\(s,i\)=>\{if\(focused&&!routeIds/);
});
