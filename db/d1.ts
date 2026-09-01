import { getSqlite } from "./sqlite";
const env = (globalThis as { env?: { DB?: D1Database } }).env ?? {};

export function getD1(): D1Database {
  if (process.env.SQLITE_RUNTIME === "1") return getSqlite();
  if (!env.DB) throw new Error("D1 binding DB is unavailable");
  return env.DB;
}

let schemaReady = false;
let schemaInitialization: Promise<D1Database> | null = null;

export async function ensureSchema() {
  if (schemaReady) return getD1();
  if (schemaInitialization) return schemaInitialization;
  schemaInitialization = initializeSchema();
  try {
    return await schemaInitialization;
  } catch (error) {
    schemaInitialization = null;
    throw error;
  }
}

async function initializeSchema() {
  const db = getD1();
  const statements = [
    `CREATE TABLE IF NOT EXISTS factions (faction_id INTEGER PRIMARY KEY, name TEXT NOT NULL, updated_at TEXT NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS corporations (corporation_id INTEGER PRIMARY KEY, faction_id INTEGER, name TEXT NOT NULL, name_synced_at TEXT, offers_synced_at TEXT, updated_at TEXT NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS item_types (type_id INTEGER PRIMARY KEY, name_zh TEXT, name_en TEXT, history_synced_at TEXT, order_synced_at TEXT, updated_at TEXT NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS lp_offers (corporation_id INTEGER NOT NULL, offer_id INTEGER NOT NULL, type_id INTEGER NOT NULL, quantity INTEGER NOT NULL, lp_cost INTEGER NOT NULL, isk_cost REAL NOT NULL, ak_cost INTEGER NOT NULL DEFAULT 0, updated_at TEXT NOT NULL, PRIMARY KEY (corporation_id, offer_id))`,
    `CREATE TABLE IF NOT EXISTS lp_offer_materials (corporation_id INTEGER NOT NULL, offer_id INTEGER NOT NULL, type_id INTEGER NOT NULL, quantity INTEGER NOT NULL, PRIMARY KEY (corporation_id, offer_id, type_id))`,
    `CREATE TABLE IF NOT EXISTS lp_offer_staging (generation_id TEXT NOT NULL, corporation_id INTEGER NOT NULL, offer_id INTEGER NOT NULL, type_id INTEGER NOT NULL, quantity INTEGER NOT NULL, lp_cost INTEGER NOT NULL, isk_cost REAL NOT NULL, ak_cost INTEGER NOT NULL DEFAULT 0, updated_at TEXT NOT NULL, PRIMARY KEY (generation_id, corporation_id, offer_id))`,
    `CREATE TABLE IF NOT EXISTS lp_offer_material_staging (generation_id TEXT NOT NULL, corporation_id INTEGER NOT NULL, offer_id INTEGER NOT NULL, type_id INTEGER NOT NULL, quantity INTEGER NOT NULL, PRIMARY KEY (generation_id, corporation_id, offer_id, type_id))`,
    `CREATE TABLE IF NOT EXISTS blueprint_recipes (blueprint_type_id INTEGER PRIMARY KEY, product_type_id INTEGER NOT NULL, product_quantity INTEGER NOT NULL, checked_at TEXT NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS blueprint_materials (blueprint_type_id INTEGER NOT NULL, material_type_id INTEGER NOT NULL, quantity INTEGER NOT NULL, PRIMARY KEY (blueprint_type_id, material_type_id))`,
    `CREATE TABLE IF NOT EXISTS blueprint_checks (type_id INTEGER PRIMARY KEY, checked_at TEXT NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS blueprint_recipe_staging (generation_id TEXT NOT NULL, blueprint_type_id INTEGER NOT NULL, product_type_id INTEGER NOT NULL, product_quantity INTEGER NOT NULL, checked_at TEXT NOT NULL, PRIMARY KEY (generation_id, blueprint_type_id))`,
    `CREATE TABLE IF NOT EXISTS blueprint_material_staging (generation_id TEXT NOT NULL, blueprint_type_id INTEGER NOT NULL, material_type_id INTEGER NOT NULL, quantity INTEGER NOT NULL, PRIMARY KEY (generation_id, blueprint_type_id, material_type_id))`,
    `CREATE TABLE IF NOT EXISTS market_daily (region_id INTEGER NOT NULL, type_id INTEGER NOT NULL, trade_date TEXT NOT NULL, average_price REAL NOT NULL, highest_price REAL NOT NULL, lowest_price REAL NOT NULL, volume INTEGER NOT NULL, PRIMARY KEY (region_id, type_id, trade_date))`,
    `CREATE TABLE IF NOT EXISTS market_orders (region_id INTEGER NOT NULL, type_id INTEGER NOT NULL, buy_price REAL NOT NULL, sell_price REAL NOT NULL, buy_volume INTEGER NOT NULL, sell_volume INTEGER NOT NULL, collected_at TEXT NOT NULL, PRIMARY KEY (region_id, type_id))`,
    `CREATE TABLE IF NOT EXISTS market_order_levels (region_id INTEGER NOT NULL, type_id INTEGER NOT NULL, side TEXT NOT NULL, level INTEGER NOT NULL, price REAL NOT NULL, volume INTEGER NOT NULL, collected_at TEXT NOT NULL, PRIMARY KEY (region_id, type_id, side, level))`,
    `CREATE TABLE IF NOT EXISTS market_order_book (slot INTEGER NOT NULL, order_id INTEGER NOT NULL, type_id INTEGER NOT NULL, location_id INTEGER NOT NULL, system_id INTEGER NOT NULL, is_buy_order INTEGER NOT NULL, price REAL NOT NULL, volume_remain INTEGER NOT NULL, volume_total INTEGER NOT NULL, min_volume INTEGER NOT NULL, order_range TEXT NOT NULL, issued TEXT NOT NULL, duration INTEGER NOT NULL, PRIMARY KEY (slot, order_id))`,
    `CREATE TABLE IF NOT EXISTS market_order_book_state (id INTEGER PRIMARY KEY CHECK (id=1), active_slot INTEGER NOT NULL DEFAULT 0, snapshot_id TEXT, collected_at TEXT, order_count INTEGER NOT NULL DEFAULT 0)`,
    `INSERT OR IGNORE INTO market_order_book_state (id, active_slot, order_count) VALUES (1, 0, 0)`,
    `CREATE TABLE IF NOT EXISTS sync_runs (id INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT NOT NULL, status TEXT NOT NULL, detail TEXT, started_at TEXT NOT NULL, finished_at TEXT)`,
    `CREATE TABLE IF NOT EXISTS sync_jobs (kind TEXT PRIMARY KEY, status TEXT NOT NULL, phase TEXT, run_started_at TEXT, processed INTEGER NOT NULL DEFAULT 0, remaining INTEGER NOT NULL DEFAULT 0, last_endpoint TEXT, last_http_status INTEGER, last_response TEXT, error TEXT, updated_at TEXT NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS sync_events (id INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT NOT NULL, phase TEXT, endpoint TEXT, http_status INTEGER, response TEXT, created_at TEXT NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS ranking_snapshots (list_kind TEXT NOT NULL, rank INTEGER NOT NULL, snapshot_date TEXT NOT NULL, calculated_at TEXT NOT NULL, payload TEXT NOT NULL, PRIMARY KEY (list_kind, rank))`,
    `CREATE TABLE IF NOT EXISTS implant_catalog (set_key TEXT NOT NULL, set_name TEXT NOT NULL, is_blueprint INTEGER NOT NULL DEFAULT 0, item_type_ids TEXT NOT NULL, source_flags TEXT NOT NULL DEFAULT 'direct', generation_id TEXT, updated_at TEXT NOT NULL, PRIMARY KEY (set_key))`,
    `CREATE TABLE IF NOT EXISTS contract_snapshots (set_key TEXT PRIMARY KEY, payload TEXT NOT NULL, fetched_at TEXT NOT NULL, expires_at TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'ready', error_message TEXT)`,
    `CREATE TABLE IF NOT EXISTS contract_headers (contract_id INTEGER PRIMARY KEY, contract_type TEXT NOT NULL, price REAL NOT NULL, date_issued TEXT NOT NULL, date_expired TEXT NOT NULL, start_location_id INTEGER NOT NULL, end_location_id INTEGER, volume REAL NOT NULL DEFAULT 0, last_seen_generation TEXT NOT NULL, last_seen_at TEXT NOT NULL, active INTEGER NOT NULL DEFAULT 1)`,
    `CREATE TABLE IF NOT EXISTS contract_item_cache (contract_id INTEGER PRIMARY KEY, payload TEXT NOT NULL, classifier_version INTEGER NOT NULL, status TEXT NOT NULL, set_signature TEXT, set_count INTEGER, fetched_at TEXT NOT NULL, error_message TEXT)`,
    `CREATE INDEX IF NOT EXISTS idx_contract_item_signature ON contract_item_cache (set_signature, status)`,
    `CREATE INDEX IF NOT EXISTS idx_contract_headers_active ON contract_headers (active, contract_type, price)`,
    `CREATE TABLE IF NOT EXISTS contract_sync_state (id INTEGER PRIMARY KEY CHECK (id=1), status TEXT NOT NULL DEFAULT 'idle', locked_until TEXT, started_at TEXT, finished_at TEXT, last_success_at TEXT, heartbeat_at TEXT, generation_id TEXT, retry_count INTEGER NOT NULL DEFAULT 0, directory_contracts INTEGER NOT NULL DEFAULT 0, candidate_contracts INTEGER NOT NULL DEFAULT 0, cached_contracts INTEGER NOT NULL DEFAULT 0, fetched_contracts INTEGER NOT NULL DEFAULT 0, unavailable_contracts INTEGER NOT NULL DEFAULT 0, matched_contracts INTEGER NOT NULL DEFAULT 0, request_count INTEGER NOT NULL DEFAULT 0, duration_ms INTEGER NOT NULL DEFAULT 0, error_message TEXT)`,
    `INSERT OR IGNORE INTO contract_sync_state (id, status, retry_count) VALUES (1, 'idle', 0)`,
    `CREATE INDEX IF NOT EXISTS idx_corporations_faction ON corporations (faction_id)`,
    `CREATE INDEX IF NOT EXISTS idx_lp_offers_corporation ON lp_offers (corporation_id)`,
    `CREATE INDEX IF NOT EXISTS idx_lp_offers_type ON lp_offers (type_id)`,
    `CREATE INDEX IF NOT EXISTS idx_blueprint_product ON blueprint_recipes (product_type_id)`,
    `CREATE INDEX IF NOT EXISTS idx_market_daily_type_date ON market_daily (region_id, type_id, trade_date)`,
    `CREATE INDEX IF NOT EXISTS idx_market_order_levels_type ON market_order_levels (region_id, type_id, side, level)`,
    `CREATE INDEX IF NOT EXISTS idx_market_order_book_type ON market_order_book (slot, type_id, is_buy_order, price)`,
    `CREATE INDEX IF NOT EXISTS idx_market_order_book_location ON market_order_book (slot, location_id, type_id, is_buy_order, price)`,
    `CREATE INDEX IF NOT EXISTS idx_sync_events_created ON sync_events (created_at)`,
    `CREATE INDEX IF NOT EXISTS idx_contract_snapshots_expiry ON contract_snapshots (expires_at)`,
  ];
  await db.batch(statements.map(sql => db.prepare(sql)));
  const corporationColumns = (await db.prepare("PRAGMA table_info(corporations)").all<{ name: string }>()).results;
  if (!corporationColumns.some(column => column.name === "name_synced_at")) {
    await db.prepare("ALTER TABLE corporations ADD COLUMN name_synced_at TEXT").run();
  }
  const implantColumns = (await db.prepare("PRAGMA table_info(implant_catalog)").all<{ name: string }>()).results;
  if (!implantColumns.some(column => column.name === "source_flags")) {
    await db.prepare("ALTER TABLE implant_catalog ADD COLUMN source_flags TEXT NOT NULL DEFAULT 'direct'").run();
  }
  if (!implantColumns.some(column => column.name === "generation_id")) {
    await db.prepare("ALTER TABLE implant_catalog ADD COLUMN generation_id TEXT").run();
  }
  const contractStateColumns = (await db.prepare("PRAGMA table_info(contract_sync_state)").all<{ name: string }>()).results;
  const contractStateMigrations = [
    ["heartbeat_at", "TEXT"], ["generation_id", "TEXT"],
    ["directory_contracts", "INTEGER NOT NULL DEFAULT 0"], ["candidate_contracts", "INTEGER NOT NULL DEFAULT 0"],
    ["cached_contracts", "INTEGER NOT NULL DEFAULT 0"], ["fetched_contracts", "INTEGER NOT NULL DEFAULT 0"],
    ["unavailable_contracts", "INTEGER NOT NULL DEFAULT 0"], ["matched_contracts", "INTEGER NOT NULL DEFAULT 0"], ["request_count", "INTEGER NOT NULL DEFAULT 0"],
    ["duration_ms", "INTEGER NOT NULL DEFAULT 0"],
  ];
  for (const [name, definition] of contractStateMigrations) {
    if (!contractStateColumns.some(column => column.name === name)) {
      await db.prepare(`ALTER TABLE contract_sync_state ADD COLUMN ${name} ${definition}`).run();
    }
  }
  schemaReady = true;
  return db;
}
