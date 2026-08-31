import { ensureSchema } from "../../../../db/d1";
import { isGloballyExcludedCorporation, visibleCorporationSql } from "../../../../lib/data-policy";
import { MARKET_REGION_ID } from "../../../../lib/esi-server";

type OfferRow = {
  corporation_id: number; offer_id: number; type_id: number; quantity: number; lp_cost: number; isk_cost: number;
  corporation_name: string; faction_id: number | null; faction_name: string | null; item_name: string;
  historical_price: number; history_30: number; history_15: number; history_7: number; history_3: number; history_1: number;
  daily_volume: number; buy_price: number; sell_price: number; material_total: number;
  lp_ratio: number | null; max_profit: number | null; min_profit: number | null; pricing_complete: number; missing_price_count: number;
  is_blueprint: number; product_type_id: number | null; product_name: string | null; revenue_quantity: number; duplicate_rank: number;
  exchange_signature?: string; manufacturing_signature?: string;
};
type HistoryPrices = { 30: number; 15: number; 7: number; 3: number; 1: number };
type MaterialRow = { corporation_id: number; offer_id: number; type_id: number; quantity: number; item_name: string; buy_price: number; sell_price: number; sell_available_volume: number; material_kind: string; historical_prices?: HistoryPrices; sell_execution_price?: number; sell_execution_coverage?: number };
type OrderLevelRow = { type_id: number; side: "buy" | "sell"; price: number; volume: number };
type HistoryRow = { type_id: number; trade_date: string; average_price: number; volume: number };
type DailyVolumePoint = { trade_date: string; volume: number };
type ImplantSetRow = { corporation_id: number; offer_id: number; type_id: number; blueprint_type_id: number; is_blueprint: number; name_en: string; name_zh: string | null; buy_price: number; sell_price: number; expected_price: number; lp_cost: number; isk_cost: number; material_cost: number };
const finiteNumber = (value: string | null, fallback: number) => value === null || value.trim() === "" ? fallback : Number(value);
const visibleCorporation = visibleCorporationSql("c");
const HISTORY_WINDOWS = [30, 15, 7, 3, 1] as const;
const emptyHistory = (): HistoryPrices => ({ 30: 0, 15: 0, 7: 0, 3: 0, 1: 0 });
const chinaDate = () => new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
const historyCutoff = (days: number, anchorDate = chinaDate()) => {
  const date = new Date(`${anchorDate}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() - (days - 1));
  return date.toISOString().slice(0, 10);
};
const historyDates = (anchorDate: string, days: number) => Array.from({ length: days }, (_, index) => {
  const date = new Date(`${anchorDate}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() - (days - 1 - index));
  return date.toISOString().slice(0, 10);
});
const executionPrice = (levels: OrderLevelRow[], quantity: number) => {
  if (quantity <= 0 || !levels.length) return { price: 0, coverage: 0 };
  let remaining = quantity;
  let filled = 0;
  let value = 0;
  for (const level of levels) {
    const taken = Math.min(remaining, level.volume);
    filled += taken;
    value += taken * level.price;
    remaining -= taken;
    if (remaining <= 0) break;
  }
  return { price: filled > 0 ? value / filled : 0, coverage: Math.min(1, filled / quantity) };
};

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
  if (corporationId) {
    const corporation = await db.prepare("SELECT faction_id FROM corporations WHERE corporation_id=?").bind(corporationId).first<{ faction_id: number | null }>();
    if (corporation && isGloballyExcludedCorporation(corporationId, corporation.faction_id)) return Response.json({ error: "该企业已按数据策略排除" }, { status: 404 });
  }
  const days = Math.min(365, Math.floor(daysRaw));
  const tax = taxRaw;
  const page = Math.floor(pageRaw);
  const sortKey = url.searchParams.get("sort_key") || "lpRatio";
  const sortDirection = url.searchParams.get("sort_direction") === "asc" ? "ASC" : "DESC";
  const includeBoosterBlueprints = url.searchParams.get("include_booster_blueprints") === "1";
  const latestHistoryDate = (await db.prepare("SELECT MAX(trade_date) AS date FROM market_daily WHERE region_id=?").bind(MARKET_REGION_ID).first<{ date: string | null }>())?.date ?? chinaDate();
  const cutoff = historyCutoff(days, latestHistoryDate);
  const historyCutoffs = Object.fromEntries(HISTORY_WINDOWS.map(window => [window, historyCutoff(window, latestHistoryDate)])) as Record<(typeof HISTORY_WINDOWS)[number], string>;
  const filters: number[] = [];
  const conditions: string[] = [];
  if (factionId) { conditions.push("c.faction_id = ?"); filters.push(factionId); }
  if (corporationId) { conditions.push("o.corporation_id = ?"); filters.push(corporationId); }
  if (!includeBoosterBlueprints) conditions.push(`NOT (br.blueprint_type_id IS NOT NULL AND (
    COALESCE(t.name_zh, '') LIKE '%增效体%' OR COALESCE(t.name_zh, '') LIKE '%增效剂%'
    OR COALESCE(pt.name_zh, '') LIKE '%增效体%' OR COALESCE(pt.name_zh, '') LIKE '%增效剂%'
    OR LOWER(COALESCE(t.name_en, '')) LIKE '%booster%blueprint%'
    OR LOWER(COALESCE(pt.name_en, '')) LIKE '%booster%'
  ))`);
  const where = `WHERE ${visibleCorporation}${conditions.length ? ` AND ${conditions.join(" AND ")}` : ""}`;

  const baseSql = `
    WITH recent AS (
      SELECT type_id, COALESCE(SUM(average_price * volume) / NULLIF(SUM(volume), 0), 0) historical_price,
        COALESCE(SUM(CASE WHEN trade_date >= ? THEN average_price * volume ELSE 0 END) / NULLIF(SUM(CASE WHEN trade_date >= ? THEN volume ELSE 0 END), 0), 0) history_30,
        COALESCE(SUM(CASE WHEN trade_date >= ? THEN average_price * volume ELSE 0 END) / NULLIF(SUM(CASE WHEN trade_date >= ? THEN volume ELSE 0 END), 0), 0) history_15,
        COALESCE(SUM(CASE WHEN trade_date >= ? THEN average_price * volume ELSE 0 END) / NULLIF(SUM(CASE WHEN trade_date >= ? THEN volume ELSE 0 END), 0), 0) history_7,
        COALESCE(SUM(CASE WHEN trade_date >= ? THEN average_price * volume ELSE 0 END) / NULLIF(SUM(CASE WHEN trade_date >= ? THEN volume ELSE 0 END), 0), 0) history_3,
        COALESCE((SELECT md2.average_price FROM market_daily md2 WHERE md2.region_id = ? AND md2.type_id = market_daily.type_id ORDER BY md2.trade_date DESC LIMIT 1), 0) history_1,
        COALESCE(SUM(volume) / ?, 0) daily_volume
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
        COALESCE(r.historical_price, 0) historical_price,
        COALESCE(r.history_30, 0) history_30, COALESCE(r.history_15, 0) history_15,
        COALESCE(r.history_7, 0) history_7, COALESCE(r.history_3, 0) history_3, COALESCE(r.history_1, 0) history_1,
        COALESCE(r.daily_volume, 0) daily_volume,
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
  const bindings = [
    historyCutoffs[30], historyCutoffs[30], historyCutoffs[15], historyCutoffs[15], historyCutoffs[7], historyCutoffs[7],
    historyCutoffs[3], historyCutoffs[3], MARKET_REGION_ID, days, cutoff, MARKET_REGION_ID, MARKET_REGION_ID,
    ...filters, multiplier, multiplier, multiplier,
  ];
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
        COALESCE(mo.buy_price, 0) buy_price, COALESCE(mo.sell_price, 0) sell_price,
        COALESCE((SELECT SUM(mol.volume) FROM market_order_levels mol WHERE mol.region_id=${MARKET_REGION_ID} AND mol.type_id=m.type_id AND mol.side='sell'), 0) sell_available_volume,
        '兑换材料' material_kind
      FROM lp_offer_materials m LEFT JOIN item_types t ON t.type_id=m.type_id
      LEFT JOIN market_orders mo ON mo.region_id=? AND mo.type_id=m.type_id WHERE ${mWhere}
      UNION ALL
      SELECT o.corporation_id, o.offer_id, bm.material_type_id, bm.quantity*o.quantity,
        COALESCE(t.name_zh, t.name_en, '物品 ' || bm.material_type_id), COALESCE(mo.buy_price, 0), COALESCE(mo.sell_price, 0),
        COALESCE((SELECT SUM(mol.volume) FROM market_order_levels mol WHERE mol.region_id=${MARKET_REGION_ID} AND mol.type_id=bm.material_type_id AND mol.side='sell'), 0),
        '制造材料'
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
  const loadHistoryData = async (typeIds: number[]) => {
    const priceMap = new Map<number, HistoryPrices>();
    const volumes = new Map<number, DailyVolumePoint[]>();
    const volumeDates = historyDates(latestHistoryDate, 30);
    const unique = [...new Set(typeIds)];
    for (let index = 0; index < unique.length; index += 400) {
      const batch = unique.slice(index, index + 400);
      const placeholders = batch.map(() => "?").join(",");
      const rows = (await db.prepare(`SELECT type_id, trade_date, average_price, volume FROM market_daily WHERE region_id=? AND trade_date>=? AND type_id IN (${placeholders})`).bind(MARKET_REGION_ID, historyCutoffs[30], ...batch).all<HistoryRow>()).results;
      const totals = new Map<number, Record<number, { value: number; volume: number }>>();
      const latest = new Map<number, HistoryRow>();
      const dailyByType = new Map<number, Map<string, number>>();
      for (const row of rows) {
        const previousLatest = latest.get(row.type_id);
        if (!previousLatest || row.trade_date > previousLatest.trade_date) latest.set(row.type_id, row);
        const windows = totals.get(row.type_id) ?? Object.fromEntries(HISTORY_WINDOWS.map(window => [window, { value: 0, volume: 0 }]));
        for (const window of HISTORY_WINDOWS) if (window !== 1 && row.trade_date >= historyCutoffs[window]) {
          windows[window].value += row.average_price * row.volume;
          windows[window].volume += row.volume;
        }
        totals.set(row.type_id, windows);
        const daily = dailyByType.get(row.type_id) ?? new Map<string, number>();
        daily.set(row.trade_date, row.volume);
        dailyByType.set(row.type_id, daily);
      }
      for (const typeId of batch) {
        const windowPrices = emptyHistory();
        const totalsForType = totals.get(typeId);
        for (const window of HISTORY_WINDOWS) windowPrices[window] = window === 1
          ? latest.get(typeId)?.average_price ?? 0
          : totalsForType?.[window].volume ? totalsForType[window].value / totalsForType[window].volume : 0;
        priceMap.set(typeId, windowPrices);
        const daily = dailyByType.get(typeId);
        volumes.set(typeId, volumeDates.map(trade_date => ({ trade_date, volume: daily?.get(trade_date) ?? 0 })));
      }
    }
    return { prices: priceMap, volumes };
  };
  const loadOrderLevels = async (typeIds: number[]) => {
    const result = new Map<number, { buy: OrderLevelRow[]; sell: OrderLevelRow[] }>();
    const unique = [...new Set(typeIds)];
    for (let index = 0; index < unique.length; index += 400) {
      const batch = unique.slice(index, index + 400);
      const placeholders = batch.map(() => "?").join(",");
      const rows = (await db.prepare(`SELECT type_id, side, price, volume FROM market_order_levels WHERE region_id=? AND type_id IN (${placeholders}) ORDER BY type_id, side, level`).bind(MARKET_REGION_ID, ...batch).all<OrderLevelRow>()).results;
      for (const row of rows) {
        const book = result.get(row.type_id) ?? { buy: [], sell: [] };
        book[row.side].push(row);
        result.set(row.type_id, book);
      }
    }
    return result;
  };
  const hydrate = async (offers: OfferRow[], materials: Map<string, MaterialRow[]>) => {
    const allMaterials = [...materials.values()].flat();
    const outputTypeIds = offers.map(offer => offer.product_type_id || offer.type_id);
    const allTypeIds = [...outputTypeIds, ...allMaterials.map(material => material.type_id)];
    const [historyData, orderLevels] = await Promise.all([loadHistoryData(allTypeIds), loadOrderLevels(allTypeIds)]);
    for (const material of allMaterials) {
      material.historical_prices = historyData.prices.get(material.type_id) ?? emptyHistory();
      const execution = executionPrice(orderLevels.get(material.type_id)?.sell ?? [], material.quantity);
      material.sell_execution_price = execution.price || material.sell_price;
      material.sell_execution_coverage = execution.price ? execution.coverage : material.sell_price > 0 ? 1 : 0;
    }
    return offers.map(offer => {
      const typeId = offer.product_type_id || offer.type_id;
      const execution = executionPrice(orderLevels.get(typeId)?.buy ?? [], offer.revenue_quantity || offer.quantity);
      return {
        ...offer,
        historical_prices: historyData.prices.get(typeId) ?? { 30: offer.history_30, 15: offer.history_15, 7: offer.history_7, 3: offer.history_3, 1: offer.history_1 },
        daily_volumes: historyData.volumes.get(typeId) ?? [],
        buy_execution_price: execution.price || offer.buy_price,
        buy_execution_coverage: execution.price ? execution.coverage : offer.buy_price > 0 ? 1 : 0,
        materials: materials.get(`${offer.corporation_id}:${offer.offer_id}`) ?? [],
      };
    });
  };

  if (corporationId && url.searchParams.get("view") === "detail") {
    const requestedSize = url.searchParams.get("page_size") || "10";
    if (requestedSize !== "all" && ![10, 20, 50].includes(Number(requestedSize))) return Response.json({ error: "page_size 无效" }, { status: 400 });
    const total = (await db.prepare(`SELECT COUNT(*) count FROM (${baseSql}) ranked`).bind(...bindings).first<{ count: number }>())?.count ?? 0;
    const pageSize = requestedSize === "all" ? Math.max(1, total) : Number(requestedSize);
    const sortColumns: Record<string, string> = { lp_cost: "lp_cost", isk_cost: "isk_cost", materialCost: "material_total", sell_price: "sell_price", buy_price: "buy_price", maxProfit: "max_profit", minProfit: "min_profit", volume: "daily_volume", lpRatio: "lp_ratio" };
    const sortColumn = sortColumns[sortKey] || "lp_ratio";
    const offers = (await db.prepare(`SELECT * FROM (${baseSql}) ranked ORDER BY ${sortColumn} ${sortDirection} NULLS LAST, item_name, offer_id LIMIT ? OFFSET ?`).bind(...bindings, pageSize, (page - 1) * pageSize).all<OfferRow>()).results;
    const materials = await loadMaterials(offers);
    const implantRows = (await db.prepare(`SELECT o.corporation_id, o.offer_id, COALESCE(pt.type_id, t.type_id) type_id, t.type_id blueprint_type_id, CASE WHEN br.blueprint_type_id IS NULL THEN 0 ELSE 1 END is_blueprint, COALESCE(pt.name_en, t.name_en, '') name_en, COALESCE(pt.name_zh, t.name_zh) name_zh, o.lp_cost, o.isk_cost, COALESCE(mo.buy_price, 0) buy_price, COALESCE(mo.sell_price, 0) sell_price, COALESCE((SELECT SUM(md.average_price * md.volume) / NULLIF(SUM(md.volume), 0) FROM market_daily md WHERE md.region_id=? AND md.type_id=COALESCE(pt.type_id, t.type_id) AND md.trade_date>=?), 0) expected_price, COALESCE((SELECT SUM(m.quantity * COALESCE(mo2.sell_price, 0)) FROM lp_offer_materials m LEFT JOIN market_orders mo2 ON mo2.region_id=? AND mo2.type_id=m.type_id WHERE m.corporation_id=o.corporation_id AND m.offer_id=o.offer_id), 0) + COALESCE((SELECT SUM(bm.quantity * COALESCE(mo3.sell_price, 0)) FROM blueprint_materials bm LEFT JOIN market_orders mo3 ON mo3.region_id=? AND mo3.type_id=bm.material_type_id WHERE bm.blueprint_type_id=br.blueprint_type_id), 0) material_cost FROM lp_offers o JOIN item_types t ON t.type_id=o.type_id LEFT JOIN blueprint_recipes br ON br.blueprint_type_id=o.type_id LEFT JOIN item_types pt ON pt.type_id=br.product_type_id LEFT JOIN market_orders mo ON mo.region_id=? AND mo.type_id=COALESCE(br.product_type_id, t.type_id) WHERE o.corporation_id=? AND (COALESCE(pt.name_en, t.name_en) LIKE '% Alpha' OR COALESCE(pt.name_en, t.name_en) LIKE '% Beta' OR COALESCE(pt.name_en, t.name_en) LIKE '% Gamma' OR COALESCE(pt.name_en, t.name_en) LIKE '% Delta' OR COALESCE(pt.name_en, t.name_en) LIKE '% Epsilon' OR COALESCE(pt.name_en, t.name_en) LIKE '% Omega')`).bind(MARKET_REGION_ID, cutoff, MARKET_REGION_ID, MARKET_REGION_ID, MARKET_REGION_ID, corporationId).all<ImplantSetRow>()).results;
    const implantMaterials = await loadMaterials(implantRows as unknown as OfferRow[]);
    const levels = ["Alpha", "Beta", "Gamma", "Delta", "Epsilon", "Omega"];
    const grouped = new Map<string, Map<string, ImplantSetRow>>();
    for (const row of implantRows) {
      const level = levels.find(value => row.name_en.endsWith(` ${value}`));
      if (!level) continue;
      const family = row.name_en.slice(0, -level.length - 1);
      const groupKey = `${family}|${row.is_blueprint ? "blueprint" : "direct"}`;
      const set = grouped.get(groupKey) ?? new Map<string, ImplantSetRow>();
      set.set(level, row);
      grouped.set(groupKey, set);
    }
    const implantSets = [...grouped.entries()].filter(([, set]) => set.size === 6).map(([groupKey, set]) => {
      const [name, source] = groupKey.split("|");
      const items = levels.map(level => set.get(level)!);
      const chineseName = items[0].name_zh?.replace(/[—-]?(?:阿尔法|贝它|伽玛|德尔塔|伊普西隆|欧米伽)型$/, "").replace(/[—\-\s]+$/, "");
      const totalLp = items.reduce((sum, item) => sum + item.lp_cost, 0);
      const valuationPrice = (item: ImplantSetRow) => item.buy_price > 0 ? item.buy_price : item.expected_price;
      const priceSource = (item: ImplantSetRow) => item.buy_price > 0 ? "buy" : item.expected_price > 0 ? "expected" : "missing";
      const marketValue = items.every(item => valuationPrice(item) > 0) ? items.reduce((sum, item) => sum + valuationPrice(item), 0) : null;
      const netProfit = marketValue !== null ? items.reduce((sum, item) => sum + valuationPrice(item) * 0.97 - item.isk_cost - item.material_cost, 0) : null;
      return { name: chineseName || name, is_blueprint: source === "blueprint", item_count: 6, total_lp: totalLp, lp_ratio: netProfit !== null && totalLp > 0 ? netProfit / totalLp : null, priced_count: items.filter(item => valuationPrice(item) > 0).length, market_value: marketValue, items: items.map((item, index) => ({ level: levels[index], type_id: item.blueprint_type_id, market_type_id: item.type_id, name: item.name_zh || item.name_en, lp_cost: item.lp_cost, buy_price: item.buy_price, expected_price: item.expected_price, sell_price: item.sell_price, valuation_price: valuationPrice(item), price_source: priceSource(item), materials: implantMaterials.get(`${item.corporation_id}:${item.offer_id}`) ?? [] })) };
    });
    return Response.json({ view: "detail", offers: await hydrate(offers, materials), total, page, pageSize: requestedSize === "all" ? "all" : pageSize, pages: requestedSize === "all" ? 1 : Math.max(1, Math.ceil(total / pageSize)), days, historyLatestDate: latestHistoryDate, implant_sets: implantSets });
  }

  const snapshots = (await db.prepare("SELECT list_kind, rank, snapshot_date, calculated_at, payload FROM ranking_snapshots WHERE rank <= 100 ORDER BY list_kind, rank").all<{ list_kind: string; rank: number; snapshot_date: string; calculated_at: string; payload: string }>()).results;
  const isBoosterBlueprint = (offer: OfferRow) => Boolean(offer.is_blueprint) && /增效体|增效剂|booster/i.test(`${offer.item_name || ""} ${offer.product_name || ""}`);
  const parse = (kind: string) => snapshots.filter(row => row.list_kind === kind).map(row => JSON.parse(row.payload) as OfferRow & { materials?: MaterialRow[] }).filter(offer => !isGloballyExcludedCorporation(offer.corporation_id, offer.faction_id)).filter(offer => includeBoosterBlueprints || !isBoosterBlueprint(offer)).slice(0, 100);
  const hydrateSnapshot = async (offers: (OfferRow & { materials?: MaterialRow[] })[]) => {
    const materialMap = new Map<string, MaterialRow[]>();
    for (const offer of offers) materialMap.set(`${offer.corporation_id}:${offer.offer_id}`, offer.materials ?? []);
    return hydrate(offers, materialMap);
  };
  const [popular, highRatio] = await Promise.all([hydrateSnapshot(parse("popular")), hydrateSnapshot(parse("highRatio"))]);
  return Response.json({
    popular,
    highRatio,
    days,
    historyLatestDate: latestHistoryDate,
    snapshotDate: snapshots[0]?.snapshot_date ?? null,
    calculatedAt: snapshots[0]?.calculated_at ?? null,
  });
}
