import { ensureSchema } from "../../../../db/d1";
import { batchStatements, EsiError, esiGet, fetchMarketOrders, isMarketUnavailable, MARKET_REGION_ID, orderLevelStatements, summarizeOrders } from "../../../../lib/esi-server";
import { updateSyncJob } from "../../../../db/sync-state";
import { HIDDEN_FACTION_SQL } from "../../../../lib/data-policy";

type HistoryRow = { date: string; average: number; highest: number; lowest: number; volume: number };
type PendingItem = { type_id: number; history_synced_at: string | null; order_synced_at: string | null; is_output: number; is_material: number };

const visibleOutput = `EXISTS (SELECT 1 FROM lp_offers o JOIN corporations c ON c.corporation_id=o.corporation_id WHERE o.type_id=item_types.type_id AND c.faction_id NOT IN (${HIDDEN_FACTION_SQL}))`;
const visibleMaterial = `EXISTS (SELECT 1 FROM lp_offer_materials m JOIN corporations c ON c.corporation_id=m.corporation_id WHERE m.type_id=item_types.type_id AND c.faction_id NOT IN (${HIDDEN_FACTION_SQL}))`;
const blueprintProduct = `EXISTS (SELECT 1 FROM blueprint_recipes b JOIN lp_offers o ON o.type_id=b.blueprint_type_id JOIN corporations c ON c.corporation_id=o.corporation_id WHERE b.product_type_id=item_types.type_id AND c.faction_id NOT IN (${HIDDEN_FACTION_SQL}))`;
const blueprintMaterial = `EXISTS (SELECT 1 FROM blueprint_materials bm JOIN lp_offers o ON o.type_id=bm.blueprint_type_id JOIN corporations c ON c.corporation_id=o.corporation_id WHERE bm.material_type_id=item_types.type_id AND c.faction_id NOT IN (${HIDDEN_FACTION_SQL}))`;
const relevantPendingWhere = `
  name_zh IS NOT NULL AND (
    ((${visibleOutput} OR ${blueprintProduct})
      AND (history_synced_at IS NULL OR history_synced_at < ?))
    OR
    ((${visibleOutput} OR ${visibleMaterial} OR ${blueprintProduct} OR ${blueprintMaterial})
      AND (order_synced_at IS NULL OR order_synced_at < ?))
  )`;

export async function POST(request: Request) {
  const db = await ensureSchema();
  const body = await request.json().catch(() => ({})) as { runStartedAt?: string };
  const runStartedAt = body.runStartedAt || new Date().toISOString();
  try {
    await updateSyncJob({ kind: "linked", status: "running", phase: "关联市场数据", runStartedAt, response: { message: "正在为已准备物品关联历史成交与当前订单" } });
    const pending = (await db.prepare(`
      SELECT type_id, history_synced_at, order_synced_at,
        (${visibleOutput} OR ${blueprintProduct}) AS is_output,
        (${visibleMaterial} OR ${blueprintMaterial}) AS is_material
      FROM item_types
      WHERE ${relevantPendingWhere}
      ORDER BY CASE WHEN ${visibleOutput} THEN 0 ELSE 1 END,
        CASE WHEN history_synced_at IS NULL AND order_synced_at IS NULL THEN 0 ELSE 1 END,
        COALESCE(history_synced_at, ''), COALESCE(order_synced_at, ''), type_id
      LIMIT 1
    `).bind(runStartedAt, runStartedAt).all<PendingItem>()).results;

    for (const row of pending) {
      const historyPending = Boolean(row.is_output) && (!row.history_synced_at || row.history_synced_at < runStartedAt);
      const ordersPending = !row.order_synced_at || row.order_synced_at < runStartedAt;
      let notTradable = false;
      if (historyPending) {
        try {
          const history = await esiGet<HistoryRow[]>(`/markets/${MARKET_REGION_ID}/history/`, { type_id: row.type_id });
          const now = new Date().toISOString();
          const statements = history.map(item => db.prepare("INSERT INTO market_daily (region_id, type_id, trade_date, average_price, highest_price, lowest_price, volume) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(region_id, type_id, trade_date) DO UPDATE SET average_price=excluded.average_price, highest_price=excluded.highest_price, lowest_price=excluded.lowest_price, volume=excluded.volume").bind(MARKET_REGION_ID, row.type_id, item.date, item.average, item.highest, item.lowest, item.volume));
          statements.push(db.prepare("UPDATE item_types SET history_synced_at=? WHERE type_id=?").bind(now, row.type_id));
          await batchStatements(db, statements);
        } catch (error) {
          if (!isMarketUnavailable(error)) throw error;
          notTradable = true;
          const now = new Date().toISOString();
          await db.prepare("UPDATE item_types SET history_synced_at=?, order_synced_at=? WHERE type_id=?").bind(now, now, row.type_id).run();
        }
      }
      if (ordersPending && !notTradable) {
        try {
          const summary = summarizeOrders(await fetchMarketOrders(row.type_id));
          const now = new Date().toISOString();
          await batchStatements(db, [
            db.prepare("INSERT INTO market_orders (region_id, type_id, buy_price, sell_price, buy_volume, sell_volume, collected_at) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(region_id, type_id) DO UPDATE SET buy_price=excluded.buy_price, sell_price=excluded.sell_price, buy_volume=excluded.buy_volume, sell_volume=excluded.sell_volume, collected_at=excluded.collected_at").bind(MARKET_REGION_ID, row.type_id, summary.buyPrice, summary.sellPrice, summary.buyVolume, summary.sellVolume, now),
            ...orderLevelStatements(db, row.type_id, summary, now),
            db.prepare("UPDATE item_types SET order_synced_at=? WHERE type_id=?").bind(now, row.type_id),
          ]);
        } catch (error) {
          if (!isMarketUnavailable(error)) throw error;
          notTradable = true;
          await db.prepare("UPDATE item_types SET order_synced_at=? WHERE type_id=?").bind(new Date().toISOString(), row.type_id).run();
        }
      }
    }

    const remaining = await db.prepare(`SELECT COUNT(*) AS count FROM item_types WHERE ${relevantPendingWhere}`).bind(runStartedAt, runStartedAt).first<{ count: number }>();
    const result = { done: (remaining?.count ?? 0) === 0, runStartedAt, processed: pending.length, remaining: remaining?.count ?? 0 };
    await updateSyncJob({ kind: "linked", status: result.done ? "complete" : "running", phase: result.done ? "完成" : "关联市场数据", runStartedAt, processedDelta: pending.length, remaining: result.remaining, endpoint: pending[0] ? `/markets/${MARKET_REGION_ID}/history + orders · type_id=${pending[0].type_id}` : undefined, httpStatus: 200, response: result });
    return Response.json(result);
  } catch (error) {
    const status = error instanceof EsiError && error.status === 420 ? 429 : 502;
    const message = error instanceof Error ? error.message : String(error);
    await updateSyncJob({ kind: "linked", status: "error", phase: "已暂停", runStartedAt, endpoint: error instanceof EsiError ? error.path : undefined, httpStatus: error instanceof EsiError ? error.status : status, error: message });
    return Response.json({ error: message, runStartedAt, resumable: true }, { status });
  }
}
