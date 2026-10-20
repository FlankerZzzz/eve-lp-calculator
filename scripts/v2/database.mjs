import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { migrateLpFlags } from './lp-policy.mjs';

export function openV2(filename) {
  const path = resolve(filename);
  mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=15000;');
  db.exec(`
    CREATE TABLE IF NOT EXISTS items (
      type_id INTEGER PRIMARY KEY, name_zh TEXT, name_en TEXT, group_id INTEGER,
      volume REAL, packaged_volume REAL, blueprint_id INTEGER,
      in_serenity_catalog TEXT NOT NULL DEFAULT 'N' CHECK(in_serenity_catalog IN ('Y','N')),
      source TEXT NOT NULL CHECK(source IN ('SDE','ESI')), published INTEGER NOT NULL DEFAULT 0,
      sync_protected TEXT NOT NULL DEFAULT 'N' CHECK(sync_protected IN ('Y','N')), updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS recipes (
      blueprint_id INTEGER PRIMARY KEY REFERENCES items(type_id), product_type_id INTEGER NOT NULL UNIQUE REFERENCES items(type_id),
      product_quantity INTEGER NOT NULL CHECK(product_quantity>0), manufacturing_time INTEGER NOT NULL CHECK(manufacturing_time>=0),
      sync_protected TEXT NOT NULL DEFAULT 'N' CHECK(sync_protected IN ('Y','N')), updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS recipe_materials (
      blueprint_id INTEGER NOT NULL REFERENCES recipes(blueprint_id), material_type_id INTEGER NOT NULL REFERENCES items(type_id),
      quantity INTEGER NOT NULL CHECK(quantity>0), PRIMARY KEY(blueprint_id,material_type_id)
    );
    CREATE INDEX IF NOT EXISTS recipe_material_lookup ON recipe_materials(material_type_id);
    CREATE TABLE IF NOT EXISTS lp_exchange (
      corporation_id INTEGER NOT NULL, offer_id INTEGER NOT NULL, faction_id INTEGER,
      faction_name_zh TEXT, faction_name_en TEXT, corporation_name_zh TEXT NOT NULL, corporation_name_en TEXT,
      type_id INTEGER NOT NULL REFERENCES items(type_id), quantity INTEGER NOT NULL CHECK(quantity>0),
      lp_cost INTEGER NOT NULL, isk_cost REAL NOT NULL, ak_cost INTEGER NOT NULL DEFAULT 0,
      sync_protected TEXT NOT NULL DEFAULT 'N' CHECK(sync_protected IN ('Y','N')), updated_at TEXT NOT NULL,
      PRIMARY KEY(corporation_id,offer_id)
    );
    CREATE INDEX IF NOT EXISTS lp_exchange_type ON lp_exchange(type_id);
    CREATE TABLE IF NOT EXISTS lp_requirements (
      corporation_id INTEGER NOT NULL, offer_id INTEGER NOT NULL, material_type_id INTEGER NOT NULL REFERENCES items(type_id),
      quantity INTEGER NOT NULL CHECK(quantity>0), PRIMARY KEY(corporation_id,offer_id,material_type_id),
      FOREIGN KEY(corporation_id,offer_id) REFERENCES lp_exchange(corporation_id,offer_id)
    );
    CREATE INDEX IF NOT EXISTS lp_requirement_lookup ON lp_requirements(material_type_id);
    CREATE TABLE IF NOT EXISTS implant_sets (
      set_id TEXT PRIMARY KEY, name_zh TEXT NOT NULL, name_en TEXT, slot_1_type_id INTEGER NOT NULL,
      slot_2_type_id INTEGER NOT NULL, slot_3_type_id INTEGER NOT NULL, slot_4_type_id INTEGER NOT NULL,
      slot_5_type_id INTEGER NOT NULL, slot_6_type_id INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS corporation_sets (
      corporation_id INTEGER NOT NULL, faction_id INTEGER, set_id TEXT NOT NULL REFERENCES implant_sets(set_id),
      PRIMARY KEY(corporation_id,set_id)
    );
    CREATE TABLE IF NOT EXISTS station_mappings (
      location_id INTEGER PRIMARY KEY, system_name TEXT NOT NULL, mapping_name TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS orders (
      generation TEXT NOT NULL, order_id INTEGER NOT NULL, type_id INTEGER NOT NULL, location_id INTEGER NOT NULL,
      system_id INTEGER NOT NULL, is_buy_order INTEGER NOT NULL, price REAL NOT NULL, volume_remain INTEGER NOT NULL,
      volume_total INTEGER NOT NULL, min_volume INTEGER NOT NULL, range TEXT NOT NULL, issued TEXT NOT NULL,
      duration INTEGER NOT NULL, raw_json TEXT NOT NULL CHECK(json_valid(raw_json)), PRIMARY KEY(generation,order_id)
    );
    CREATE INDEX IF NOT EXISTS orders_type ON orders(generation,type_id,is_buy_order,price);
    CREATE INDEX IF NOT EXISTS orders_location ON orders(generation,location_id,type_id,is_buy_order,price);
    CREATE TABLE IF NOT EXISTS contracts (
      contract_id INTEGER PRIMARY KEY, raw_json TEXT NOT NULL CHECK(json_valid(raw_json)), generation TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS contract_items (
      contract_id INTEGER NOT NULL REFERENCES contracts(contract_id) ON DELETE CASCADE,
      record_id INTEGER NOT NULL, type_id INTEGER NOT NULL, is_included INTEGER NOT NULL, quantity INTEGER NOT NULL,
      raw_json TEXT NOT NULL CHECK(json_valid(raw_json)), PRIMARY KEY(contract_id,record_id)
    );
    CREATE INDEX IF NOT EXISTS contract_item_type ON contract_items(type_id,is_included,contract_id);
    CREATE TABLE IF NOT EXISTS history (
      type_id INTEGER NOT NULL, date TEXT NOT NULL, average REAL NOT NULL, highest REAL NOT NULL, lowest REAL NOT NULL,
      volume INTEGER NOT NULL, order_count INTEGER NOT NULL,
      sync_protected TEXT NOT NULL DEFAULT 'N' CHECK(sync_protected IN ('Y','N')), PRIMARY KEY(type_id,date)
    );
    CREATE INDEX IF NOT EXISTS history_date ON history(date,type_id);
    CREATE TABLE IF NOT EXISTS runtime_state (key TEXT PRIMARY KEY,value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS navigation_cache (
      kind TEXT PRIMARY KEY, payload TEXT CHECK(payload IS NULL OR json_valid(payload)),
      modified TEXT, fetched TEXT, attempted TEXT NOT NULL, error TEXT, version TEXT
    );
    CREATE TABLE IF NOT EXISTS navigation_samples (
      kind TEXT NOT NULL, window_end TEXT NOT NULL, fetched TEXT NOT NULL,
      payload TEXT NOT NULL CHECK(json_valid(payload)), PRIMARY KEY(kind,window_end)
    );
    CREATE INDEX IF NOT EXISTS navigation_samples_time ON navigation_samples(window_end);
    CREATE TABLE IF NOT EXISTS tasks (
      module TEXT PRIMARY KEY, automatic INTEGER NOT NULL DEFAULT 0, cron TEXT, status TEXT NOT NULL DEFAULT 'idle',
      run_id TEXT, processed INTEGER NOT NULL DEFAULT 0, remaining INTEGER NOT NULL DEFAULT 0,
      phase TEXT, error TEXT, last_success TEXT, updated_at TEXT NOT NULL, debug INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS checkpoints (module TEXT NOT NULL,run_id TEXT NOT NULL,key TEXT NOT NULL,PRIMARY KEY(module,run_id,key));
    CREATE TABLE IF NOT EXISTS quote_cache (type_id INTEGER PRIMARY KEY,buy_price REAL NOT NULL,sell_price REAL NOT NULL,buy_volume INTEGER NOT NULL,sell_volume INTEGER NOT NULL,collected_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS depth_cache (type_id INTEGER NOT NULL,side TEXT NOT NULL,level INTEGER NOT NULL,price REAL NOT NULL,volume INTEGER NOT NULL,collected_at TEXT NOT NULL,PRIMARY KEY(type_id,side,level));
    CREATE TABLE IF NOT EXISTS ranking_cache (list_kind TEXT NOT NULL,rank INTEGER NOT NULL,snapshot_date TEXT NOT NULL,calculated_at TEXT NOT NULL,payload TEXT NOT NULL,PRIMARY KEY(list_kind,rank));
    CREATE TABLE IF NOT EXISTS contract_cache (set_key TEXT PRIMARY KEY,payload TEXT NOT NULL,fetched_at TEXT NOT NULL,expires_at TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'ready',error_message TEXT);
  `);
  // Reuse the existing checkpoint store, not another permanent business table.
  if(!db.prepare('PRAGMA table_info(checkpoints)').all().some(column=>column.name==='payload')) {
    db.exec('ALTER TABLE checkpoints ADD COLUMN payload TEXT CHECK(payload IS NULL OR json_valid(payload));');
  }
  const now = new Date().toISOString();
  const insert = db.prepare('INSERT OR IGNORE INTO tasks(module,automatic,cron,updated_at) VALUES(?,?,?,?)');
  for (const [module, automatic, cron] of [['items',0,null],['catalog',0,null],['orders',1,'*/15 * * * *'],['contracts',1,'*/30 * * * *'],['history',1,'30 0 * * *'],['rankings',1,'0 9,15,18,21 * * *'],['geography',1,'0 * * * *']]) insert.run(module,automatic,cron,now);
  migrateLpFlags(db);
  installViews(db);
  return db;
}

