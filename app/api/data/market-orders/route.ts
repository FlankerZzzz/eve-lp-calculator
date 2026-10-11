import { ensureBusinessSchema as ensureSchema } from "../../../../db/business";
import { MARKET_REGION_ID, esiGet } from "../../../../lib/esi-server";

export async function GET(request: Request) {
  const typeId = Number(new URL(request.url).searchParams.get("type_id") || 0);
  if (!Number.isInteger(typeId) || typeId <= 0) return Response.json({ error: "无效的物品 ID" }, { status: 400 });
  const db = await ensureSchema();
  const row = await db.prepare(`
    SELECT t.type_id, COALESCE(t.name_zh, t.name_en, '物品 ' || t.type_id) AS item_name,
      mo.buy_price, mo.sell_price, mo.buy_volume, mo.sell_volume, mo.collected_at
    FROM item_types t LEFT JOIN market_orders mo ON mo.region_id=? AND mo.type_id=t.type_id
    WHERE t.type_id=?
  `).bind(MARKET_REGION_ID, typeId).first();
  if (!row) return Response.json({ error: "本地数据库中没有该物品" }, { status: 404 });
  const rawLevels = (await db.prepare(`SELECT CASE WHEN ob.is_buy_order=1 THEN 'buy' ELSE 'sell' END AS side, ob.price, SUM(ob.volume_remain) AS volume, ob.location_id
    FROM market_order_book ob JOIN market_order_book_state state ON state.active_slot=ob.slot AND state.id=1
    WHERE ob.type_id=? AND ob.location_id IS NOT NULL GROUP BY ob.is_buy_order, ob.price, ob.location_id`).bind(typeId).all<{ side: string; price: number; volume: number; location_id: number }>()).results;
  const locationNames = new Map<number, string>();
  const mappings = new Map((await db.prepare("SELECT location_id,system_name,mapping_name FROM market_location_mappings").all<{ location_id: number; system_name: string; mapping_name: string }>()).results.map(row => [row.location_id, `${row.system_name}·${row.mapping_name}`]));
  await Promise.all([...new Set(rawLevels.map(level => level.location_id))].map(async locationId => {
    if (mappings.has(locationId)) { locationNames.set(locationId, mappings.get(locationId)!); return; }
    try { const station = await esiGet<{ name?: string }>(`/universe/stations/${locationId}/`); locationNames.set(locationId, station.name || `地点 #${locationId}`); }
    catch { locationNames.set(locationId, `地点 #${locationId}`); }
  }));
  const levels = (["buy", "sell"] as const).flatMap(side => rawLevels.filter(level => level.side === side).sort((a, b) => side === "sell" ? a.price - b.price : b.price - a.price).map((level, index) => ({ ...level, level: index + 1, location_name: locationNames.get(level.location_id) || `地点 #${level.location_id}` })));
  const cutoff = new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);
  const history = (await db.prepare(`
    SELECT trade_date, average_price, highest_price, lowest_price, volume
    FROM market_daily
    WHERE region_id=? AND type_id=? AND trade_date>=?
    ORDER BY trade_date DESC
  `).bind(MARKET_REGION_ID, typeId, cutoff).all<{ trade_date: string; average_price: number; highest_price: number; lowest_price: number; volume: number }>()).results;
  const totalVolume = history.reduce((sum, day) => sum + day.volume, 0);
  const weightedAverage = totalVolume ? history.reduce((sum, day) => sum + day.average_price * day.volume, 0) / totalVolume : null;
  return Response.json({
    ...row,
    buy_levels: levels.filter(level => level.side === "buy"),
    sell_levels: levels.filter(level => level.side === "sell"),
    history,
    history_summary: { days: history.length, total_volume: totalVolume, weighted_average: weightedAverage },
    region_id: MARKET_REGION_ID,
    source: "local_database",
  });
}
