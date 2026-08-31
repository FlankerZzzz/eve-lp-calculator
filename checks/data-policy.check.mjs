import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import {
  HIDDEN_CORPORATIONS,
  HIDDEN_CORPORATION_SQL,
  HIDDEN_FACTIONS,
  HIDDEN_FACTION_SQL,
  isGloballyExcludedCorporation,
  visibleCorporationSql,
} from "../lib/data-policy.ts";

test("全局无效实体登记包含稳定 ID、名称与原因且没有重复", () => {
  assert.deepEqual(HIDDEN_FACTIONS.map(entity => entity.id), [500013, 500017, 500026]);
  assert.deepEqual(HIDDEN_CORPORATIONS.map(entity => entity.id), [1000283, 1000284, 1000285, 1000286]);
  const entities = [...HIDDEN_FACTIONS, ...HIDDEN_CORPORATIONS];
  assert.equal(new Set(entities.map(entity => entity.id)).size, entities.length);
  assert.ok(entities.every(entity => entity.name.trim() && entity.reason.trim()));
  assert.equal(isGloballyExcludedCorporation(1000283, 500003), true);
  assert.equal(isGloballyExcludedCorporation(2000001, 500013), true);
  assert.equal(isGloballyExcludedCorporation(2000001, 500003), false);
  assert.equal(isGloballyExcludedCorporation(2000001, null), false);
  assert.match(visibleCorporationSql("corp"), /corp\.faction_id IS NULL/);
});

test("只有排除来源引用的物品才无效，共享物品继续保留", () => {
  const db = new DatabaseSync(":memory:");
  db.exec(`
    CREATE TABLE corporations (corporation_id INTEGER PRIMARY KEY, faction_id INTEGER);
    CREATE TABLE item_types (type_id INTEGER PRIMARY KEY);
    CREATE TABLE lp_offers (corporation_id INTEGER, offer_id INTEGER, type_id INTEGER);
    CREATE TABLE lp_offer_materials (corporation_id INTEGER, offer_id INTEGER, type_id INTEGER);
    CREATE TABLE blueprint_recipes (blueprint_type_id INTEGER PRIMARY KEY, product_type_id INTEGER);
    CREATE TABLE blueprint_materials (blueprint_type_id INTEGER, material_type_id INTEGER);
  `);
  const insertCorporation = db.prepare("INSERT INTO corporations VALUES (?, ?)");
  insertCorporation.run(1000283, 500003);
  insertCorporation.run(2000001, 500003);
  insertCorporation.run(2000002, 500013);
  for (let typeId = 1; typeId <= 7; typeId += 1) db.prepare("INSERT INTO item_types VALUES (?)").run(typeId);

  // 1：仅无效军团直接产出；2：无效军团与有效军团共享产出；7：仅有效军团产出。
  db.prepare("INSERT INTO lp_offers VALUES (1000283, 1, 1), (1000283, 2, 2), (2000001, 3, 2), (2000001, 4, 7)").run();
  // 3：仅无效势力军团的兑换材料；4：无效与有效来源共享的兑换材料。
  db.prepare("INSERT INTO lp_offers VALUES (2000002, 5, 99), (1000283, 6, 98), (2000001, 7, 97)").run();
  db.prepare("INSERT INTO lp_offer_materials VALUES (2000002, 5, 3), (1000283, 6, 4), (2000001, 7, 4)").run();
  // 5：仅无效来源的蓝图产品；6：仅无效来源的制造材料。
  db.prepare("INSERT INTO lp_offers VALUES (1000283, 8, 50), (1000283, 9, 60)").run();
  db.prepare("INSERT INTO blueprint_recipes VALUES (50, 5), (60, 61)").run();
  db.prepare("INSERT INTO blueprint_materials VALUES (60, 6)").run();

  const visibleCorporation = `c.faction_id NOT IN (${HIDDEN_FACTION_SQL}) AND c.corporation_id NOT IN (${HIDDEN_CORPORATION_SQL})`;
  const invalidCorporation = `(c.faction_id IN (${HIDDEN_FACTION_SQL}) OR c.corporation_id IN (${HIDDEN_CORPORATION_SQL}))`;
  const associatedWith = corporationRule => `(EXISTS (SELECT 1 FROM lp_offers o JOIN corporations c ON c.corporation_id=o.corporation_id WHERE o.type_id=t.type_id AND ${corporationRule})
    OR EXISTS (SELECT 1 FROM lp_offer_materials m JOIN corporations c ON c.corporation_id=m.corporation_id WHERE m.type_id=t.type_id AND ${corporationRule})
    OR EXISTS (SELECT 1 FROM blueprint_recipes b JOIN lp_offers o ON o.type_id=b.blueprint_type_id JOIN corporations c ON c.corporation_id=o.corporation_id WHERE b.product_type_id=t.type_id AND ${corporationRule})
    OR EXISTS (SELECT 1 FROM blueprint_materials bm JOIN lp_offers o ON o.type_id=bm.blueprint_type_id JOIN corporations c ON c.corporation_id=o.corporation_id WHERE bm.material_type_id=t.type_id AND ${corporationRule}))`;
  const rows = db.prepare(`SELECT t.type_id FROM item_types t WHERE ${associatedWith(invalidCorporation)} AND NOT ${associatedWith(visibleCorporation)} ORDER BY t.type_id`).all();
  assert.deepEqual(rows.map(row => row.type_id), [1, 3, 5, 6]);
  db.close();
});
