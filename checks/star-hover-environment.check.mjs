import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {starHoverEnvironment,feedWindowLabel,feedIsCurrent,npcStationLabel,RECENT_GEOGRAPHY_TITLE} from '../lib/star-hover-environment.mjs';
const now=Date.parse('2026-10-18T06:30:00Z'),meta={modified:new Date(now).toISOString(),fetched:new Date(now).toISOString(),stale:false,error:null};
const environment={systems:{1:{jumps:1200,ships:2,pods:0,npcs:56}},jumps:meta,kills:{...meta,modified:new Date(now-1200000).toISOString()},incursions:{...meta,ids:[1]}};
test('compact hover distinguishes confirmed invasion, confirmed absence and unavailable/stale invasion data',()=>{
  assert.equal(starHoverEnvironment(1,environment,now).invasion,true);assert.equal(starHoverEnvironment(2,environment,now).invasion,false);
  for(const inc of [null,{...environment.incursions,error:'HTTP 503'},{...environment.incursions,stale:true},{...environment.incursions,ids:null},{...environment.incursions,modified:new Date(now-600001).toISOString()}])assert.equal(starHoverEnvironment(1,{...environment,incursions:inc},now).invasion,null);
  assert.equal(starHoverEnvironment(1,null,now).invasion,null);assert.equal(feedIsCurrent({...meta,modified:new Date(now+120000).toISOString()},300000,now),false);
});
test('four independent activity values retain genuine zeros while missing/invalid data stays unknown',()=>{
  const view=starHoverEnvironment(1,environment,now);assert.deepEqual(view.metrics.map(m=>m.value),['1,200','2','0','56']);assert.equal(view.statisticsStale,false);
  const missing=starHoverEnvironment(2,environment,now);assert.deepEqual(missing.metrics.map(m=>m.value),['—','—','—','—']);assert.equal(missing.statisticsUnavailable,true);
  const invalid=starHoverEnvironment(1,{...environment,systems:{1:{jumps:-1,ships:NaN,pods:null,npcs:undefined}}},now);assert.equal(invalid.statisticsUnavailable,true);
});
test('both cards use exact shared geography terminology and never fabricate station zero from an old snapshot',()=>{
  assert.equal(RECENT_GEOGRAPHY_TITLE,'最近一小时的地理数据');assert.deepEqual(starHoverEnvironment(1,environment,now).metrics.map(m=>m.label),['过门次数','舰船击毁数','太空舱击毁数','NPC击毁数量']);
  assert.equal(npcStationLabel({npcStationCount:0}),'0 个');assert.equal(npcStationLabel({npcStationCount:3}),'3 个');assert.equal(npcStationLabel({}),'未核实');assert.equal(npcStationLabel({npcStationCount:-1}),'未核实');
  const page=readFileSync(new URL('../app/navigation/page.tsx',import.meta.url),'utf8'),selected=readFileSync(new URL('../app/navigation/selected-system-card.tsx',import.meta.url),'utf8');
  assert.match(page,/useMapEnvironment\(desktop===true\)/);assert.match(page,/environment=\{environment\}/);assert.match(selected,/starHoverEnvironment\(system.id,environment\)/);assert.match(selected,/npcStationLabel\(system\)/);assert.doesNotMatch(selected,/system.nameEn|星系 \/|activities\?/);
});
test('unavailable feed preserves previous numbers but clearly marks only that feed stale',()=>{
  const view=starHoverEnvironment(1,{...environment,jumps:{...meta,error:'failed'}},now);assert.deepEqual(view.metrics.map(m=>m.stale),[true,false,false,false]);assert.equal(view.statisticsStale,true);
  const old=starHoverEnvironment(1,environment,now+7200000);assert.ok(old.metrics.every(m=>m.stale));assert.equal(old.invasion,null);
});
test('each official one-hour window retains its own timestamp, timezone and date across midnight',()=>{
  const view=starHoverEnvironment(1,environment,now);assert.equal(view.jumpsWindow,'10/18 13:30–14:30');assert.equal(view.killsWindow,'10/18 13:10–14:10');
  assert.equal(feedWindowLabel({modified:'2026-10-17T16:30:00Z'}),'10/17 23:30–10/18 00:30');assert.equal(feedWindowLabel(null),'时间未知');
});
test('hover is compact, omits English/ID text, puts explicit red warning before the star name',()=>{
  const card=readFileSync(new URL('../app/navigation/star-hover-card.ts',import.meta.url),'utf8');assert.doesNotMatch(card,/system.nameEn|星系 ID|english.textContent|id.textContent/);assert.match(card,/title.append\(warning,name,security\)/);assert.match(card,/警告：入侵星系/);assert.match(card,/warning.hidden=view.invasion!==true/);assert.match(card,/cell.dataset.metric/);
  const css=readFileSync(new URL('../app/navigation/navigation.css',import.meta.url),'utf8');assert.match(css,/nav-tooltip-invasion\{color:#ff6963/);assert.match(css,/grid-template-columns:repeat\(4,minmax\(0,1fr\)\)/);
});
test('map environment is loaded in one cancellable database batch, never per hovered star',()=>{
  const api=readFileSync(new URL('../app/api/navigation/environment/route.ts',import.meta.url),'utf8'),hook=readFileSync(new URL('../app/navigation/use-map-environment.ts',import.meta.url),'utf8');
  assert.match(api,/Promise.all\(\[navigationFeed.load\('system_jumps'\)/);assert.match(api,/navigationFeed.load\('incursions'\)/);assert.match(api,/data.systems.map\(s=>s.id\)/);assert.doesNotMatch(api,/Database|writeFile|INSERT|fetch\(/);
  assert.match(hook,/api\/navigation\/environment/);assert.match(hook,/300000/);assert.match(hook,/abort.abort\(\)/);assert.match(hook,/document.hidden/);assert.doesNotMatch(hook,/onHover|systemId|setInterval.*1000\)/);
});
