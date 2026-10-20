import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {DEFAULT_STAR_COLOR_MODE,STAR_COLOR_MODES,STAR_SECURITY_LEGEND,STAR_SECURITY_CSS_VARS,STAR_SECURITY_COLORS,securityColorLevel,securityTextStyle,normalizeStarColorMode,starMapColor,starColorLegend,starColorNotice} from '../lib/star-map-colors.mjs';
test('star colors default to security and expose only the confirmed mode',()=>{
  assert.equal(DEFAULT_STAR_COLOR_MODE,'security');assert.deepEqual(STAR_COLOR_MODES,[{id:'security',label:'安全等级'},{id:'incursion',label:'入侵星系'}]);
  for(const mode of ['faction','region','future','',undefined,null])assert.equal(normalizeStarColorMode(mode),'security');
});
test('eleven security steps share one palette for stars, text and the descending legend',()=>{
  assert.equal(STAR_SECURITY_LEGEND.length,11);assert.equal(new Set(STAR_SECURITY_COLORS).size,11);
  assert.deepEqual(STAR_SECURITY_COLORS,['#f00000','#d73000','#f04800','#f06000','#d77700','#efef00','#8fef2f','#00f000','#48f0c0','#2fefef','#3399ff']);
  for(const item of STAR_SECURITY_LEGEND){assert.equal(starMapColor({security:item.level/10}),item.color);assert.equal(securityTextStyle(item.level/10).color,item.color);}
  assert.deepEqual(STAR_SECURITY_LEGEND.map(item=>item.level),[10,9,8,7,6,5,4,3,2,1,0]);
  assert.equal(STAR_SECURITY_CSS_VARS['--nav-security-null'],'#f00000');
});
test('color rounding matches displayed security without changing highsec boundaries or distances',()=>{
  for(const [security,level] of [[1,10],[.95,10],[.949,9],[.85,9],[.55,6],[.45,5],[.449,4],[.05,1],[.001,1],[0,0],[-.1,0],[-1,0],[2,10]]){
    assert.equal(securityColorLevel(security),level);assert.equal(starMapColor({security},'region'),STAR_SECURITY_COLORS[level]);
  }
  for(const path of ['page.tsx','jump/page.tsx']){
    const page=readFileSync(new URL('../app/navigation/'+path,import.meta.url),'utf8');assert.match(page,/style=\{securityTextStyle\(/);
  }
});
test('zero/negative security is red across stars, legend and text without changing security rules',()=>{
  for(const security of [0,-.01,-.5,-1])assert.equal(starMapColor({security}),'#f00000');
  const css=readFileSync(new URL('../app/navigation/navigation.css',import.meta.url),'utf8');
  assert.match(css,/\.navigation-page \.null,\.navigation-page \.nav-system-card dd.null\{color:var\(--nav-security-null\)\}/);
  for(const path of ['page.tsx','jump/page.tsx']){
    const page=readFileSync(new URL('../app/navigation/'+path,import.meta.url),'utf8');assert.match(page,/style=\{STAR_SECURITY_CSS_VARS as React.CSSProperties\}/);
  }
});
test('both maps place a shared color bar below the map, not on mobile or in the old sidebar',()=>{
  for(const path of ['page.tsx','jump/page.tsx']){
    const page=readFileSync(new URL('../app/navigation/'+path,import.meta.url),'utf8');
    assert.match(page,/desktop===true&&<MapColorBar mode=\{colorMode\} onChange=\{setColorMode\}/);
    assert.match(page,/useState\(DEFAULT_STAR_COLOR_MODE\)/);assert.doesNotMatch(page,/>星点着色|value="region"/);
  }
  const map=readFileSync(new URL('../app/navigation/star-map.tsx',import.meta.url),'utf8');assert.match(map,/c.set\(starMapColor\(s,mode,extraCallbacks.current.environment\)\)/);assert.match(map,/\[data,dimension,colorMode,environment,focusRoutes,routes\]/);assert.doesNotMatch(map,/setHSL/);
});
test('incursion is red versus cyan and the removed faction mode falls back to security',()=>{
  const meta={modified:new Date().toISOString(),stale:false},environment={incursions:{...meta,ids:[1]},sovereignty:{...meta,rows:[{system_id:1,faction_id:500001},{system_id:2,faction_id:500002},{system_id:3,alliance_id:99000001},{system_id:4}],names:[{id:500001,name:'测试势力',category:'faction'}]}};
  assert.equal(starMapColor({id:1},'incursion',environment),'#ff3b30');assert.equal(starMapColor({id:2},'incursion',environment),'#2fefef');assert.equal(starMapColor({security:1}),'#3399ff');
  assert.equal(starMapColor({id:1,security:1},'faction',environment),'#3399ff');
  assert.equal(starColorLegend('faction'),STAR_SECURITY_LEGEND);assert.equal(starColorNotice('faction',environment),'');
  assert.match(starColorNotice('incursion',null),/不可用/);assert.match(starColorNotice('incursion',{incursions:{...meta,stale:true,ids:[1]}}),/上次缓存/);
  assert.equal(starColorLegend('incursion').length,2);
  assert.equal(starMapColor({id:1},'incursion',{incursions:{ids:{}}}),'#2fefef');
  const map=readFileSync(new URL('../app/navigation/star-map.tsx',import.meta.url),'utf8');
  assert.match(map,/size:MAP_POINT_SIZES.incursion/);assert.match(map,/lineMaterial.opacity=mode==='incursion'\?\.08:\.28/);
  assert.match(map,/invaded.has\(s.id\)&&\(!focused\|\|routeIds.has\(s.id\)\)/);assert.match(map,/invadedGeometry.dispose\(\);invadedMaterial.dispose\(\)/);
  assert.match(map,/material.opacity=starBackgroundOpacity\(container.dataset.colorMode,hasJumpOverlay\)/);
  assert.match(map,/clearJump\(\);hasJumpOverlay=!!overlay;updateStarAppearance\(\)/);
  assert.doesNotMatch(map,/material.opacity=overlay/);
});
test('incursion dimming takes precedence over jump overlays and restores their normal dimming',async()=>{
  const {starBackgroundOpacity}=await import('../lib/star-map-colors.mjs');
  for(const overlay of [false,true])assert.equal(starBackgroundOpacity('incursion',overlay),.18);
  for(const mode of ['security','faction']){
    assert.equal(starBackgroundOpacity(mode,false),1);
    assert.equal(starBackgroundOpacity(mode,true),.3);
  }
});
