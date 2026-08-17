import { DatabaseSync } from "node:sqlite";
import { fetchOrders, summarize } from "./order-fetch-process.mjs";

const db = new DatabaseSync(process.env.SQLITE_PATH || "/data/eve-lp.db");
db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA busy_timeout=10000; PRAGMA temp_store=MEMORY; PRAGMA cache_size=-65536;");
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

const visible = `(EXISTS (SELECT 1 FROM lp_offers o JOIN corporations c ON c.corporation_id=o.corporation_id WHERE o.type_id=item_types.type_id AND c.faction_id NOT IN (500013,500017,500026)) OR EXISTS (SELECT 1 FROM lp_offer_materials m JOIN corporations c ON c.corporation_id=m.corporation_id WHERE m.type_id=item_types.type_id AND c.faction_id NOT IN (500013,500017,500026)) OR EXISTS (SELECT 1 FROM blueprint_recipes b JOIN lp_offers o ON o.type_id=b.blueprint_type_id JOIN corporations c ON c.corporation_id=o.corporation_id WHERE b.product_type_id=item_types.type_id AND c.faction_id NOT IN (500013,500017,500026)) OR EXISTS (SELECT 1 FROM blueprint_materials bm JOIN lp_offers o ON o.type_id=bm.blueprint_type_id JOIN corporations c ON c.corporation_id=o.corporation_id WHERE bm.material_type_id=item_types.type_id AND c.faction_id NOT IN (500013,500017,500026)))`;

function writeChunk(rows) {
  if (!rows.length) return;
  const order = db.prepare("INSERT INTO market_orders (region_id,type_id,buy_price,sell_price,buy_volume,sell_volume,collected_at) VALUES (10000002,?,?,?,?,?,?) ON CONFLICT(region_id,type_id) DO UPDATE SET buy_price=excluded.buy_price,sell_price=excluded.sell_price,buy_volume=excluded.buy_volume,sell_volume=excluded.sell_volume,collected_at=excluded.collected_at");
  const removeLevels = db.prepare("DELETE FROM market_order_levels WHERE region_id=10000002 AND type_id=?");
  const level = db.prepare("INSERT INTO market_order_levels (region_id,type_id,side,level,price,volume,collected_at) VALUES (10000002,?,?,?,?,?,?)");
  const synced = db.prepare("UPDATE item_types SET order_synced_at=? WHERE type_id=?");
  db.exec("BEGIN IMMEDIATE");
  try {
    for (const { typeId, now, summary } of rows) {
      order.run(typeId, summary.buyPrice, summary.sellPrice, summary.buyVolume, summary.sellVolume, now);
      removeLevels.run(typeId);
      for (const item of summary.buyLevels) level.run(typeId, "buy", item.level, item.price, item.volume, now);
      for (const item of summary.sellLevels) level.run(typeId, "sell", item.level, item.price, item.volume, now);
      synced.run(now, typeId);
    }
    const now = new Date().toISOString();
    db.prepare("UPDATE sync_jobs SET processed=processed+?,phase='当前市场订单',last_response=?,updated_at=? WHERE kind='orders' AND status='running'").run(rows.length, JSON.stringify({ message: "独立同步器运行中", writerBatch: rows.length, concurrency: 100 }), now);
    db.exec("COMMIT");
  } catch (error) { db.exec("ROLLBACK"); throw error; }
}

async function runBatch(typeIds, runStartedAt) {
  const queue = [];
  let finished = 0;
  const requests = typeIds.map(async typeId => {
    queue.push({ typeId, now: new Date().toISOString(), summary: summarize(await fetchOrders(typeId)) });
    finished += 1;
  });
  while (finished < typeIds.length) {
    if (queue.length) writeChunk(queue.splice(0, 100));
    await sleep(500);
  }
  await Promise.all(requests);
  while (queue.length) writeChunk(queue.splice(0, 100));
  const remaining = db.prepare(`SELECT COUNT(*) count FROM item_types WHERE ${visible} AND (order_synced_at IS NULL OR order_synced_at < ?)` ).get(runStartedAt).count;
  const now = new Date().toISOString();
  db.prepare("UPDATE sync_jobs SET remaining=?,status=?,phase=?,updated_at=? WHERE kind='orders' AND status='running'").run(remaining, remaining ? "running" : "complete", remaining ? "当前市场订单" : "完成", now);
}

console.log("[order-sync] 常驻调度器启动：单进程 100 异步并发，单 SQLite writer");
while (true) {
  try {
    const job = db.prepare("SELECT status,run_started_at FROM sync_jobs WHERE kind='orders'").get();
    if (!job || job.status !== "running" || !job.run_started_at) { await sleep(1000); continue; }
    const rows = db.prepare(`SELECT type_id FROM item_types WHERE ${visible} AND (order_synced_at IS NULL OR order_synced_at < ?) ORDER BY COALESCE(order_synced_at,'') LIMIT 100`).all(job.run_started_at);
    if (!rows.length) { db.prepare("UPDATE sync_jobs SET status='complete',phase='完成',remaining=0,updated_at=? WHERE kind='orders'").run(new Date().toISOString()); await sleep(1000); continue; }
    await runBatch(rows.map(row => row.type_id), job.run_started_at);
  } catch (error) { console.error("[order-sync]", error); await sleep(5000); }
}
