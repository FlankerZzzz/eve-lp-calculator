import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
const page=readFileSync(new URL('../app/navigation/jump/page.tsx',import.meta.url),'utf8');
const css=readFileSync(new URL('../app/navigation/jump/jump.css',import.meta.url),'utf8');
test('compact range card keeps radius, units, fuel name and per-lightyear fuel without truncation',()=>{
  const card=page.slice(page.indexOf('<div className="jump-range">'),page.indexOf('<WaypointList'));
  for(const value of ['当前跳跃半径','parameters.range','光年','ship?.fuelName','parameters.fuelPerLy','单位 / 光年'])assert.ok(card.includes(value),value);
  assert.match(css,/\.jump-page \.jump-range\{display:grid;grid-template-columns:minmax\(0,1fr\) auto/);
  assert.match(css,/\.jump-page \.jump-range>span\{grid-column:1\/-1;line-height:1.5;overflow-wrap:anywhere/);
});
test('manual planning button uses requested copy while retaining the same begin action and restart state',()=>{
  assert.match(page,/className="nav-calculate jump-manual-calculate"[^\n]*onClick=\{begin\}>\{plan\?'重新开始':'手动规格线路'\}/);
  assert.doesNotMatch(page,/开始规划 \/ 画圈/);
  assert.match(page,/点击“手动规格线路”手动逐段选路/);
});
