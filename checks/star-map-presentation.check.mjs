import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {cameraFlightPose,constellationView,mapGeography,nameTierWeights,layoutMapNames} from '../lib/star-map-presentation.mjs';
import {buildStarMap,METRES_PER_LIGHTYEAR as LY} from '../lib/star-map.mjs';
test('map export attaches validated constellation names and IDs without changing coordinates',()=>{
  const region={_key:1,name:{en:'Region'}},group={_key:2,regionID:1,name:{en:'Constellation',zh:'星座甲'}},row={_key:30000001,regionID:1,constellationID:2,name:{en:'System'},securityStatus:.5,position:{x:LY,y:2*LY,z:3*LY}};
  const map=buildStarMap([row],[region],[],[],[group]);
  assert.equal(map.systems[0].constellationId,2);assert.equal(map.systems[0].constellationName,'星座甲');assert.equal(map.systems[0].y,2*LY);
  assert.throws(()=>buildStarMap([row],[region],[],[],[{...group,regionID:9}]),/constellation/);
  assert.throws(()=>buildStarMap([row],[region],[],[],[{...group,_key:3}]),/constellation/);
  assert.equal(buildStarMap([row],[region],[],[]).systems[0].constellationId,undefined,'legacy maps do not fabricate names');
});
test('station counts are explicit SDE data, deduplicated and optional for legacy maps',()=>{
  const region={_key:1,name:{en:'Region'}},row={_key:30000001,regionID:1,name:{en:'System'},securityStatus:.5,position:{x:0,y:0,z:0}},station={_key:60000001,solarSystemID:30000001};
  assert.equal(buildStarMap([row],[region],[],[],[],[station,{...station,_key:60000002}]).systems[0].npcStationCount,2);
  assert.equal(buildStarMap([row],[region],[],[],[],[]).systems[0].npcStationCount,0);assert.equal(buildStarMap([row],[region],[],[]).systems[0].npcStationCount,undefined);
  assert.throws(()=>buildStarMap([row],[region],[],[],[],[station,station]),/duplicate NPC/);assert.throws(()=>buildStarMap([row],[region],[],[],[],[{...station,solarSystemID:NaN}]),/NPC station/);
});
test('camera flight has eased bounded progress with exact endpoints and smooth logarithmic zoom',()=>{
  const from={target:[0,10,20],distance:100},to={target:[50,0,0],distance:4};
  assert.deepEqual(cameraFlightPose(from,to,0).target,from.target);assert.deepEqual(cameraFlightPose(from,to,1).target,to.target);
  assert.ok(Math.abs(cameraFlightPose(from,to,1).distance-4)<1e-10);
  assert.ok(cameraFlightPose(from,to,.05).target[0]<1);assert.ok(cameraFlightPose(from,to,.95).target[0]>49);
  let previous=from.distance;for(let i=0;i<=100;i++){const p=cameraFlightPose(from,to,i/100);assert.ok(p.distance<=previous+1e-10&&p.distance>=4-1e-10);previous=p.distance;assert.ok(p.target[0]>=0&&p.target[0]<=50);}
  assert.deepEqual(cameraFlightPose(from,to,-1).target,from.target);assert.deepEqual(cameraFlightPose(from,to,2).target,to.target);
});
test('click focus centers selected star and frames only its real constellation in either dimension',()=>{
  const a={id:1,constellationId:10,x:0,y:0,z:0},b={id:2,constellationId:10,x:3*LY,y:12*LY,z:4*LY},c={id:3,constellationId:20,x:100*LY,y:100*LY,z:100*LY};
  const view=constellationView(a,[a,b,c]);assert.deepEqual(view.target,[0,0,-0]);assert.ok(Math.abs(view.distance-13*2.8)<1e-10);
  assert.ok(Math.abs(constellationView(a,[a,b,c],'2d').distance-5*2.8)<1e-10);assert.ok(constellationView(a,[a,b],'3d',.5).distance>view.distance);
  assert.equal(constellationView({...a,constellationId:undefined},[a,b,c]).distance,6);assert.equal(b.y,12*LY);
});
test('geography aggregation separates regions and constellations and supports legacy snapshots',()=>{
  const systems=[{id:1,regionId:1,regionName:'星域',constellationId:2,constellationName:'星座',x:0,y:4*LY,z:0},{id:2,regionId:1,regionName:'星域',constellationId:2,constellationName:'星座',x:2*LY,y:0,z:2*LY}];
  const groups=mapGeography(systems);assert.equal(groups.length,2);assert.deepEqual(groups[0].position,[1,2,-1]);assert.equal(groups[1].count,2);
  assert.deepEqual(mapGeography(systems,'2d')[1].position,[1,0,-1]);assert.equal(mapGeography([{...systems[0],constellationId:undefined}]).length,1);
});
test('geographic labels crossfade continuously across region/constellation/system scales',()=>{
  assert.ok(nameTierWeights(100).region>.8);assert.equal(nameTierWeights(100).system,0);assert.ok(nameTierWeights(15).constellation>.8);assert.equal(nameTierWeights(2).system,1);assert.equal(nameTierWeights(2).region,0);
  for(let span=1;span<100;span+=.1){const a=nameTierWeights(span),b=nameTierWeights(span+.01);for(const key of Object.keys(a)){assert.ok(a[key]>=0&&a[key]<=1);assert.ok(Math.abs(a[key]-b[key])<.02);}}
});
test('name layout bounds label counts, avoids map controls/edges and overlapping names, prioritizes selection',()=>{
  const a={key:'a',priority:1,x:50,y:50,width:50,height:20,opacity:1},b={...a,key:'b',priority:-1},offscreen={...a,key:'edge',x:-5},blocked={...a,key:'blocked',x:160};
  assert.deepEqual(layoutMapNames([a,b,offscreen,blocked],300,300,[{x:150,y:0,width:100,height:100}]).map(n=>n.key),['b']);
  const many=Array.from({length:200},(_,i)=>({...a,key:String(i),x:10+i%20*80,y:10+Math.floor(i/20)*50}));assert.equal(layoutMapNames(many,2000,2000).length,72);assert.equal(a.x,50);
});
test('selection uses interruptible local camera flight; labels are bounded noninteractive overlays and cleaned up',()=>{
  const map=readFileSync(new URL('../app/navigation/star-map.tsx',import.meta.url),'utf8'),names=readFileSync(new URL('../app/navigation/map-names.ts',import.meta.url),'utf8');
  assert.match(map,/focus:focusSystem/);assert.match(map,/controls.addEventListener\('start',stopFlight\)/);assert.match(map,/prefers-reduced-motion: reduce/);assert.match(map,/mapNames.dispose\(\)/);assert.match(map,/controls.removeEventListener\('start',stopFlight\)/);
  assert.match(names,/layoutMapNames\(/);assert.match(names,/aria-hidden','true'/);assert.doesNotMatch(names,/fetch\(|innerHTML/);
});
