import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
test('both navigation maps reserve the upper-left corner for search instead of decorative headings',()=>{
  for(const file of ['page.tsx','jump/page.tsx']){
    const source=readFileSync(new URL(`../app/navigation/${file}`,import.meta.url),'utf8');
    assert.match(source,/<MapSystemSearch /);assert.doesNotMatch(source,/className="nav-map-heading"/);
    assert.doesNotMatch(source,/className="jump-map-legend"/,'route hints must not overlap the compass');
    assert.doesNotMatch(source,/className="nav-map-toolbar-title"/,'map toolbar keeps actions without descriptive title blocks');
    assert.match(source,/<MapDimensionControl value=\{dimension\} onChange=\{setDimension\}/);
    assert.match(source,/<StarMap ref=\{controls\} dimension=\{dimension\}/);
  }
  const css=readFileSync(new URL('../app/navigation/navigation.css',import.meta.url),'utf8');
  assert.match(css,/\.nav-map-search\{position:absolute;top:24px;left:20px;/);
  assert.match(css,/\.navigation-page \.nav-map-compass\{top:132px;left:20px;right:auto\}/);
  assert.match(css,/@media\(max-width:700px\)\{\.nav-map-search\{display:none\}\}/);
  assert.match(css,/opacity:\.65;border:0;box-shadow:none/);assert.match(css,/:focus-within/);
  const compass=readFileSync(new URL('../app/navigation/map-compass.ts',import.meta.url),'utf8');
  assert.doesNotMatch(compass,/星图坐标方向|星图显示模式|createElement\('select'\)/);
  assert.match(css,/\.nav-selected-system \.nav-card-actions>\.jump-point-actions\{display:contents\}/);
  assert.match(css,/flex:1 1 auto;min-width:0;margin:0;padding:7px 3px;font-size:10px/);
  assert.match(css,/\.navigation-page \.nav-selected-system \.nav-selected-metrics\{grid-template-columns:repeat\(4,minmax\(0,1fr\)\)/);
});
