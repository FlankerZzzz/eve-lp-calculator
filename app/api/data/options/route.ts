import { ensureSchema } from "../../../../db/d1";
import { HIDDEN_FACTION_SQL } from "../../../../lib/data-policy";

export async function GET() {
  const db = await ensureSchema();
  const [factions, corporations, counts] = await Promise.all([
    db.prepare(`SELECT DISTINCT f.faction_id, f.name FROM factions f JOIN corporations c ON c.faction_id=f.faction_id JOIN lp_offers o ON o.corporation_id=c.corporation_id WHERE f.faction_id NOT IN (${HIDDEN_FACTION_SQL}) ORDER BY f.name`).all(),
    db.prepare(`SELECT c.corporation_id, c.faction_id, c.name, COUNT(o.offer_id) AS offer_count FROM corporations c JOIN lp_offers o ON o.corporation_id=c.corporation_id WHERE c.faction_id NOT IN (${HIDDEN_FACTION_SQL}) GROUP BY c.corporation_id, c.faction_id, c.name ORDER BY c.name`).all(),
    db.prepare("SELECT (SELECT COUNT(*) FROM corporations WHERE offers_synced_at IS NOT NULL) AS corporations, (SELECT COUNT(*) FROM item_types WHERE name_zh IS NOT NULL) AS items, (SELECT COUNT(*) FROM lp_offers) AS offers, (SELECT COUNT(*) FROM market_daily) AS history_rows, (SELECT COUNT(*) FROM market_orders) AS order_types").first(),
  ]);
  return Response.json({ factions: factions.results, corporations: corporations.results, counts });
}