export function transaction(db, callback) {
  db.exec('BEGIN IMMEDIATE');
  try { const result=callback(); db.exec('COMMIT'); return result; }
  catch(error) { db.exec('ROLLBACK'); throw error; }
}

export function setState(db,key,value) { db.prepare('INSERT INTO runtime_state(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key,JSON.stringify(value)); }
export function getState(db,key,fallback=null) { const row=db.prepare('SELECT value FROM runtime_state WHERE key=?').get(key); return row ? JSON.parse(row.value) : fallback; }

function installViews(db) {
  // Read-only projections keep existing business formulae intact without copying old tables.
  // Migrate the V2 projection in place; CREATE IF NOT EXISTS cannot add flag columns.
  const lpColumns=db.prepare('PRAGMA table_info(lp_offers)').all();
  if(lpColumns.length&&!lpColumns.some(column=>column.name==='is_blocked'))db.exec('DROP VIEW lp_offers;');
  const contractColumns=db.prepare('PRAGMA table_info(contract_item_cache)').all();
  if(contractColumns.length&&!contractColumns.some(column=>column.name==='fetched_at'))db.exec('DROP VIEW contract_item_cache;');
  db.exec(`
    CREATE VIEW IF NOT EXISTS item_types AS SELECT type_id,name_zh,name_en,NULL AS history_synced_at,NULL AS order_synced_at,NULL AS volume_synced_at,updated_at FROM items;
    CREATE VIEW IF NOT EXISTS sde_type_reference AS SELECT type_id,name_zh,name_en,group_id,volume,packaged_volume,CASE WHEN packaged_volume IS NOT NULL THEN 1 ELSE 0 END AS is_repackable,source,updated_at FROM items;
    CREATE VIEW IF NOT EXISTS factions AS SELECT faction_id,MAX(faction_name_zh) AS name,MAX(updated_at) AS updated_at FROM lp_exchange WHERE faction_id IS NOT NULL GROUP BY faction_id;
    CREATE VIEW IF NOT EXISTS corporations AS SELECT corporation_id,MAX(faction_id) AS faction_id,MAX(corporation_name_zh) AS name,MAX(updated_at) AS name_synced_at,MAX(updated_at) AS offers_synced_at,MAX(updated_at) AS updated_at FROM lp_exchange GROUP BY corporation_id;
    CREATE VIEW IF NOT EXISTS lp_offers AS SELECT corporation_id,offer_id,type_id,quantity,lp_cost,isk_cost,ak_cost,is_high_sec,is_blocked,updated_at FROM lp_exchange;
    CREATE VIEW IF NOT EXISTS lp_offer_materials AS SELECT corporation_id,offer_id,material_type_id AS type_id,quantity FROM lp_requirements;
    CREATE VIEW IF NOT EXISTS blueprint_recipes AS SELECT blueprint_id AS blueprint_type_id,product_type_id,product_quantity,updated_at AS checked_at FROM recipes;
    CREATE VIEW IF NOT EXISTS blueprint_materials AS SELECT blueprint_id AS blueprint_type_id,material_type_id,quantity FROM recipe_materials;
    CREATE VIEW IF NOT EXISTS market_daily AS SELECT 10000002 AS region_id,type_id,date AS trade_date,average AS average_price,highest AS highest_price,lowest AS lowest_price,volume FROM history;
    CREATE VIEW IF NOT EXISTS market_orders AS SELECT 10000002 AS region_id,* FROM quote_cache;
    CREATE VIEW IF NOT EXISTS market_order_levels AS SELECT 10000002 AS region_id,* FROM depth_cache;
    CREATE VIEW IF NOT EXISTS market_order_book AS SELECT 0 AS slot,order_id,type_id,location_id,system_id,is_buy_order,price,volume_remain,volume_total,min_volume,range AS order_range,issued,duration FROM orders WHERE generation=json_extract((SELECT value FROM runtime_state WHERE key='orders'), '$.generation');
    CREATE VIEW IF NOT EXISTS market_order_book_state AS SELECT 1 AS id,0 AS active_slot,json_extract(value,'$.generation') AS snapshot_id,json_extract(value,'$.collected_at') AS collected_at,json_extract(value,'$.order_count') AS order_count FROM runtime_state WHERE key='orders';
    CREATE VIEW IF NOT EXISTS market_location_mappings AS SELECT location_id,system_name,'伏尔戈星域' AS region_name,mapping_name,updated_at FROM station_mappings;
    CREATE VIEW IF NOT EXISTS implant_catalog AS SELECT set_id AS set_key,name_zh AS set_name,0 AS is_blueprint,json_array(slot_1_type_id,slot_2_type_id,slot_3_type_id,slot_4_type_id,slot_5_type_id,slot_6_type_id) AS item_type_ids,'direct' AS source_flags,NULL AS generation_id,'' AS updated_at FROM implant_sets;
    CREATE VIEW IF NOT EXISTS contract_headers AS SELECT contract_id,json_extract(raw_json,'$.type') AS contract_type,json_extract(raw_json,'$.price') AS price,json_extract(raw_json,'$.date_issued') AS date_issued,json_extract(raw_json,'$.date_expired') AS date_expired,json_extract(raw_json,'$.start_location_id') AS start_location_id,json_extract(raw_json,'$.end_location_id') AS end_location_id,json_extract(raw_json,'$.volume') AS volume,generation AS last_seen_generation,generation AS last_seen_at,1 AS active FROM contracts;
    CREATE VIEW IF NOT EXISTS contract_item_cache AS SELECT ci.contract_id,json_group_array(json(ci.raw_json)) AS payload,'ready' AS status,MAX(c.generation) AS fetched_at,NULL AS error_message FROM contract_items ci JOIN contracts c ON c.contract_id=ci.contract_id GROUP BY ci.contract_id;
    CREATE VIEW IF NOT EXISTS contract_snapshots AS SELECT * FROM contract_cache;
    CREATE VIEW IF NOT EXISTS ranking_snapshots AS SELECT * FROM ranking_cache;
  `);
}
