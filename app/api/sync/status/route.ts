import { ensureSchema } from "../../../../db/d1";
import { excludedCorporationSql, HIDDEN_CORPORATIONS, HIDDEN_FACTIONS, visibleCorporationSql } from "../../../../lib/data-policy";

const visibleSource = visibleCorporationSql("source");
const invalidSource = excludedCorporationSql("source");
const invalidItemCte = `WITH item_sources AS (
    SELECT o.type_id, c.faction_id, c.corporation_id, COALESCE(o.ak_cost,0) ak_cost FROM lp_offers o JOIN corporations c ON c.corporation_id=o.corporation_id
    UNION ALL SELECT m.type_id, c.faction_id, c.corporation_id, COALESCE(o.ak_cost,0) ak_cost FROM lp_offer_materials m JOIN lp_offers o ON o.corporation_id=m.corporation_id AND o.offer_id=m.offer_id JOIN corporations c ON c.corporation_id=o.corporation_id
    UNION ALL SELECT b.product_type_id, c.faction_id, c.corporation_id, COALESCE(o.ak_cost,0) ak_cost FROM blueprint_recipes b JOIN lp_offers o ON o.type_id=b.blueprint_type_id JOIN corporations c ON c.corporation_id=o.corporation_id
    UNION ALL SELECT bm.material_type_id, c.faction_id, c.corporation_id, COALESCE(o.ak_cost,0) ak_cost FROM blueprint_materials bm JOIN lp_offers o ON o.type_id=bm.blueprint_type_id JOIN corporations c ON c.corporation_id=o.corporation_id
  ), classified AS (
    SELECT source.type_id,
      MAX(CASE WHEN ${invalidSource} THEN 1 ELSE 0 END) AS has_invalid_entity_source,
      MAX(CASE WHEN source.ak_cost>0 THEN 1 ELSE 0 END) AS has_ak_source,
      MAX(CASE WHEN ${visibleSource} AND source.ak_cost=0 THEN 1 ELSE 0 END) AS has_visible_source
    FROM item_sources source GROUP BY source.type_id
  )`;

export async function GET(request: Request) {
  const db = await ensureSchema();
  const showInvalid = new URL(request.url).searchParams.get("show_invalid") === "1";
  const [jobs, events, rawCounts, contracts] = await Promise.all([
    db.prepare("SELECT kind, status, phase, run_started_at, processed, remaining, last_endpoint, last_http_status, last_response, error, updated_at FROM sync_jobs WHERE kind != 'linked' ORDER BY kind").all(),
    db.prepare("SELECT id, kind, phase, endpoint, http_status, response, created_at FROM sync_events WHERE kind != 'linked' ORDER BY id DESC LIMIT 40").all(),
    db.prepare("SELECT (SELECT COUNT(*) FROM corporations) AS corporation_total, (SELECT COUNT(*) FROM corporations WHERE offers_synced_at IS NOT NULL) AS corporation_synced, (SELECT COUNT(*) FROM item_types) AS item_total, (SELECT COUNT(*) FROM item_types WHERE name_zh IS NOT NULL) AS item_named, (SELECT COUNT(*) FROM lp_offers) AS offers, (SELECT COUNT(*) FROM market_daily) AS history_rows, (SELECT COUNT(DISTINCT type_id) FROM market_daily) AS history_types, (SELECT MIN(trade_date) FROM market_daily) AS history_min_date, (SELECT MAX(trade_date) FROM market_daily) AS history_max_date, (SELECT COUNT(*) FROM market_orders) AS order_types, (SELECT order_count FROM market_order_book_state WHERE id=1) AS raw_orders, (SELECT collected_at FROM market_order_book_state WHERE id=1) AS order_snapshot_at").first(),
    db.prepare("SELECT status,started_at,finished_at,last_success_at,heartbeat_at,generation_id,retry_count,directory_contracts,candidate_contracts,cached_contracts,fetched_contracts,unavailable_contracts,matched_contracts,request_count,duration_ms,error_message FROM contract_sync_state WHERE id=1").first(),
  ]);
  const invalidEntities = showInvalid ? [
    ...HIDDEN_FACTIONS.map(entity => ({ entity_type: "势力", entity_id: entity.id, name: entity.name, invalid_reason: entity.reason })),
    ...HIDDEN_CORPORATIONS.map(entity => ({ entity_type: "军团", entity_id: entity.id, name: entity.name, invalid_reason: entity.reason })),
  ] : [];
  const invalidItems = showInvalid ? (await db.prepare(`${invalidItemCte}
    SELECT t.type_id, COALESCE(t.name_zh, t.name_en, '物品 ' || t.type_id) AS name,
    CASE WHEN source.has_ak_source=1 AND source.has_invalid_entity_source=1 THEN '仅与 AK 兑换或已排除实体关联，永久跳过市场查询'
      WHEN source.has_ak_source=1 THEN '仅由需要 Analysis Kredits（AK）的兑换方案产出，永久跳过市场查询'
      ELSE '仅与已排除势力或军团关联，永久跳过市场查询' END AS invalid_reason
    FROM classified source JOIN item_types t ON t.type_id=source.type_id
    WHERE (source.has_invalid_entity_source=1 OR source.has_ak_source=1) AND source.has_visible_source=0 ORDER BY name`).all()).results : [];
  const counts = { ...rawCounts, invalid_entities: HIDDEN_FACTIONS.length + HIDDEN_CORPORATIONS.length, invalid_items: invalidItems.length };
  return Response.json({ jobs: jobs.results, events: events.results, counts, contracts, invalidEntities, invalidItems, invalidItemsHidden: !showInvalid, serverTime: new Date().toISOString() });
}
