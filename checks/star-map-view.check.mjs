import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {mapPosition,jumpStopGuide,MAP_POINT_SIZES} from '../lib/star-map-view.mjs';
import {distanceLightyears,METRES_PER_LIGHTYEAR as LY} from '../lib/star-map.mjs';
test('2D is a display-only XZ projection; real height and jump distance stay unchanged',()=>{
  const a={x:0,y:0,z:0},b={x:3*LY,y:12*LY,z:4*LY};
  assert.deepEqual(mapPosition(b,'3d'),[3,12,-4]);assert.deepEqual(mapPosition(b,'2d'),[3,0,-4]);
  assert.ok(Math.abs(distanceLightyears(a,b)-13)<1e-10);assert.equal(b.y,12*LY);
});
test('stop guide connects every checkpoint in order and preserves repeated visits without overlapping duplicate labels',()=>{
  const guide=jumpStopGuide(1,[2,3,2,1],4,2);
  assert.deepEqual(guide.ids,[1,2,3,2,1,4]);assert.equal(guide.points.length,4);
  assert.deepEqual(guide.points.find(p=>p.id===2).indices,[1,3]);assert.equal(guide.points.find(p=>p.id===2).visited,false);
  assert.equal(guide.points.find(p=>p.id===3).visited,true);assert.match(guide.points.find(p=>p.id===1).label,/A.*经停 4/);
  assert.match(guide.points.find(p=>p.id===2).label,/经停 1 ✓.*经停 3/);
  assert.deepEqual(jumpStopGuide(1,[],2).ids,[1,2]);
});
test('2D uses orthographic rendering, rotation lock and flattened coordinates across map layers',()=>{
  const map=readFileSync(new URL('../app/navigation/star-map.tsx',import.meta.url),'utf8');
  assert.match(map,/flat\?new THREE.OrthographicCamera/);assert.match(map,/controls.enableRotate=!flat/);
  assert.match(map,/renderPosition=\(s:StarSystem\)=>mapPosition\(s,dimension\)/);
  assert.match(map,/flat\?new THREE.CircleGeometry/);assert.match(map,/\[data,dimension,jumpOverlay,colorMode,environment\]/);
  assert.match(map,/jumpStopGuide\(overlay.origin/);assert.match(map,/jump-waypoint-label/);
});
test('all system markers are compact untextured squares without radial glow or additive bloom',()=>{
  const map=readFileSync(new URL('../app/navigation/star-map.tsx',import.meta.url),'utf8');
  assert.doesNotMatch(map,/createRadialGradient|CanvasTexture|AdditiveBlending|map:texture|texture.dispose/);
  assert.match(map,/blending:THREE.NormalBlending/);assert.match(map,/const material=nodeMaterial/);assert.match(map,/const markerMaterial=nodeMaterial/);assert.match(map,/const pointMaterial=nodeMaterial/);
  assert.ok(Object.values(MAP_POINT_SIZES).every(size=>size>=3&&size<=8));assert.ok(MAP_POINT_SIZES.destination>MAP_POINT_SIZES.base);
});
test('background gates interpolate endpoint security colors and remain separate from actual route overlays',()=>{
  const map=readFileSync(new URL('../app/navigation/star-map.tsx',import.meta.url),'utf8');
  assert.match(map,/color:0xffffff,vertexColors:true,transparent:true,opacity:\.28/);assert.match(map,/lineGeometry.setAttribute\('color',new THREE.BufferAttribute\(gateColors,3\)\)/);
  assert.match(map,/values.subarray\(lookup.get\(a\)/);assert.match(map,/values.subarray\(lookup.get\(b\)/);assert.match(map,/MODE_COLORS\[route.mode\]/);
});
