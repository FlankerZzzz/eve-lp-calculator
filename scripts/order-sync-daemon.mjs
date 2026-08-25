import { DatabaseSync } from "node:sqlite";
import { summarize } from "./order-fetch-process.mjs";

const ESI_BASE = (process.env.ESI_BASE_URL || "https://ali-esi.evepc.163.com").replace(/\/$/, "");
const REGION_ID = 10000002;
const JITA_44_LOCATION_ID = 60003760;
const PAGE_CONCURRENCY = 8;
const PAGE_RETRY_DELAYS = [1000, 2000, 4000, 8000];
const SNAPSHOT_RETRY_DELAYS = [30000, 60000, 120000, 300000];
const db = new DatabaseSync(process.env.SQLITE_PATH || "/data/eve-lp.db");
db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA busy_timeout=15000; PRAGMA temp_store=MEMORY; PRAGMA cache_size=-65536;");

db.exec(`
  CREATE TABLE IF NOT EXISTS market_order_book (
    slot INTEGER NOT NULL, order_id INTEGER NOT NULL, type_id INTEGER NOT NULL,
    location_id INTEGER NOT NULL, system_id INTEGER NOT NULL, is_buy_order INTEGER NOT NULL,
    price REAL NOT NULL, volume_remain INTEGER NOT NULL, volume_total INTEGER NOT NULL,
    min_volume INTEGER NOT NULL, order_range TEXT NOT NULL, issued TEXT NOT NULL,
    duration INTEGER NOT NULL, PRIMARY KEY (slot, order_id)
  );
  CREATE TABLE IF NOT EXISTS market_order_book_state (
    id INTEGER PRIMARY KEY CHECK (id=1), active_slot INTEGER NOT NULL DEFAULT 0,
    snapshot_id TEXT, collected_at TEXT, order_count INTEGER NOT NULL DEFAULT 0
  );
  INSERT OR IGNORE INTO market_order_book_state (id, active_slot, order_count) VALUES (1, 0, 0);
  CREATE INDEX IF NOT EXISTS idx_market_order_book_type ON market_order_book (slot, type_id, is_buy_order, price);
  CREATE INDEX IF NOT EXISTS idx_market_order_book_location ON market_order_book (slot, location_id, type_id, is_buy_order, price);
`);

const visible = `(EXISTS (SELECT 1 FROM lp_offers o JOIN corporations c ON c.corporation_id=o.corporation_id WHERE o.type_id=item_types.type_id AND c.faction_id NOT IN (500013,500017,500026)) OR EXISTS (SELECT 1 FROM lp_offer_materials m JOIN corporations c ON c.corporation_id=m.corporation_id WHERE m.type_id=item_types.type_id AND c.faction_id NOT IN (500013,500017,500026)) OR EXISTS (SELECT 1 FROM blueprint_recipes b JOIN lp_offers o ON o.type_id=b.blueprint_type_id JOIN corporations c ON c.corporation_id=o.corporation_id WHERE b.product_type_id=item_types.type_id AND c.faction_id NOT IN (500013,500017,500026)) OR EXISTS (SELECT 1 FROM blueprint_materials bm JOIN lp_offers o ON o.type_id=bm.blueprint_type_id JOIN corporations c ON c.corporation_id=o.corporation_id WHERE bm.material_type_id=item_types.type_id AND c.faction_id NOT IN (500013,500017,500026)))`;
const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
const retryableStatus = status => status === 420 || status === 429 || status >= 500;

class PausedError extends Error {}

async function fetchPage(page) {
  const url = `${ESI_BASE}/latest/markets/${REGION_ID}/orders/?datasource=serenity&order_type=all&page=${page}`;
  let lastError;
  for (let attempt = 0; attempt <= PAGE_RETRY_DELAYS.length; attempt += 1) {
    try {
      const response = await fetch(url, {
        headers: { accept: "application/json", "accept-encoding": "gzip, br", "user-agent": "Chenxi-LP-Calculator/full-region-snapshot" },
        signal: AbortSignal.timeout(30000),
      });
      if (response.ok) return { rows: await response.json(), pages: Number(response.headers.get("x-pages") || 1) };
      const detail = (await response.text()).slice(0, 180);
      lastError = new Error(`ESI ${response.status} page ${page}: ${detail}`);
      if (!retryableStatus(response.status)) {
        lastError.nonRetryable = true;
        throw lastError;
      }
      if (attempt === PAGE_RETRY_DELAYS.length) throw lastError;
      const retryAfter = Math.min(Number(response.headers.get("retry-after") || 0) * 1000, 30000);
      await sleep(Math.max(PAGE_RETRY_DELAYS[attempt], retryAfter));
    } catch (error) {
      lastError = error;
      if (error?.nonRetryable) throw error;
      if (attempt === PAGE_RETRY_DELAYS.length) break;
      await sleep(PAGE_RETRY_DELAYS[attempt]);
    }
  }
  throw lastError instanceof Error ? lastError : new Error(`订单分页 ${page} 读取失败`);
}

