import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';

const page=readFileSync(new URL('../app/sync-v2/page.tsx',import.meta.url),'utf8');
const policy=readFileSync(new URL('../app/sync-v2/lp-policy-panel.tsx',import.meta.url),'utf8');
const css=readFileSync(new URL('../app/sync-v2/sync-v2.css',import.meta.url),'utf8');
const schedule=readFileSync(new URL('../app/sync-v2/schedule-editor.tsx',import.meta.url),'utf8');
test('V2 UI preserves task polling, authentication and control payloads',()=>{
  assert.match(page,/setInterval\(\(\)=>void refresh\(\),10000\)/);
  assert.match(page,/sessionStorage\.getItem\('v2-admin-token'\)/);
  assert.match(page,/'x-sync-admin-token':token/);
  assert.match(page,/JSON\.stringify\(\{module,action,\.\.\.extra\}\)/);
  for(const action of ['start','pause','restart'])assert.match(page,new RegExp(`control\\(task.module,'${action}'\\)`));
  assert.match(page,/automatic:event.target.checked/);
  assert.match(page,/onSave=\{cron=>control\(task.module,'configure',\{cron\}\)\}/);
  assert.match(schedule,/scheduleToCron\(schedule\)/);
  assert.match(page,/debug:event.target.checked/);
});
test('V2 LP maintenance preserves filtering, confirmation, flags and pagination',()=>{
  assert.match(policy,/page:String\(nextPage\),q:search,is_blocked:blocked/);
  assert.match(policy,/if\(!confirm\(/);
  assert.match(policy,/corporation_id:row.corporation_id,offer_id:row.offer_id,changes:\{\[field\]:value\}/);
  assert.match(policy,/\['is_high_sec','is_blocked','is_guard','is_invalid'\]/);
  assert.match(policy,/page\*50>=total/);
  assert.match(policy,/load\(page-1\)/);assert.match(policy,/load\(page\+1\)/);
});
test('V2 UI has scoped responsive styles, labelled controls and no hardcoded credential',()=>{
  assert.match(page,/import '.\/sync-v2.css'/);
  assert.match(page,/className="v2-sync-page"/);
  assert.match(page,/role="progressbar"/);
  assert.match(page,/SYNC_ADMIN_TOKEN/);
  assert.doesNotMatch(page,/value=['"]admin['"]|localStorage|prompt\(/);
  assert.match(css,/max-width: 1160px/);assert.match(css,/max-width: 760px/);
  assert.match(css,/focus-visible/);assert.match(css,/prefers-reduced-motion/);
  assert.doesNotMatch(css,/(?:^|\})\s*(?:body|h1|main|button|input|select|table)\s*\{/m);
});
