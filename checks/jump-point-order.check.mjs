import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {moveWaypoint,assignNavigationPoint} from '../lib/waypoint-order.mjs';
const page=readFileSync(new URL('../app/navigation/jump/page.tsx',import.meta.url),'utf8');

test('flagship uses the same pointer/touch reorder component for endpoints and all intermediate points',()=>{
 assert.match(page,/<WaypointList points=\{points\}/);assert.match(page,/moveWaypoint\(rows,key,target\)/);
 assert.match(page,/const origin=points\[0\],destination=points\[points.length-1\]/);assert.match(page,/points.slice\(1,-1\)/);
 assert.match(page,/旗舰规划起点/);assert.match(page,/旗舰规划终点/);assert.match(page,/旗舰规划途经点/);
 const component=readFileSync(new URL('../app/navigation/waypoint-list.tsx',import.meta.url),'utf8');
 assert.match(component,/setPointerCapture/);assert.match(component,/onPointerCancel/);assert.match(component,/Escape/);assert.match(component,/inputLabel\?\.\(i,points.length\)/);
});

test('moving endpoints across duplicate or unfinished points preserves complete keyed point data',()=>{
 const points=[{key:1,id:10,text:'重复'},{key:3,id:10,text:'重复'},{key:4,id:null,text:'未选完'},{key:2,id:20,text:'终点'}];
 const moved=moveWaypoint(points,2,1);assert.deepEqual(moved.map(p=>p.key),[2,1,3,4]);assert.equal(moved[0],points[3]);assert.equal(moved.at(-1).id,null);
 assert.deepEqual(moveWaypoint(moved,2,4),points);assert.deepEqual(points.map(p=>p.key),[1,3,4,2]);
 const assigned=assignNavigationPoint(moved,{key:0,text:'新起点',id:30},'origin');assert.equal(assigned[0].key,2);assert.equal(assigned[0].id,30);
});

test('reordering invalidates previous results and cancels in-flight calculations without auto-planning',()=>{
 assert.match(page,/autoDraftKey=JSON.stringify\(\[origin.id,destination.id,waypoints.map\(p=>p.id\)/);
 assert.match(page,/JSON.stringify\(waypoints.map\(p=>p.id\)\)!==JSON.stringify\(plan.waypoints\)/);
 assert.match(page,/\[autoDraftKey,cancelAutomatic\]/);assert.match(page,/autoRequest.current\?\.abort\(\)/);
 assert.match(page,/onMove=\{\(key,target\)=>setPoints\(rows=>moveWaypoint\(rows,key,target\)\)\}/);
 assert.match(page,/rows.length>2\?rows.filter/);assert.match(page,/disabled=\{waypoints.length>=10\}/);
});
