import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {buildStarMap,distanceLightyears,renderPosition,securityBand,METRES_PER_LIGHTYEAR} from '../lib/star-map.mjs';
const region={_key:10000001,name:{en:'Region',zh:'星域'}};
const row=(id,x=0)=>({_key:id,name:{en:'System',zh:'星系'},regionID:region._key,position:{x,y:0,z:0},securityStatus:.5});
test('star map uses true metre coordinates, not schematic positions, and converts lightyears accurately',()=>{
  const a=row(30000001),b=row(30000002,METRES_PER_LIGHTYEAR);b.position2D={x:999,y:999};
  const map=buildStarMap([a,b],[region],[],[]);
  assert.equal(distanceLightyears(map.systems[0],map.systems[1]),1);
  assert.deepEqual(renderPosition({...map.systems[1],z:METRES_PER_LIGHTYEAR}),[1,0,-1]);
  assert.equal(distanceLightyears(map.systems[0],map.systems[0]),0);
  assert.equal(map.systems[1].x,METRES_PER_LIGHTYEAR);
  assert.equal(map.serenityVerified,false);
});
test('star map excludes wormhole/abyssal IDs and deduplicates directed gates',()=>{
  const map=buildStarMap([row(30000001),row(30000002),row(31000001),row(32000001)],[region],[
    {solarSystemID:30000001,destination:{solarSystemID:30000002}},
    {solarSystemID:30000002,destination:{solarSystemID:30000001}},
    {solarSystemID:30000002,destination:{solarSystemID:31000001}},
    {solarSystemID:30000002,destination:{solarSystemID:30000002}},
  ],[]);
  assert.equal(map.systems.length,2);assert.deepEqual(map.gates,[[30000001,30000002]]);
});
test('star map fails on missing/invalid coordinates, duplicate IDs and missing regions',()=>{
  assert.throws(()=>buildStarMap([row(30000001),row(30000001)],[region],[],[]),/duplicate/);
  assert.throws(()=>buildStarMap([{...row(30000001),position:{x:NaN,y:0,z:0}}],[region],[],[]),/coordinates/);
  assert.throws(()=>buildStarMap([row(30000001)],[],[],[]),/region/);
  assert.throws(()=>buildStarMap([],[],[],[]),/no known/);
});
test('security colors follow displayed high/low/null boundaries',()=>{
  assert.equal(securityBand(.45),'high');assert.equal(securityBand(.449),'low');
  assert.equal(securityBand(.001),'low');assert.equal(securityBand(0),'null');assert.equal(securityBand(-1),'null');
});
test('navigation is isolated: sidebar entry, read-only snapshot, no business migrations or ESI on viewing',()=>{
  const route=readFileSync(new URL('../app/api/data/star-map/route.ts',import.meta.url),'utf8');
  assert.doesNotMatch(route,/ensureSchema|DatabaseSync|fetch\(|writeFile/);
  assert.match(route,/status:503/);
  const sidebar=readFileSync(new URL('../app/tool-sidebar.tsx',import.meta.url),'utf8');
  assert.match(sidebar,/href: "\/navigation", label: "星际导航"/);
  const client=readFileSync(new URL('../app/navigation/star-map.tsx',import.meta.url),'utf8');
  assert.match(client,/controls\.dispose\(\)/);assert.match(client,/observer\.disconnect\(\)/);assert.match(client,/renderer\.dispose\(\)/);
  const page=readFileSync(new URL('../app/navigation/page.tsx',import.meta.url),'utf8');
  assert.match(page,/if\(!desktop\|\|data\)return/);
  assert.match(page,/min-width: 701px/);
  assert.match(page,/desktop===true&&/);
  assert.match(page,/api\/navigation\/catalog/);
  assert.match(page,/手机端不加载星图/);
});
