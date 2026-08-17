import { ensureSchema } from "../../../../db/d1";
import { batchStatements, EsiError, esiGet, esiPost } from "../../../../lib/esi-server";
import { updateSyncJob } from "../../../../db/sync-state";
import { NPC_CORPORATION_FACTIONS } from "../../../../lib/npc-factions";

type Faction = { faction_id: number; name: string };
type Corporation = { name: string; faction_id?: number };
type ResolvedName = { category: string; id: number; name: string };
type Offer = { offer_id: number; type_id: number; quantity: number; lp_cost: number; isk_cost: number; ak_cost?: number; required_items?: { type_id: number; quantity: number }[] };
type BlueprintPart = { type_id?: number; quantity?: number };
type Blueprint = { activities?: Record<string, { materials?: Record<string, BlueprintPart>; products?: Record<string, BlueprintPart> }> };

async function fetchBlueprint(typeId: number) {
  const response = await fetch(`https://ref-data.everef.net/blueprints/${typeId}`, { headers: { accept: "application/json", "user-agent": "Chenxi-LP-Calculator/local" }, signal: AbortSignal.timeout(15000) });
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`蓝图 SDE ${response.status}: ${typeId}`);
  return response.json() as Promise<Blueprint>;
}

export async function POST(request: Request) {
  const db = await ensureSchema();
  const now = new Date().toISOString();
  const body = await request.json().catch(() => ({})) as { runStartedAt?: string };
  const runStartedAt = body.runStartedAt || now;
  try {
    await updateSyncJob({ kind: "catalog", status: "running", phase: "发现军团", runStartedAt, endpoint: "/corporations/npccorps/", response: { message: "开始读取势力与 NPC 军团目录" } });
    const corporationCount = await db.prepare("SELECT COUNT(*) AS count FROM corporations").first<{ count: number }>();
    if (!corporationCount?.count) {
      const [factions, corporationIds] = await Promise.all([
        esiGet<Faction[]>("/universe/factions/", { language: "zh" }).catch(() => esiGet<Faction[]>("/universe/factions/")),
        esiGet<number[]>("/corporations/npccorps/"),
      ]);
      const statements = [
        ...factions.map(row => db.prepare("INSERT INTO factions (faction_id, name, updated_at) VALUES (?, ?, ?) ON CONFLICT(faction_id) DO UPDATE SET name=excluded.name, updated_at=excluded.updated_at").bind(row.faction_id, row.name, now)),
        ...corporationIds.map(id => db.prepare("INSERT OR IGNORE INTO corporations (corporation_id, name, updated_at) VALUES (?, ?, ?)").bind(id, `Corporation ${id}`, now)),
      ];
      await batchStatements(db, statements);
    }

    const unmappedCorporations = (await db.prepare("SELECT corporation_id FROM corporations WHERE faction_id IS NULL ORDER BY corporation_id LIMIT 100").all<{ corporation_id: number }>()).results;
    const factionUpdates = unmappedCorporations.flatMap(row => {
      const factionId = NPC_CORPORATION_FACTIONS[row.corporation_id];
      return factionId ? [db.prepare("UPDATE corporations SET faction_id=?, updated_at=? WHERE corporation_id=?").bind(factionId, now, row.corporation_id)] : [];
    });
    if (factionUpdates.length) {
      await batchStatements(db, factionUpdates);
      const remaining = await db.prepare("SELECT COUNT(*) AS count FROM corporations WHERE faction_id IS NULL").first<{ count: number }>();
      const result = { done: false, phase: "corporation_factions", processed: factionUpdates.length, remaining: remaining?.count ?? 0 };
      await updateSyncJob({ kind: "catalog", status: "running", phase: "企业势力归属", runStartedAt, processedDelta: factionUpdates.length, remaining: result.remaining, endpoint: "CCP SDE / npcCorporations.jsonl", httpStatus: 200, response: result });
      return Response.json(result);
    }

    const pendingNames = (await db.prepare("SELECT corporation_id, name FROM corporations WHERE name_synced_at IS NULL ORDER BY corporation_id LIMIT 50").all<{ corporation_id: number; name: string }>()).results;
    if (pendingNames.length) {
      const resolved = await esiPost<ResolvedName[]>("/universe/names/", pendingNames.map(row => row.corporation_id), { language: "zh" });
      const resolvedMap = new Map(resolved.filter(row => row.category === "corporation").map(row => [row.id, row.name]));
      await batchStatements(db, pendingNames.map(row => db.prepare("UPDATE corporations SET name=?, name_synced_at=?, updated_at=? WHERE corporation_id=?").bind(resolvedMap.get(row.corporation_id) || row.name, now, now, row.corporation_id)));
      const remaining = await db.prepare("SELECT COUNT(*) AS count FROM corporations WHERE name_synced_at IS NULL").first<{ count: number }>();
      const result = { done: false, phase: "corporation_names", processed: pendingNames.length, remaining: remaining?.count ?? 0 };
      await updateSyncJob({ kind: "catalog", status: "running", phase: "军团中文名", runStartedAt, remaining: result.remaining, endpoint: "/universe/names/?language=zh", httpStatus: 200, response: result });
      return Response.json(result);
    }

    const pendingCorporations = (await db.prepare("SELECT corporation_id FROM corporations WHERE offers_synced_at IS NULL OR offers_synced_at < ? ORDER BY COALESCE(offers_synced_at, ''), corporation_id LIMIT 10").bind(runStartedAt).all<{ corporation_id: number }>()).results;
    if (pendingCorporations.length) {
      const corporationData = await Promise.all(pendingCorporations.map(async row => {
        const corporationId = row.corporation_id;
        const corporationPromise = esiGet<Corporation>(`/corporations/${corporationId}/`);
        let offers: Offer[] = [];
        try { offers = await esiGet<Offer[]>(`/loyalty/stores/${corporationId}/offers/`); }
        catch (error) { if (!(error instanceof EsiError) || error.status !== 404) throw error; }
        return { corporationId, corporation: await corporationPromise, offers };
      }));
      for (const { corporationId, corporation, offers } of corporationData) {
        const statements: D1PreparedStatement[] = [
          db.prepare("UPDATE corporations SET faction_id=?, offers_synced_at=?, updated_at=? WHERE corporation_id=?").bind(NPC_CORPORATION_FACTIONS[corporationId] ?? corporation.faction_id ?? null, now, now, corporationId),
          db.prepare("DELETE FROM lp_offer_materials WHERE corporation_id=?").bind(corporationId),
          db.prepare("DELETE FROM lp_offers WHERE corporation_id=?").bind(corporationId),
        ];
        for (const offer of offers) {
          statements.push(db.prepare("INSERT INTO lp_offers (corporation_id, offer_id, type_id, quantity, lp_cost, isk_cost, ak_cost, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)").bind(corporationId, offer.offer_id, offer.type_id, offer.quantity, offer.lp_cost, offer.isk_cost, offer.ak_cost ?? 0, now));
          statements.push(db.prepare("INSERT OR IGNORE INTO item_types (type_id, updated_at) VALUES (?, ?)").bind(offer.type_id, now));
          for (const material of offer.required_items ?? []) {
            statements.push(db.prepare("INSERT INTO lp_offer_materials (corporation_id, offer_id, type_id, quantity) VALUES (?, ?, ?, ?)").bind(corporationId, offer.offer_id, material.type_id, material.quantity));
            statements.push(db.prepare("INSERT OR IGNORE INTO item_types (type_id, updated_at) VALUES (?, ?)").bind(material.type_id, now));
          }
        }
        await batchStatements(db, statements);
      }
      const remaining = await db.prepare("SELECT COUNT(*) AS count FROM corporations WHERE offers_synced_at IS NULL OR offers_synced_at < ?").bind(runStartedAt).first<{ count: number }>();
      const result = { done: false, phase: "corporations", processed: pendingCorporations.length, remaining: remaining?.count ?? 0 };
      await updateSyncJob({ kind: "catalog", status: "running", phase: "军团与 LP 商店", runStartedAt, processedDelta: pendingCorporations.length, remaining: result.remaining, endpoint: `/corporations/${pendingCorporations[0].corporation_id}/ + /loyalty/stores/.../offers/`, httpStatus: 200, response: result });
      return Response.json(result);
    }

    const pendingTypes = (await db.prepare("SELECT type_id FROM item_types WHERE name_zh IS NULL OR updated_at < ? ORDER BY COALESCE(updated_at, ''), type_id LIMIT 10").bind(runStartedAt).all<{ type_id: number }>()).results;
    if (pendingTypes.length) {
      const resolvedTypes = await Promise.all(pendingTypes.map(async row => {
        let zh = `物品 ${row.type_id}`;
        let en = zh;
        const [zhResult, enResult] = await Promise.allSettled([
          esiGet<{ name: string }>(`/universe/types/${row.type_id}/`, { language: "zh" }),
          esiGet<{ name: string }>(`/universe/types/${row.type_id}/`, { language: "en" }),
        ]);
        if (zhResult.status === "fulfilled") zh = zhResult.value.name;
        if (enResult.status === "fulfilled") en = enResult.value.name; else en = zh;
        return { typeId: row.type_id, zh, en };
      }));
      const statements = resolvedTypes.map(row => db.prepare("UPDATE item_types SET name_zh=?, name_en=?, updated_at=? WHERE type_id=?").bind(row.zh, row.en, now, row.typeId));
      await batchStatements(db, statements);
      const remaining = await db.prepare("SELECT COUNT(*) AS count FROM item_types WHERE name_zh IS NULL OR updated_at < ?").bind(runStartedAt).first<{ count: number }>();
      const result = { done: false, phase: "items", processed: pendingTypes.length, remaining: remaining?.count ?? 0 };
      await updateSyncJob({ kind: "catalog", status: "running", phase: "物品中文名", runStartedAt, processedDelta: pendingTypes.length, remaining: result.remaining, endpoint: `/universe/types/${pendingTypes[0].type_id}/`, httpStatus: 200, response: result });
      return Response.json(result);
    }
    const pendingBlueprints = (await db.prepare(`SELECT DISTINCT o.type_id FROM lp_offers o LEFT JOIN blueprint_checks b ON b.type_id=o.type_id WHERE b.type_id IS NULL OR b.checked_at < ? ORDER BY o.type_id LIMIT 10`).bind(runStartedAt).all<{ type_id: number }>()).results;
    if (pendingBlueprints.length) {
      const blueprintData = await Promise.all(pendingBlueprints.map(async row => ({ row, blueprint: await fetchBlueprint(row.type_id) })));
      for (const { row, blueprint } of blueprintData) {
        const manufacturing = blueprint?.activities?.manufacturing;
        const product = Object.values(manufacturing?.products ?? {})[0];
        const materials = Object.values(manufacturing?.materials ?? {});
        const statements: D1PreparedStatement[] = [
          db.prepare("INSERT OR REPLACE INTO blueprint_checks (type_id, checked_at) VALUES (?, ?)").bind(row.type_id, now),
          db.prepare("DELETE FROM blueprint_materials WHERE blueprint_type_id=?").bind(row.type_id),
          db.prepare("DELETE FROM blueprint_recipes WHERE blueprint_type_id=?").bind(row.type_id),
        ];
        if (product?.type_id && product.quantity) {
          statements.push(db.prepare("INSERT INTO blueprint_recipes (blueprint_type_id, product_type_id, product_quantity, checked_at) VALUES (?, ?, ?, ?)").bind(row.type_id, product.type_id, product.quantity, now));
          statements.push(db.prepare("INSERT OR IGNORE INTO item_types (type_id, updated_at) VALUES (?, ?)").bind(product.type_id, now));
          for (const material of materials) if (material.type_id && material.quantity) {
            statements.push(db.prepare("INSERT INTO blueprint_materials (blueprint_type_id, material_type_id, quantity) VALUES (?, ?, ?)").bind(row.type_id, material.type_id, material.quantity));
            statements.push(db.prepare("INSERT OR IGNORE INTO item_types (type_id, updated_at) VALUES (?, ?)").bind(material.type_id, now));
          }
        }
        await batchStatements(db, statements);
      }
      const remaining = await db.prepare(`SELECT COUNT(DISTINCT o.type_id) AS count FROM lp_offers o LEFT JOIN blueprint_checks b ON b.type_id=o.type_id WHERE b.type_id IS NULL OR b.checked_at < ?`).bind(runStartedAt).first<{ count: number }>();
      const result = { done: false, phase: "blueprints", processed: pendingBlueprints.length, remaining: remaining?.count ?? 0 };
      await updateSyncJob({ kind: "catalog", status: "running", phase: "蓝图制造资料", runStartedAt, processedDelta: pendingBlueprints.length, remaining: result.remaining, endpoint: `SDE /blueprints/${pendingBlueprints[0].type_id}`, httpStatus: 200, response: result });
      return Response.json(result);
    }
    await updateSyncJob({ kind: "catalog", status: "complete", phase: "完成", runStartedAt, remaining: 0, httpStatus: 200, response: { done: true } });
    return Response.json({ done: true, phase: "complete" });
  } catch (error) {
    const status = error instanceof EsiError && error.status === 420 ? 429 : 502;
    const message = error instanceof Error ? error.message : String(error);
    await updateSyncJob({ kind: "catalog", status: "error", phase: "已暂停", runStartedAt, endpoint: error instanceof EsiError ? error.path : undefined, httpStatus: error instanceof EsiError ? error.status : status, error: message });
    return Response.json({ error: message, resumable: true }, { status });
  }
}
