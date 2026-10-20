import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {npcStationLabel} from '../lib/star-hover-environment.mjs';
test('focused route table shares card terminology, SDE station formatting and never fabricates missing station zero',()=>{
  const page=readFileSync(new URL('../app/navigation/page.tsx',import.meta.url),'utf8'),api=readFileSync(new URL('../app/api/navigation/catalog/route.ts',import.meta.url),'utf8');
  for(const label of ['NPC空间站','过门次数','舰船击毁数','太空舱击毁数','NPC击毁数量'])assert.ok(page.includes(`<th>${label}`));
  assert.doesNotMatch(page,/<th>(过门|玩家船毁|舱毁|NPC毁)<\/th>/);assert.match(page,/npcStationLabel\(s\)/);assert.match(api,/npcStationCount/);
  assert.equal(npcStationLabel({npcStationCount:0}),'0 个');assert.equal(npcStationLabel({npcStationCount:18}),'18 个');assert.equal(npcStationLabel({}),'未核实');
  assert.match(page,/NPC空间站为 SDE 基线，不是一小时活动统计/);
});
