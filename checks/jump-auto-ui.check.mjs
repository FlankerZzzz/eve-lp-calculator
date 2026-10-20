import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
const page=readFileSync(new URL('../app/navigation/jump/page.tsx',import.meta.url),'utf8');
test('automatic entry keeps manual planning and uses a cancelable server request, not per-candidate network calls',()=>{
  assert.match(page,/jump-auto-calculate/);assert.match(page,/onClick=\{begin\}/);
  assert.match(page,/fetch\('\/api\/navigation\/jump\/auto',\{method:'POST'/);
  assert.match(page,/autoRequest.current\?\.abort\(\)/);assert.match(page,/\[autoDraftKey,cancelAutomatic\]/);
  assert.match(page,/generation===incursionGeneration.current/);assert.match(page,/inert=\{autoBusy\}/);
});
test('invasion status auto-updates, retries only on failure and never initiates upstream synchronization',()=>{
 assert.doesNotMatch(page,/刷新入侵信息/);
 assert.match(page,/incursionUnavailable&&<button/);
 assert.match(page,/aria-label="重试入侵信息"/);
 assert.match(page,/最近同步 \{time\(incursions\?\.fetched\?\?incursions\?\.modified\?\?null\)\}/);
 assert.match(page,/setInterval\(refresh,300000\)/);
 assert.match(page,/document.addEventListener\('visibilitychange',refresh\)/);
 assert.match(page,/document.removeEventListener\('visibilitychange',refresh\)/);
 assert.match(page,/if\(!document.hidden\)void refreshIncursions\(\)/);
 assert.match(page,/if\(incursionRequest.current\)return/);
 assert.match(page,/incursionRequest.current\?\.abort\(\)/);
 assert.match(page,/avoidPolicy\(avoid,incursions,autoClock\)/);
 assert.doesNotMatch(page,/fetch\([^\n]*(?:sync\/run|sync\/trigger|sync\/geography)/);
});
test('automatic route completion/copy respects independent invasion and NPC landing switches',()=>{
  assert.match(page,/plan.automatic&&plan.settingsKey!==settingsKey/);
  assert.match(page,/autoRouteIssues\(graph,leg,feed,avoid.avoidIncursions,clock\)/);
  assert.match(page,/autoStationIssues\(graph,leg,catalog\?\.stations,npcStationsOnly\)/);
  assert.match(page,/aria-pressed=\{npcStationsOnly\}/);
  assert.match(page,/settingsKey=JSON.stringify\(\[ship\?\.id,skills,npcStationsOnly\]\)/);
  assert.match(page,/plan\?\.automatic&&avoid.avoidIncursions&&/);
  assert.doesNotMatch(page,/autoLandingIssues/);
  assert.match(page,/feedIsCurrent\(incursions,75\*60000,autoClock\)/);
  assert.match(page,/setInterval\(\(\)=>setAutoClock\(Date.now\(\)\),60000\)/);
  assert.match(page,/leg.ids.some\(id=>!graph.systems.has\(id\)\)/);
  assert.match(page,/checkpointProgress\(nextPlan.origin,body.legs,nextPlan.waypoints\).remaining.length/);
  assert.match(page,/routeState.kind==='complete'&&graph&&plan\?formatJumpRoute/);
});
test('flagship gates have no route-preference controls and ignore obsolete saved strategies',()=>{
 assert.doesNotMatch(page,/setAllowGates/);
 assert.doesNotMatch(page,/name="jump-gate-mode"|过门路径偏好|setPreferences\(\{gateMode/);
 assert.match(page,/const gateMode='shortest'/);
 assert.match(page,/autoGateIssues\(graph,rows,route.destination,route.waypoints,route.origin\)/);
 assert.match(page,/JSON.stringify\(\{\.\.\.nextPlan,shipId:ship.id,skills,npcStationsOnly,avoid\}\)/);
 assert.match(page,/gateIssues\(body.legs,nextPlan\)/);
 assert.match(page,/gateIssues\(\[\.\.\.legs,leg\]\)/);
 assert.match(page,/plan.automatic\?gateIssues\(legs\):\[\]/);
 assert.match(page,/aria-label="仅计算有NPC空间站的星系"/);
});
test('only manual routes retain the 30-leg Demo limit',()=>{
 assert.match(page,/if\(!plan.automatic&&!plan.autoContinuation&&legs.length>=30\)/);
 assert.doesNotMatch(page,/body.legs.length\s*>\s*30/);
 assert.match(page,/不设 30 段自动路线上限/);
});
test('unreachable response preserves the prefix, selects its endpoint and enters manual continuation',()=>{
 assert.match(page,/const partial=body.complete===false/);
 assert.match(page,/body.interruptionAt!==previous/);
 assert.match(page,/automatic:false,autoContinuation:true,interruptionAt:previous/);
 assert.match(page,/setSelected\(graph.systems.get\(partial\?previous:nextPlan.origin\)\)/);
 assert.match(page,/plan\?\.autoContinuation&&/);
});
