import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {PerspectiveCamera,Vector3} from 'three';
import {compassDirections,mapViewLabel,MAP_VIEWS} from '../lib/star-map-orientation.mjs';
const near=(a,b)=>assert.ok(Math.abs(a-b)<.001,`${a} differs from ${b}`);
test('top view has fixed east-right north-up and physical above/below depth',()=>{
  const camera=new PerspectiveCamera();camera.up.set(0,1,0);camera.position.set(...MAP_VIEWS.top.offset);camera.lookAt(0,0,0);
  const d=Object.fromEntries(compassDirections(camera.quaternion.toArray()).map(d=>[d.name,d]));
  near(d['东'].x,1);near(d['北'].y,-1);near(d['南'].y,1);near(d['上'].depth,1);near(d['下'].depth,-1);
  assert.equal(mapViewLabel(camera.position.toArray()),'上方俯视');
});
test('front/back do not silently mirror compass; labels follow actual camera quaternion',()=>{
  for(const view of ['front','back']){
    const camera=new PerspectiveCamera();camera.position.set(0,0,view==='front'?1:-1);camera.lookAt(new Vector3());
    const d=Object.fromEntries(compassDirections(camera.quaternion.toArray()).map(d=>[d.name,d]));
    near(d['上'].y,-1);near(d['东'].x,view==='front'?1:-1);
    assert.equal(mapViewLabel(camera.position.toArray()),view==='front'?'南侧 · 正面':'北侧 · 背面');
    assert.equal(new Set(Object.keys(d)).size,6);
  }
});
test('only one reset preset remains and initial/fitted map views share its north-up top orientation',()=>{
  assert.deepEqual(Object.keys(MAP_VIEWS),['top']);assert.equal(MAP_VIEWS.top.name,'回正');
  const map=readFileSync(new URL('../app/navigation/star-map.tsx',import.meta.url),'utf8');
  assert.match(map,/const reset=.*placeCamera\(viewCenter,/);assert.match(map,/direction\?\?new THREE.Vector3\(\.\.\.MAP_VIEWS.top.offset/);
  assert.match(map,/createMapCompass\(\(\)=>engine.current\?\.reset\(\)/);
  assert.match(map,/top:reset/);
  assert.match(map,/viewRadius=routeView\?fitRadius:radius;placeCamera\(viewCenter,Math.max\(3,viewRadius\*2.7/);
  const compass=readFileSync(new URL('../app/navigation/map-compass.ts',import.meta.url),'utf8');
  assert.match(compass,/默认缩放/);assert.doesNotMatch(compass,/保留观察中心/);
  assert.doesNotMatch(map,/new THREE.Vector3\(\.15,\.65,\.85\)/);
  for(const file of ['page.tsx','jump/page.tsx']){
    const page=readFileSync(new URL('../app/navigation/'+file,import.meta.url),'utf8');assert.doesNotMatch(page,/className="nav-view-controls"/);
  }
});
