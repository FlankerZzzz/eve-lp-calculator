import { getSqlite } from "./sqlite";
const env = (globalThis as any).env ?? {};

export function getD1(): D1Database {
  if (process.env.SQLITE_RUNTIME === "1") return getSqlite();
  if (!env.DB) throw new Error("D1 binding DB is unavailable");
  return env.DB;
}

let schemaReady = false;

export async function ensureSchema() {
  if (schemaReady) return getD1();
  const db = getD1();
  const statements = [
    `CREATE TABLE IF NOT EXISTS factions (faction_id INTEGER PRIMARY KEY, name TEXT NOT NULL, updated_at TEXT NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS corporations (corporation_id INTEGER PRIMARY KEY, faction_id INTEGER, name TEXT NOT NULL, name_synced_at TEXT, offers_synced_at TEXT, updated_at TEXT NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS item_types (type_id INTEGER PRIMARY KEY, name_zh TEXT, name_en TEXT, history_synced_at TEXT, order_synced_at TEXT, updated_at TEXT NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS lp_offers (corporation_id INTEGER NOT NULL, offer_id INTEGER NOT NULL, type_id INTEGER NOT NULL, quantity INTEGER NOT NULL, lp_cost INTEGER NOT NULL, isk_cost REAL NOT NULL, ak_cost INTEGER NOT NULL DEFAULT 0, updated_at TEXT NOT NULL, PRIMARY KEY (corporation_id, offer_id))`,
    `CREATE TABLE IF NOT EXISTS lp_offer_materials (corporation_id INTEGER NOT NULL, offer_id INTEGER NOT NULL, type_id INTEGER NOT NULL, quantity INTEGER NOT NULL, PRIMARY KEY (corporation_id, offer_id, type_id))`,
    `CREATE TABLE IF NOT EXISTS blueprint_recipes (blueprint_type_id INTEGER PRIMARY KEY, product_type_id INTEGER NOT NULL, product_quantity INTEGER NOT NULL, checked_at TEXT NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS blueprint_materials (blueprint_type_id INTEGER NOT NULL, material_type_id INTEGER NOT NULL, quantity INTEGER NOT NULL, PRIMARY KEY (blueprint_type_id, material_type_id))`,
    `CREATE TABLE IF NOT EXISTS blueprint_checks (type_id INTEGER PRIMARY KEY, checked_at TEXT NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS market_daily (region_id INTEGER NOT NULL, type_id INTEGER NOT NULL, trade_date TEXT NOT NULL, average_price REAL NOT NULL, highest_price REAL NOT NULL, lowest_price REAL NOT NULL, volume INTEGER NOT NULL, PRIMARY KEY (region_id, type_id, trade_date))`,
    `CREATE TABLE IF NOT EXISTS market_orders (region_id INTEGER NOT NULL, type_id INTEGER NOT NULL, buy_price REAL NOT NULL, sell_price REAL NOT NULL, buy_volume INTEGER NOT NULL, sell_volume INTEGER NOT NULL, collected_at TEXT NOT NULL, PRIMARY KEY (region_id, type_id))`,
    `CREATE TABLE IF NOT EXISTS market_order_levels (region_id INTEGER NOT NULL, type_id INTEGER NOT NULL, side TEXT NOT NULL, level INTEGER NOT NULL, price REAL NOT NULL, volume INTEGER NOT NULL, collected_at TEXT NOT NULL, PRIMARY KEY (region_id, type_id, side, level))`,
    `CREATE TABLE IF NOT EXISTS sync_runs (id INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT NOT NULL, status TEXT NOT NULL, detail TEXT, started_at TEXT NOT NULL, finished_at TEXT)`,
    `CREATE TABLE IF NOT EXISTS sync_jobs (kind TEXT PRIMARY KEY, status TEXT NOT NULL, phase TEXT, run_started_at TEXT, processed INTEGER NOT NULL DEFAULT 0, remaining INTEGER NOT NULL DEFAULT 0, last_endpoint TEXT, last_http_status INTEGER, last_response TEXT, error TEXT, updated_at TEXT NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS sync_events (id INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT NOT NULL, phase TEXT, endpoint TEXT, http_status INTEGER, response TEXT, created_at TEXT NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS ranking_snapshots (list_kind TEXT NOT NULL, rank INTEGER NOT NULL, snapshot_date TEXT NOT NULL, calculated_at TEXT NOT NULL, payload TEXT NOT NULL, PRIMARY KEY (list_kind, rank))`,
    `CREATE INDEX IF NOT EXISTS idx_corporations_faction ON corporations (faction_id)`,
    `CREATE INDEX IF NOT EXISTS idx_lp_offers_corporation ON lp_offers (corporation_id)`,
    `CREATE INDEX IF NOT EXISTS idx_lp_offers_type ON lp_offers (type_id)`,
    `CREATE INDEX IF NOT EXISTS idx_blueprint_product ON blueprint_recipes (product_type_id)`,
    `CREATE INDEX IF NOT EXISTS idx_market_daily_type_date ON market_daily (region_id, type_id, trade_date)`,
    `CREATE INDEX IF NOT EXISTS idx_market_order_levels_type ON market_order_levels (region_id, type_id, side, level)`,
    `CREATE INDEX IF NOT EXISTS idx_sync_events_created ON sync_events (created_at)`,
  ];
  await db.batch(statements.map(sql => db.prepare(sql)));
  const corporationColumns = (await db.prepare("PRAGMA table_info(corporations)").all<{ name: string }>()).results;
  if (!corporationColumns.some(column => column.name === "name_synced_at")) {
    await db.prepare("ALTER TABLE corporations ADD COLUMN name_synced_at TEXT").run();
  }
  schemaReady = true;
  return db;
}
