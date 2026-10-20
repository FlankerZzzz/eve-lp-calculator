import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {hoverCardPosition} from '../lib/star-map-hover.mjs';
test('hover card follows the cursor and flips before hitting map or viewport edges',()=>{
  const bounds={left:100,top:80,right:900,bottom:680},size={width:264,height:220};
  assert.deepEqual(hoverCardPosition({x:200,y:150},bounds,size),{x:216,y:166});
  assert.deepEqual(hoverCardPosition({x:880,y:660},bounds,size),{x:600,y:424});
  for(const x of [0,100,200,500,899,1200])for(const y of [0,80,150,500,679,900]){
    const point=hoverCardPosition({x,y},bounds,size);assert.ok(point.x>=110&&point.x+size.width<=890);assert.ok(point.y>=90&&point.y+size.height<=670);
  }
});
test('hover remains read-only, shows without an optional callback and cancels pending work on interaction',()=>{
  const map=readFileSync(new URL('../app/navigation/star-map.tsx',import.meta.url),'utf8');
  assert.match(map,/createStarHoverCard\(container\)/);assert.doesNotMatch(map,/if\(!extraCallbacks.current.onHover/);
  assert.match(map,/pointerType==='touch'/);assert.match(map,/window.clearTimeout\(hoverTimer\)/);assert.match(map,/controls.addEventListener\('change',cameraHover\)/);assert.match(map,/hoverTick=window.setTimeout\(updateHover,140\)/);
  const card=readFileSync(new URL('../app/navigation/star-hover-card.ts',import.meta.url),'utf8');assert.doesNotMatch(card,/fetch\(|innerHTML|onSelect|\.focus\(/);assert.match(card,/textContent=system.nameZh/);assert.match(card,/pointer|hoverCardPosition/);
});
