import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {mapPointerGesture,mapCanvasCursor,containMapGestures} from '../lib/star-map-input.mjs';
import {MAP_CURSORS} from '../lib/star-map-cursors.mjs';
const pointer=(x=10,y=10,button=0,pointerId=1)=>({clientX:x,clientY:y,button,pointerId});
test('pixel cursor distinguishes crosshair, press and real drag without sticking after cancellation',()=>{
  const canvas={style:{},dataset:{}},cursor=mapCanvasCursor(canvas);
  assert.equal(canvas.style.cursor,MAP_CURSORS.crosshair);
  for(const buttons of [1,4,5]){
    const event={buttons,pointerType:'mouse',clientX:10,clientY:10};
    cursor.buttons(event);assert.equal(canvas.style.cursor,MAP_CURSORS.pressed);
    cursor.buttons({...event,clientX:14});assert.equal(canvas.style.cursor,MAP_CURSORS.pressed);
    cursor.buttons({...event,clientX:30});assert.equal(canvas.style.cursor,MAP_CURSORS.dragging);
    cursor.buttons(event);assert.equal(canvas.style.cursor,MAP_CURSORS.dragging);
    cursor.release();assert.equal(canvas.style.cursor,MAP_CURSORS.crosshair);
  }
  cursor.buttons({buttons:2,pointerType:'mouse'});assert.equal(canvas.style.cursor,MAP_CURSORS.crosshair);
  cursor.buttons({buttons:1,pointerType:'touch'});assert.equal(canvas.style.cursor,MAP_CURSORS.crosshair);
  cursor.buttons({buttons:1,pointerType:'mouse',clientX:1,clientY:1});cursor.reset();assert.equal(canvas.style.cursor,MAP_CURSORS.crosshair);
  assert.equal(canvas.dataset.mapCursor,'crosshair');
  for(const css of Object.values(MAP_CURSORS)){
    assert.match(css,/16 16,/);assert.match(decodeURIComponent(css),/shape-rendering="crispEdges"/);
    assert.match(decodeURIComponent(css),/width="32" height="32"/);
  }
});
test('click tracking separates left/right clicks, true drags and out-and-back movement',()=>{
  const g=mapPointerGesture();g.start(pointer());assert.deepEqual(g.finish(pointer()),{button:0,x:10,y:10});
  g.start(pointer(10,10,2));assert.equal(g.finish(pointer(11,11,2)).button,2);
  g.start(pointer());g.move(pointer(40));g.move(pointer());assert.equal(g.finish(pointer()),null);
  g.start(pointer(10,10,2));g.move(pointer(40,10,2));g.move(pointer(10,10,2));assert.equal(g.finish(pointer(10,10,2)),null);
  g.start(pointer());assert.equal(g.finish(pointer(40)),null);
});
test('cancelled, mismatched and middle-button gestures never select a system',()=>{
  const g=mapPointerGesture();g.start(pointer());g.cancel();assert.equal(g.finish(pointer()),null);
  g.start(pointer());assert.equal(g.finish(pointer(10,10,0,2)),null);
  g.start(pointer(10,10,1));assert.equal(g.finish(pointer(10,10,1)),null);
  g.start({...pointer(),isPrimary:false});assert.equal(g.finish(pointer()),null);
});
test('canvas guards cancel native wheel/context/select/drag defaults and fully clean up',()=>{
  const canvas=new EventTarget(),outside=new EventTarget(),release=containMapGestures(canvas);
  for(const type of ['wheel','contextmenu','selectstart','dragstart','pointerdown','auxclick','mousedown']){
    const event=new Event(type,{cancelable:true});Object.assign(event,{button:2});canvas.dispatchEvent(event);assert.equal(event.defaultPrevented,true,type);
  }
  const ordinary=new Event('mousedown',{cancelable:true});Object.assign(ordinary,{button:0});canvas.dispatchEvent(ordinary);assert.equal(ordinary.defaultPrevented,false);
  const external=new Event('wheel',{cancelable:true});outside.dispatchEvent(external);assert.equal(external.defaultPrevented,false);
  release();const after=new Event('wheel',{cancelable:true});canvas.dispatchEvent(after);assert.equal(after.defaultPrevented,false);
});
test('map panning no longer uses the right mouse button; gesture guards dispose on unmount',()=>{
  const source=readFileSync(new URL('../app/navigation/star-map.tsx',import.meta.url),'utf8');
  assert.match(source,/LEFT:THREE.MOUSE.PAN,MIDDLE:THREE.MOUSE.ROTATE,RIGHT:null/);
  assert.match(source,/releaseGestureGuards\(\)/);assert.match(source,/pointerGesture.move\(e\)/);
  assert.match(source,/removeEventListener\('pointercancel',pointerCancel\)/);
});
