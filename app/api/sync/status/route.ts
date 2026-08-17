import { ensureSchema } from "../../../../db/d1";
import { HIDDEN_FACTION_SQL } from "../../../../lib/data-policy";

export async function GET(request: Request) {
  const db = await ensureSchema();
  const showInvalid = new URL(request.url).searchParams.get("show_invalid") === "1";
  const [jobs, events, counts] = await Promise.all([
    db.prepare("SELECT kind, status, phase, run_started_at, processed, remaining, last_endpoint, last_http_status, last_response, error, updated_at FROM sync_jobs ORDER BY kind").all(),
    db.prepare("SELECT id, kind, phase, endpoint, http_status, response, created_at FROM sync_events ORDER BY id DESC LIMIT 40").all(),
    db.prepare(`SELECT (SELECT COUNT(*) FROM corporations) AS corporation_total, (SELECT COUNT(*) FROM corporations WHERE offers_synced_at IS NOT NULL) AS corporation_synced, (SELECT COUNT(*) FROM item_types) AS item_total, (SELECT COUNT(*) FROM item_types WHERE name_zh IS NOT NULL) AS item_named, (SELECT COUNT(*) FROM item_types t WHERE EXISTS (SELECT 1 FROM lp_offers o JOIN corporations c ON c.corporation_id=o.corporation_id WHERE o.type_id=t.type_id AND c.faction_id IN (${HIDDEN_FACTION_SQL}))) AS invalid_items, (SELECT COUNT(*) FROM lp_offers) AS offers, (SELECT COUNT(*) FROM market_daily) AS history_rows, (SELECT COUNT(DISTINCT type_id) FROM market_daily) AS history_types, (SELECT MIN(trade_date) FROM market_daily) AS history_min_date, (SELECT MAX(trade_date) FROM market_daily) AS history_max_date, (SELECT COUNT(*) FROM market_orders) AS order_types`).first(),
  ]);
  const invalidItems = showInvalid ? (await db.prepare(`SELECT t.type_id, COALESCE(t.name_zh, t.name_en, '物品 ' || t.type_id) AS name,
    '策略排除：三神裔、长青船业或真理会' AS invalid_reason
    FROM item_types t
    WHERE EXISTS (SELECT 1 FROM lp_offers o JOIN corporations c ON c.corporation_id=o.corporation_id WHERE o.type_id=t.type_id AND c.faction_id IN (${HIDDEN_FACTION_SQL}))
    ORDER BY name`).all()).results : [];
  return Response.json({ jobs: jobs.results, events: events.results, counts, invalidItems, invalidItemsHidden: !showInvalid, serverTime: new Date().toISOString() });
}
