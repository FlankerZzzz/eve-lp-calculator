import { ensureSchema } from "../../../../db/d1";
import { MARKET_REGION_ID } from "../../../../lib/esi-server";

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
  const levels = (await db.prepare("SELECT side, level, price, volume FROM market_order_levels WHERE region_id=? AND type_id=? ORDER BY side, level").bind(MARKET_REGION_ID, typeId).all<{ side: string; level: number; price: number; volume: number }>()).results;
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
