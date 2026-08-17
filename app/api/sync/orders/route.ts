import { ensureSchema } from "../../../../db/d1";
import { batchStatements, EsiError, MARKET_REGION_ID, orderLevelStatements, summarizeOrders } from "../../../../lib/esi-server";
import { updateSyncJob } from "../../../../db/sync-state";
import { HIDDEN_FACTION_SQL } from "../../../../lib/data-policy";
import { fork } from "node:child_process";
import path from "node:path";

type FetchResult = { typeId: number; now: string; summary: ReturnType<typeof summarizeOrders> };

function runFetchProcess(workerId: number, typeIds: number[]) {
  return new Promise<FetchResult[]>((resolve, reject) => {
    const child = fork(path.join(process.cwd(), "scripts/order-fetch-process.mjs"), [], { stdio: ["ignore", "inherit", "inherit", "ipc"] });
    let settled = false;
    child.once("message", (message: { results?: FetchResult[]; error?: string }) => {
      settled = true;
      if (message.error) reject(new Error(`抓取进程 ${workerId}: ${message.error}`));
      else resolve(message.results || []);
    });
    child.once("error", reject);
    child.once("exit", code => {
      if (!settled && code !== 0) reject(new Error(`抓取进程 ${workerId} 异常退出: ${code}`));
    });
    child.send({ workerId, typeIds });
  });
}

export async function POST(request: Request) {
  const db = await ensureSchema();
  const body = await request.json().catch(() => ({})) as { runStartedAt?: string };
  const runStartedAt = body.runStartedAt || new Date().toISOString();
  try {
    await updateSyncJob({ kind: "orders", status: "running", phase: "当前市场订单", runStartedAt, response: { message: "开始读取当前订单" } });
    const visibleOutput = `EXISTS (SELECT 1 FROM lp_offers o JOIN corporations c ON c.corporation_id=o.corporation_id WHERE o.type_id=item_types.type_id AND c.faction_id NOT IN (${HIDDEN_FACTION_SQL}))`;
    const visibleMaterial = `EXISTS (SELECT 1 FROM lp_offer_materials m JOIN corporations c ON c.corporation_id=m.corporation_id WHERE m.type_id=item_types.type_id AND c.faction_id NOT IN (${HIDDEN_FACTION_SQL}))`;
    const blueprintProduct = `EXISTS (SELECT 1 FROM blueprint_recipes b JOIN lp_offers o ON o.type_id=b.blueprint_type_id JOIN corporations c ON c.corporation_id=o.corporation_id WHERE b.product_type_id=item_types.type_id AND c.faction_id NOT IN (${HIDDEN_FACTION_SQL}))`;
    const blueprintMaterial = `EXISTS (SELECT 1 FROM blueprint_materials bm JOIN lp_offers o ON o.type_id=bm.blueprint_type_id JOIN corporations c ON c.corporation_id=o.corporation_id WHERE bm.material_type_id=item_types.type_id AND c.faction_id NOT IN (${HIDDEN_FACTION_SQL}))`;
    const eligible = `(${visibleOutput} OR ${visibleMaterial} OR ${blueprintProduct} OR ${blueprintMaterial})`;
    const pending = (await db.prepare(`SELECT type_id FROM item_types WHERE ${eligible} AND (order_synced_at IS NULL OR order_synced_at < ?) ORDER BY CASE WHEN (${visibleOutput} OR ${blueprintProduct}) THEN 0 ELSE 1 END, COALESCE(order_synced_at, '') LIMIT 100`).bind(runStartedAt).all<{ type_id: number }>()).results;
    let completed = 0;
    let persisted = 0;
    let writerBusy = false;
    const summaries: Array<{ row: { type_id: number }; summary: ReturnType<typeof summarizeOrders>; now: string }> = [];
    const flushQueue = async () => {
      if (writerBusy || summaries.length === 0) return;
      writerBusy = true;
      const chunk = summaries.splice(0, 200);
      try {
        await batchStatements(db, chunk.flatMap(({ row, summary, now }) => [
          db.prepare("INSERT INTO market_orders (region_id, type_id, buy_price, sell_price, buy_volume, sell_volume, collected_at) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(region_id, type_id) DO UPDATE SET buy_price=excluded.buy_price, sell_price=excluded.sell_price, buy_volume=excluded.buy_volume, sell_volume=excluded.sell_volume, collected_at=excluded.collected_at").bind(MARKET_REGION_ID, row.type_id, summary.buyPrice, summary.sellPrice, summary.buyVolume, summary.sellVolume, now),
          ...orderLevelStatements(db, row.type_id, summary, now),
          db.prepare("UPDATE item_types SET order_synced_at=? WHERE type_id=?").bind(now, row.type_id),
        ]));
        persisted += chunk.length;
        await updateSyncJob({ kind: "orders", status: "running", phase: "当前市场订单", runStartedAt, processedDelta: chunk.length, response: { message: "同步进行中", completedInBatch: completed, persistedInBatch: persisted, batchSize: pending.length, writerBatch: chunk.length } });
      } finally {
        writerBusy = false;
      }
    };
    const writerTimer = setInterval(() => { void flushQueue(); }, 500);
    const workerChunks = Array.from({ length: 4 }, (_, workerId) => ({
      workerId,
      typeIds: pending.slice(workerId * 25, workerId * 25 + 25).map(row => row.type_id),
    })).filter(chunk => chunk.typeIds.length > 0);
    const workerResults = await Promise.all(workerChunks.map(chunk => runFetchProcess(chunk.workerId, chunk.typeIds)));
    for (const result of workerResults.flat()) {
      summaries.push({ row: { type_id: result.typeId }, summary: result.summary, now: result.now });
      completed += 1;
    }
    clearInterval(writerTimer);
    while (summaries.length || writerBusy) {
      await flushQueue();
      if (summaries.length || writerBusy) await new Promise(resolve => setTimeout(resolve, 50));
    }
    const remaining = await db.prepare(`SELECT COUNT(*) AS count FROM item_types WHERE ${eligible} AND (order_synced_at IS NULL OR order_synced_at < ?)`).bind(runStartedAt).first<{ count: number }>();
    const result = { done: (remaining?.count ?? 0) === 0, runStartedAt, processed: pending.length, persisted, remaining: remaining?.count ?? 0 };
    await updateSyncJob({ kind: "orders", status: result.done ? "complete" : "running", phase: result.done ? "完成" : "当前市场订单", runStartedAt, processedDelta: 0, remaining: result.remaining, endpoint: pending[0] ? `/markets/${MARKET_REGION_ID}/orders/?type_id=${pending[0].type_id}` : undefined, httpStatus: 200, response: result });
    return Response.json(result);
  } catch (error) {
    const status = error instanceof EsiError && error.status === 420 ? 429 : 502;
    const message = error instanceof Error ? error.message : String(error);
    await updateSyncJob({ kind: "orders", status: "error", phase: "已暂停", runStartedAt, endpoint: error instanceof EsiError ? error.path : undefined, httpStatus: error instanceof EsiError ? error.status : status, error: message });
    return Response.json({ error: message, runStartedAt, resumable: true }, { status });
  }
}
