import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
test('navigation mode switch is shared inside both planner panels, not duplicated in the page header',()=>{
  const read=file=>readFileSync(new URL('../'+file,import.meta.url),'utf8');
  const regular=read('app/navigation/page.tsx'),jump=read('app/navigation/jump/page.tsx'),heading=read('app/navigation/planner-heading.tsx');
  assert.match(regular,/<aside className="nav-panel">\s*<PlannerHeading mode="regular"\/>/);
  assert.match(jump,/<aside className="nav-panel jump-panel">\s*<PlannerHeading mode="jump"\/>/);
  assert.doesNotMatch(regular,/旗舰跳跃规划 Demo →/);assert.doesNotMatch(jump,/<nav className="jump-tabs"/);
  assert.match(heading,/切换到旗舰导航/);assert.match(heading,/切换到常规导航/);assert.match(heading,/href=\{regular\?'\/navigation\/jump':'\/navigation'\}/);
});
