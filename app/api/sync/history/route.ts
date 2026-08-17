import { ensureSchema } from "../../../../db/d1";
import { batchStatements, EsiError, esiGet, isMarketUnavailable, MARKET_REGION_ID } from "../../../../lib/esi-server";
import { updateSyncJob } from "../../../../db/sync-state";
import { HIDDEN_FACTION_SQL } from "../../../../lib/data-policy";

type HistoryRow = { date: string; average: number; highest: number; lowest: number; volume: number };

export async function POST(request: Request) {
  const db = await ensureSchema();
  const body = await request.json().catch(() => ({})) as { runStartedAt?: string };
  const runStartedAt = body.runStartedAt || new Date().toISOString();
  try {
    await updateSyncJob({ kind: "history", status: "running", phase: "历史成交日线", runStartedAt, response: { message: "开始读取市场历史" } });
    const lpOutput = `EXISTS (SELECT 1 FROM lp_offers o JOIN corporations c ON c.corporation_id=o.corporation_id WHERE o.type_id=item_types.type_id AND c.faction_id NOT IN (${HIDDEN_FACTION_SQL}))`;
    const blueprintProduct = `EXISTS (SELECT 1 FROM blueprint_recipes b JOIN lp_offers o ON o.type_id=b.blueprint_type_id JOIN corporations c ON c.corporation_id=o.corporation_id WHERE b.product_type_id=item_types.type_id AND c.faction_id NOT IN (${HIDDEN_FACTION_SQL}))`;
    const eligible = `(${lpOutput} OR ${blueprintProduct})`;
    const pending = (await db.prepare(`SELECT type_id FROM item_types WHERE ${eligible} AND (history_synced_at IS NULL OR history_synced_at < ?) ORDER BY COALESCE(history_synced_at, '') LIMIT 50`).bind(runStartedAt).all<{ type_id: number }>()).results;
    const results = await Promise.all(pending.map(async row => {
      let history: HistoryRow[] = [];
      try {
        history = await esiGet<HistoryRow[]>(`/markets/${MARKET_REGION_ID}/history/`, { type_id: row.type_id });
      } catch (error) {
        if (!isMarketUnavailable(error)) throw error;
      }
      return { row, history, syncedAt: new Date().toISOString() };
    }));
    await batchStatements(db, results.flatMap(({ row, history, syncedAt }) => [
      ...history.map(item => db.prepare("INSERT INTO market_daily (region_id, type_id, trade_date, average_price, highest_price, lowest_price, volume) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(region_id, type_id, trade_date) DO UPDATE SET average_price=excluded.average_price, highest_price=excluded.highest_price, lowest_price=excluded.lowest_price, volume=excluded.volume").bind(MARKET_REGION_ID, row.type_id, item.date, item.average, item.highest, item.lowest, item.volume)),
      db.prepare("UPDATE item_types SET history_synced_at=? WHERE type_id=?").bind(syncedAt, row.type_id),
    ]));
    const remaining = await db.prepare(`SELECT COUNT(*) AS count FROM item_types WHERE ${eligible} AND (history_synced_at IS NULL OR history_synced_at < ?)`).bind(runStartedAt).first<{ count: number }>();
    const result = { done: (remaining?.count ?? 0) === 0, runStartedAt, processed: pending.length, remaining: remaining?.count ?? 0 };
    await updateSyncJob({ kind: "history", status: result.done ? "complete" : "running", phase: result.done ? "完成" : "历史成交日线（50 并发，1 秒间隔）", runStartedAt, processedDelta: pending.length, remaining: result.remaining, endpoint: pending[0] ? `/markets/${MARKET_REGION_ID}/history/?type_id=${pending[0].type_id}` : undefined, httpStatus: 200, response: { ...result, concurrency: 50, intervalMs: 1000 } });
    return Response.json(result);
  } catch (error) {
    const status = error instanceof EsiError && error.status === 420 ? 429 : 502;
    const message = error instanceof Error ? error.message : String(error);
    await updateSyncJob({ kind: "history", status: "error", phase: "已暂停", runStartedAt, endpoint: error instanceof EsiError ? error.path : undefined, httpStatus: error instanceof EsiError ? error.status : status, error: message });
    return Response.json({ error: message, runStartedAt, resumable: true }, { status });
  }
}