function eligibleTypeIds() {
  return new Set(db.prepare(`SELECT type_id FROM item_types WHERE ${visible}`).all().map(row => row.type_id));
}

function currentJob(runStartedAt) {
  const job = db.prepare("SELECT status,run_started_at FROM sync_jobs WHERE kind='orders'").get();
  return job?.status === "running" && job.run_started_at === runStartedAt;
}

function writeRawPage(slot, rows) {
  const insert = db.prepare(`INSERT OR REPLACE INTO market_order_book
    (slot,order_id,type_id,location_id,system_id,is_buy_order,price,volume_remain,volume_total,min_volume,order_range,issued,duration)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  db.exec("BEGIN IMMEDIATE");
  try {
    for (const order of rows) insert.run(
      slot, order.order_id, order.type_id, order.location_id, order.system_id,
      order.is_buy_order ? 1 : 0, order.price, order.volume_remain, order.volume_total,
      order.min_volume, String(order.range), order.issued, order.duration,
    );
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

function collectJitaOrders(rows, eligible, grouped) {
  for (const order of rows) {
    if (order.location_id !== JITA_44_LOCATION_ID || !eligible.has(order.type_id)) continue;
    const list = grouped.get(order.type_id) || [];
    list.push({ is_buy_order: order.is_buy_order, price: order.price, volume_remain: order.volume_remain });
    grouped.set(order.type_id, list);
  }
}

function publishSnapshot({ activeSlot, inactiveSlot, snapshotId, collectedAt, orderCount, pageCount, eligible, grouped }) {
  const order = db.prepare("INSERT INTO market_orders (region_id,type_id,buy_price,sell_price,buy_volume,sell_volume,collected_at) VALUES (10000002,?,?,?,?,?,?)");
  const level = db.prepare("INSERT INTO market_order_levels (region_id,type_id,side,level,price,volume,collected_at) VALUES (10000002,?,?,?,?,?,?)");
  const synced = db.prepare("UPDATE item_types SET order_synced_at=? WHERE type_id=?");
  db.exec("BEGIN IMMEDIATE");
  try {
    db.prepare("DELETE FROM market_orders WHERE region_id=10000002").run();
    db.prepare("DELETE FROM market_order_levels WHERE region_id=10000002").run();
    for (const typeId of eligible) {
      const summary = summarize(grouped.get(typeId) || []);
      order.run(typeId, summary.buyPrice, summary.sellPrice, summary.buyVolume, summary.sellVolume, collectedAt);
      for (const item of summary.buyLevels) level.run(typeId, "buy", item.level, item.price, item.volume, collectedAt);
      for (const item of summary.sellLevels) level.run(typeId, "sell", item.level, item.price, item.volume, collectedAt);
      synced.run(collectedAt, typeId);
    }
    db.prepare("UPDATE market_order_book_state SET active_slot=?,snapshot_id=?,collected_at=?,order_count=? WHERE id=1").run(inactiveSlot, snapshotId, collectedAt, orderCount);
    db.prepare("UPDATE sync_jobs SET status='complete',phase='完成',processed=?,remaining=0,last_endpoint=?,last_http_status=200,last_response=?,error=NULL,updated_at=? WHERE kind='orders'").run(
      orderCount,
      `/markets/${REGION_ID}/orders/`,
      JSON.stringify({ mode: "full-region-double-slot", pages: pageCount, orderCount, jitaTypeCount: grouped.size, activeSlot: inactiveSlot }),
      collectedAt,
    );
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
  db.prepare("DELETE FROM market_order_book WHERE slot=?").run(activeSlot);
}

async function syncSnapshot(runStartedAt) {
  const activeSlot = Number(db.prepare("SELECT active_slot FROM market_order_book_state WHERE id=1").get()?.active_slot || 0);
  const inactiveSlot = activeSlot === 0 ? 1 : 0;
  const snapshotId = `${runStartedAt}:${inactiveSlot}`;
  const eligible = eligibleTypeIds();
  const grouped = new Map();
  let orderCount = 0;
  let completedPages = 0;
  db.prepare("DELETE FROM market_order_book WHERE slot=?").run(inactiveSlot);

  const first = await fetchPage(1);
  if (!Number.isInteger(first.pages) || first.pages < 1 || first.pages > 1000) throw new Error(`ESI 返回异常页数 ${first.pages}`);
  writeRawPage(inactiveSlot, first.rows);
  collectJitaOrders(first.rows, eligible, grouped);
  orderCount += first.rows.length;
  completedPages = 1;

  for (let page = 2; page <= first.pages; page += PAGE_CONCURRENCY) {
    if (!currentJob(runStartedAt)) throw new PausedError("订单同步已暂停或被新任务替换");
    const pageNumbers = Array.from({ length: Math.min(PAGE_CONCURRENCY, first.pages - page + 1) }, (_, index) => page + index);
    const wave = await Promise.all(pageNumbers.map(fetchPage));
    for (const result of wave) {
      writeRawPage(inactiveSlot, result.rows);
      collectJitaOrders(result.rows, eligible, grouped);
      orderCount += result.rows.length;
      completedPages += 1;
    }
    const now = new Date().toISOString();
    db.prepare("UPDATE sync_jobs SET phase='伏尔戈全量订单分页',processed=?,remaining=?,last_endpoint=?,last_http_status=200,last_response=?,updated_at=? WHERE kind='orders' AND status='running' AND run_started_at=?").run(
      orderCount,
      first.pages - completedPages,
      `/markets/${REGION_ID}/orders/?page=${pageNumbers.at(-1)}`,
      JSON.stringify({ mode: "full-region-double-slot", completedPages, totalPages: first.pages, orderCount, concurrency: PAGE_CONCURRENCY }),
      now,
      runStartedAt,
    );
  }

  if (!currentJob(runStartedAt)) throw new PausedError("订单同步已暂停或被新任务替换");
  const collectedAt = new Date().toISOString();
  publishSnapshot({ activeSlot, inactiveSlot, snapshotId, collectedAt, orderCount, pageCount: first.pages, eligible, grouped });
  console.log(`[order-sync] 全量快照完成：${first.pages} 页，${orderCount} 条订单，吉他 4-4 相关物品 ${grouped.size} 种`);
}

console.log(`[order-sync] 常驻调度器启动：伏尔戈全量订单，${PAGE_CONCURRENCY} 页并发，双槽原子快照`);
let failedAttempts = 0;
let activeRunStartedAt = "";
while (true) {
  const job = db.prepare("SELECT status,run_started_at FROM sync_jobs WHERE kind='orders'").get();
  if (!job || job.status !== "running" || !job.run_started_at) {
    failedAttempts = 0;
    activeRunStartedAt = "";
    await sleep(1000);
    continue;
  }
  if (activeRunStartedAt !== job.run_started_at) {
    activeRunStartedAt = job.run_started_at;
    failedAttempts = 0;
  }
  try {
    await syncSnapshot(job.run_started_at);
    failedAttempts = 0;
  } catch (error) {
    const activeSlot = Number(db.prepare("SELECT active_slot FROM market_order_book_state WHERE id=1").get()?.active_slot || 0);
    db.prepare("DELETE FROM market_order_book WHERE slot=?").run(activeSlot === 0 ? 1 : 0);
    if (error instanceof PausedError) {
      console.log(`[order-sync] ${error.message}`);
      await sleep(1000);
      continue;
    }
    failedAttempts += 1;
    const wait = SNAPSHOT_RETRY_DELAYS[Math.min(failedAttempts - 1, SNAPSHOT_RETRY_DELAYS.length - 1)];
    const message = error instanceof Error ? error.message : String(error);
    const now = new Date().toISOString();
    db.prepare("UPDATE sync_jobs SET status='running',phase='失败重试',last_response=?,error=?,updated_at=? WHERE kind='orders' AND status='running' AND run_started_at=?").run(
      JSON.stringify({ message: "保留上一份完整快照并自动重试", attempt: failedAttempts, retryAfterSeconds: wait / 1000 }),
      message,
      now,
      job.run_started_at,
    );
    console.error(`[order-sync] ${message}；${wait / 1000} 秒后重试（${failedAttempts}）`);
    await sleep(wait);
  }
}
