import { ensureSchema } from "../../../../db/d1";
import { HIDDEN_FACTION_SQL } from "../../../../lib/data-policy";
import { MARKET_REGION_ID } from "../../../../lib/esi-server";

type OfferRow = {
  corporation_id: number; offer_id: number; type_id: number; quantity: number; lp_cost: number; isk_cost: number;
  corporation_name: string; faction_id: number | null; faction_name: string | null; item_name: string;
  historical_price: number; daily_volume: number; buy_price: number; sell_price: number; material_total: number;
  lp_ratio: number | null; max_profit: number | null; min_profit: number | null; pricing_complete: number; missing_price_count: number;
  is_blueprint: number; product_type_id: number | null; product_name: string | null; revenue_quantity: number; duplicate_rank: number;
  exchange_signature?: string; manufacturing_signature?: string;
};
type MaterialRow = { corporation_id: number; offer_id: number; type_id: number; quantity: number; item_name: string; buy_price: number; sell_price: number; material_kind: string };
type ImplantSetRow = { type_id: number; name_en: string; name_zh: string | null; sell_price: number; lp_cost: number };
const finiteNumber = (value: string | null, fallback: number) => value === null || value.trim() === "" ? fallback : Number(value);

export async function GET(request: Request) {
  const db = await ensureSchema();
  const url = new URL(request.url);
  const daysRaw = finiteNumber(url.searchParams.get("days"), 30);
  const taxRaw = finiteNumber(url.searchParams.get("tax"), 3);
  const factionId = finiteNumber(url.searchParams.get("faction_id"), 0);
  const corporationId = finiteNumber(url.searchParams.get("corporation_id"), 0);
  const pageRaw = finiteNumber(url.searchParams.get("page"), 1);
  if (![daysRaw, taxRaw, factionId, corporationId, pageRaw].every(Number.isFinite) || daysRaw < 1 || taxRaw < 0 || taxRaw > 100 || factionId < 0 || corporationId < 0 || pageRaw < 1) {
    return Response.json({ error: "查询参数无效" }, { status: 400 });
  }
  const days = Math.min(365, Math.floor(daysRaw));
  const tax = taxRaw;
  const page = Math.floor(pageRaw);
  const sortKey = url.searchParams.get("sort_key") || "lpRatio";
  const sortDirection = url.searchParams.get("sort_direction") === "asc" ? "ASC" : "DESC";
  const cutoff = new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);
  const filters: number[] = [];
  const conditions: string[] = [];
  if (factionId) { conditions.push("c.faction_id = ?"); filters.push(factionId); }
  if (corporationId) { conditions.push("o.corporation_id = ?"); filters.push(corporationId); }
  const where = `WHERE c.faction_id NOT IN (${HIDDEN_FACTION_SQL})${conditions.length ? ` AND ${conditions.join(" AND ")}` : ""}`;

  const baseSql = `
    WITH recent AS (
      SELECT type_id, COALESCE(SUM(average_price * volume) / NULLIF(SUM(volume), 0), 0) historical_price,
        COALESCE(AVG(volume), 0) daily_volume
      FROM market_daily WHERE trade_date >= ? AND region_id = ? GROUP BY type_id
    ), exchange_material AS (
      SELECT m.corporation_id, m.offer_id, SUM(m.quantity * COALESCE(mo.sell_price, 0)) material_total,
        GROUP_CONCAT(m.type_id || ':' || m.quantity, '|') material_signature
      FROM lp_offer_materials m LEFT JOIN market_orders mo ON mo.region_id = ? AND mo.type_id = m.type_id
      GROUP BY m.corporation_id, m.offer_id
    ), manufacturing_material AS (
      SELECT bm.blueprint_type_id, SUM(bm.quantity * COALESCE(mo.sell_price, 0)) material_total,
        GROUP_CONCAT(bm.material_type_id || ':' || bm.quantity, '|') material_signature
      FROM blueprint_materials bm LEFT JOIN market_orders mo ON mo.region_id = ${MARKET_REGION_ID} AND mo.type_id = bm.material_type_id
      GROUP BY bm.blueprint_type_id
    ), calculated AS (
      SELECT o.corporation_id, o.offer_id, o.type_id, o.quantity, o.lp_cost, o.isk_cost,
        c.name corporation_name, c.faction_id, f.name faction_name,
        COALESCE(t.name_zh, t.name_en, '物品 ' || o.type_id) item_name,
        COALESCE(r.historical_price, 0) historical_price, COALESCE(r.daily_volume, 0) daily_volume,
        COALESCE(CASE WHEN br.blueprint_type_id IS NOT NULL THEN pmo.buy_price ELSE mo.buy_price END, 0) buy_price,
        COALESCE(CASE WHEN br.blueprint_type_id IS NOT NULL THEN pmo.sell_price ELSE mo.sell_price END, 0) sell_price,
        COALESCE(em.material_total, 0) + COALESCE(mm.material_total, 0) * o.quantity material_total,
        CASE WHEN br.blueprint_type_id IS NULL THEN 0 ELSE 1 END is_blueprint,
        br.product_type_id, COALESCE(pt.name_zh, pt.name_en) product_name,
        o.quantity * COALESCE(br.product_quantity, 1) revenue_quantity,
        COALESCE(em.material_signature, '') exchange_signature, COALESCE(mm.material_signature, '') manufacturing_signature
      FROM lp_offers o JOIN corporations c ON c.corporation_id = o.corporation_id
      LEFT JOIN factions f ON f.faction_id = c.faction_id
      LEFT JOIN item_types t ON t.type_id = o.type_id
      LEFT JOIN blueprint_recipes br ON br.blueprint_type_id = o.type_id
      LEFT JOIN item_types pt ON pt.type_id = br.product_type_id
      LEFT JOIN recent r ON r.type_id = COALESCE(br.product_type_id, o.type_id)
      LEFT JOIN exchange_material em ON em.corporation_id = o.corporation_id AND em.offer_id = o.offer_id
      LEFT JOIN manufacturing_material mm ON mm.blueprint_type_id = o.type_id
      LEFT JOIN market_orders mo ON mo.region_id = ${MARKET_REGION_ID} AND mo.type_id = o.type_id
      LEFT JOIN market_orders pmo ON pmo.region_id = ${MARKET_REGION_ID} AND pmo.type_id = br.product_type_id
      ${where}
    )
    SELECT calculated.*,
      CASE WHEN lp_cost > 0 THEN (buy_price * revenue_quantity * ? - isk_cost - material_total) / lp_cost ELSE 0 END lp_ratio,
      CASE WHEN sell_price > 0 THEN sell_price * revenue_quantity * ? - isk_cost - material_total END max_profit,
      CASE WHEN buy_price > 0 THEN buy_price * revenue_quantity * ? - isk_cost - material_total END min_profit,
      ROW_NUMBER() OVER (PARTITION BY type_id, quantity, lp_cost, isk_cost, exchange_signature, manufacturing_signature ORDER BY corporation_id, offer_id) duplicate_rank
    FROM calculated`;

  const multiplier = 1 - tax / 100;
  const bindings = [cutoff, MARKET_REGION_ID, MARKET_REGION_ID, ...filters, multiplier, multiplier, multiplier];
  const loadMaterials = async (offers: OfferRow[]) => {
    const map = new Map<string, MaterialRow[]>();
    if (!offers.length) return map;
    for (let index = 0; index < offers.length; index += 20) {
      const batch = offers.slice(index, index + 20);
      const pairValues = batch.flatMap(offer => [offer.corporation_id, offer.offer_id]);
      const mWhere = batch.map(() => "(m.corporation_id=? AND m.offer_id=?)").join(" OR ");
      const oWhere = batch.map(() => "(o.corporation_id=? AND o.offer_id=?)").join(" OR ");
      const rows = (await db.prepare(`
      SELECT m.corporation_id, m.offer_id, m.type_id, m.quantity, COALESCE(t.name_zh, t.name_en, '物品 ' || m.type_id) item_name,
        COALESCE(mo.buy_price, 0) buy_price, COALESCE(mo.sell_price, 0) sell_price, '兑换材料' material_kind
      FROM lp_offer_materials m LEFT JOIN item_types t ON t.type_id=m.type_id
      LEFT JOIN market_orders mo ON mo.region_id=? AND mo.type_id=m.type_id WHERE ${mWhere}
      UNION ALL
      SELECT o.corporation_id, o.offer_id, bm.material_type_id, bm.quantity*o.quantity,
        COALESCE(t.name_zh, t.name_en, '物品 ' || bm.material_type_id), COALESCE(mo.buy_price, 0), COALESCE(mo.sell_price, 0), '制造材料'
      FROM lp_offers o JOIN blueprint_materials bm ON bm.blueprint_type_id=o.type_id
      LEFT JOIN item_types t ON t.type_id=bm.material_type_id
      LEFT JOIN market_orders mo ON mo.region_id=? AND mo.type_id=bm.material_type_id WHERE ${oWhere}
      `).bind(MARKET_REGION_ID, ...pairValues, MARKET_REGION_ID, ...pairValues).all<MaterialRow>()).results;
      for (const row of rows) {
        const key = `${row.corporation_id}:${row.offer_id}`;
        map.set(key, [...(map.get(key) ?? []), row]);
      }
    }
    return map;
  };
  const hydrate = (offers: OfferRow[], materials: Map<string, MaterialRow[]>) => offers.map(offer => ({ ...offer, materials: materials.get(`${offer.corporation_id}:${offer.offer_id}`) ?? [] }));

  if (corporationId && url.searchParams.get("view") === "detail") {
    const requestedSize = url.searchParams.get("page_size") || "10";
    if (requestedSize !== "all" && ![10, 20, 50].includes(Number(requestedSize))) return Response.json({ error: "page_size 无效" }, { status: 400 });
    const total = (await db.prepare("SELECT COUNT(*) count FROM lp_offers WHERE corporation_id=?").bind(corporationId).first<{ count: number }>())?.count ?? 0;
    const pageSize = requestedSize === "all" ? Math.max(1, total) : Number(requestedSize);
    const sortColumns: Record<string, string> = { lp_cost: "lp_cost", isk_cost: "isk_cost", materialCost: "material_total", sell_price: "sell_price", buy_price: "buy_price", maxProfit: "max_profit", minProfit: "min_profit", volume: "daily_volume", lpRatio: "lp_ratio" };
    const sortColumn = sortColumns[sortKey] || "lp_ratio";
    const offers = (await db.prepare(`SELECT * FROM (${baseSql}) ranked ORDER BY ${sortColumn} ${sortDirection} NULLS LAST, item_name, offer_id LIMIT ? OFFSET ?`).bind(...bindings, pageSize, (page - 1) * pageSize).all<OfferRow>()).results;
    const materials = await loadMaterials(offers);
    const implantRows = (await db.prepare(`SELECT t.type_id, COALESCE(t.name_en, '') name_en, t.name_zh, o.lp_cost, COALESCE(mo.sell_price, 0) sell_price FROM lp_offers o JOIN item_types t ON t.type_id=o.type_id LEFT JOIN market_orders mo ON mo.region_id=? AND mo.type_id=t.type_id WHERE o.corporation_id=? AND (t.name_en LIKE '% Alpha' OR t.name_en LIKE '% Beta' OR t.name_en LIKE '% Gamma' OR t.name_en LIKE '% Delta' OR t.name_en LIKE '% Epsilon' OR t.name_en LIKE '% Omega')`).bind(MARKET_REGION_ID, corporationId).all<ImplantSetRow>()).results;
    const levels = ["Alpha", "Beta", "Gamma", "Delta", "Epsilon", "Omega"];
    const grouped = new Map<string, Map<string, ImplantSetRow>>();
    for (const row of implantRows) {
      const level = levels.find(value => row.name_en.endsWith(` ${value}`));
      if (!level) continue;
      const family = row.name_en.slice(0, -level.length - 1);
      const set = grouped.get(family) ?? new Map<string, ImplantSetRow>();
      set.set(level, row);
      grouped.set(family, set);
    }
    const implantSets = [...grouped.entries()].filter(([, set]) => set.size === 6).map(([name, set]) => {
      const items = levels.map(level => set.get(level)!);
      const chineseName = items[0].name_zh?.replace(/[—-]?(?:阿尔法|贝它|伽玛|德尔塔|伊普西隆|欧米伽)型$/, "").replace(/[—\-\s]+$/, "");
      const totalLp = items.reduce((sum, item) => sum + item.lp_cost, 0);
      const marketValue = items.every(item => item.sell_price > 0) ? items.reduce((sum, item) => sum + item.sell_price, 0) : null;
      return { name: chineseName || name, item_count: 6, total_lp: totalLp, lp_ratio: marketValue !== null && totalLp > 0 ? marketValue / totalLp : null, priced_count: items.filter(item => item.sell_price > 0).length, market_value: marketValue, items: items.map((item, index) => ({ level: levels[index], type_id: item.type_id, name: item.name_zh || item.name_en, lp_cost: item.lp_cost, sell_price: item.sell_price })) };
    });
    return Response.json({ view: "detail", offers: hydrate(offers, materials), total, page, pageSize: requestedSize === "all" ? "all" : pageSize, pages: requestedSize === "all" ? 1 : Math.max(1, Math.ceil(total / pageSize)), days, implant_sets: implantSets });
  }

  const snapshots = (await db.prepare("SELECT list_kind, rank, snapshot_date, calculated_at, payload FROM ranking_snapshots ORDER BY list_kind, rank").all<{ list_kind: string; rank: number; snapshot_date: string; calculated_at: string; payload: string }>()).results;
  const parse = (kind: string) => snapshots.filter(row => row.list_kind === kind).map(row => JSON.parse(row.payload));
  return Response.json({
    popular: parse("popular"),
    highRatio: parse("highRatio"),
    days,
    snapshotDate: snapshots[0]?.snapshot_date ?? null,
    calculatedAt: snapshots[0]?.calculated_at ?? null,
  });
}
