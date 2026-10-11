import { ensureBusinessSchema as ensureSchema } from "../../../../db/business";
import { MARKET_REGION_ID } from "../../../../lib/esi-server";
import { esiPost } from "../../../../lib/esi-server";
import { mergeContractItems, parseContractText, createContractNameResolver, ContractTextError } from "../../../../lib/contract-analysis";
import { createContractNameCache } from "../../../../lib/contract-name-cache";
const lookupNames=createContractNameCache(names=>esiPost("/universe/ids/",names,{language:"zh"}));
type CachedItem = { type_id?: number; quantity?: number; name?: string; name_zh?: string; is_included?: boolean };
type MarketRow = { type_id: number; buy_price: number; sell_price: number; buy_volume: number; sell_volume: number; collected_at: string };
type SdeRow = { type_id: number; volume: number | null; packaged_volume: number | null; is_repackable: number };

async function snapshotQuotes(db: Awaited<ReturnType<typeof ensureSchema>>, ids: number[]) {
  const placeholders = ids.map(() => "?").join(",");
  return (await db.prepare(`
    SELECT ob.type_id,
      MAX(CASE WHEN ob.is_buy_order=1 THEN ob.price END) AS buy_price,
      MIN(CASE WHEN ob.is_buy_order=0 THEN ob.price END) AS sell_price,
      COALESCE(SUM(CASE WHEN ob.is_buy_order=1 THEN ob.volume_remain ELSE 0 END),0) AS buy_volume,
      COALESCE(SUM(CASE WHEN ob.is_buy_order=0 THEN ob.volume_remain ELSE 0 END),0) AS sell_volume,
      state.collected_at
    FROM market_order_book ob
    JOIN market_order_book_state state ON state.active_slot=ob.slot AND state.id=1
    WHERE ob.type_id IN (${placeholders})
    GROUP BY ob.type_id, state.collected_at
  `).bind(...ids).all<MarketRow>()).results;
}

async function quoteItems(db: Awaited<ReturnType<typeof ensureSchema>>, items: Array<{ type_id: number; quantity: number; name_zh?: string }>, unresolved: string[] = []) {
  const ids = items.map(item => item.type_id), placeholders = ids.map(() => "?").join(",");
  const [names, orders, history, volumes] = await Promise.all([
    db.prepare(`SELECT type_id,name_zh,name_en FROM item_types WHERE type_id IN (${placeholders})`).bind(...ids).all<{ type_id: number; name_zh: string | null; name_en: string | null }>(),
    snapshotQuotes(db, ids),
    db.prepare(`SELECT type_id,SUM(average_price * volume) / NULLIF(SUM(volume),0) AS weighted_average,SUM(volume) AS volume FROM market_daily WHERE region_id=? AND trade_date>=date('now','-30 day') AND type_id IN (${placeholders}) GROUP BY type_id`).bind(MARKET_REGION_ID, ...ids).all<{ type_id: number; weighted_average: number | null; volume: number }>(),
    db.prepare(`SELECT type_id,volume,packaged_volume,is_repackable FROM sde_type_reference WHERE type_id IN (${placeholders})`).bind(...ids).all<SdeRow>(),
  ]);
  const volumeMap = new Map(volumes.results.map(row => [row.type_id, row]));
  const nameMap = new Map(names.results.map(row => [row.type_id, row])), orderMap = new Map(orders.map(row => [row.type_id, row])), historyMap = new Map(history.results.map(row => [row.type_id, row]));
  const rows = items.map(item => { const name = nameMap.get(item.type_id), order = orderMap.get(item.type_id), historyRow = historyMap.get(item.type_id), sde = volumeMap.get(item.type_id); const sellPrice = Number(order?.sell_price || 0), buyPrice = Number(order?.buy_price || 0), historyPrice = Number(historyRow?.weighted_average || 0); const estimatePrice = historyPrice > 0 ? historyPrice : null; return { type_id: item.type_id, quantity: item.quantity, name_zh: name?.name_zh || item.name_zh || `物品 ${item.type_id}`, name_en: name?.name_en || null, sell_price: sellPrice || null, buy_price: buyPrice || null, sell_total: sellPrice > 0 ? sellPrice * item.quantity : null, buy_total: buyPrice > 0 ? buyPrice * item.quantity : null, estimate_price: estimatePrice, estimate_total: estimatePrice == null ? null : estimatePrice * item.quantity, volume: sde?.volume ?? null, packaged_volume: sde?.packaged_volume ?? null, is_repackable: Boolean(sde?.is_repackable), buy_volume: Number(order?.buy_volume || 0), sell_volume: Number(order?.sell_volume || 0), history_price: historyPrice || null, collected_at: order?.collected_at || null }; });
  const sum = (key: "sell_total" | "buy_total" | "estimate_total") => rows.reduce((total, row) => total + (row[key] || 0), 0);
  const missingCount = rows.filter(row => row.sell_price == null || row.buy_price == null).length;
  const rareCount = rows.filter(row => row.buy_price != null && row.sell_price == null).length;
  return { region_id: MARKET_REGION_ID, source: "本地全量订单快照 · 伏尔戈星域", unresolved, missing_quotes: rareCount ? `可能存在的稀有/高价值物品 ${rareCount}` : missingCount, totals: { sell: sum("sell_total"), buy: sum("buy_total"), estimate: sum("estimate_total") }, rows };
}

export async function GET(request: Request) {
  const contractId = Number(new URL(request.url).searchParams.get("contract_id") || 0);
  if (!Number.isSafeInteger(contractId) || contractId <= 0) return Response.json({ error: "请输入有效的合同 ID" }, { status: 400 });
  const db = await ensureSchema();
  const cache = await db.prepare("SELECT payload,status,fetched_at,error_message FROM contract_item_cache WHERE contract_id=? LIMIT 1").bind(contractId).first<{ payload: string; status: string; fetched_at: string; error_message: string | null }>();
  if (!cache) return Response.json({ error: "合同明细尚未进入本地缓存，请等待合同同步后重试", code: "NOT_CACHED" }, { status: 404 });
  if (cache.status !== "ready") return Response.json({ error: cache.error_message || "合同明细暂不可用", code: "CACHE_NOT_READY", status: cache.status }, { status: 409 });
  let payload: CachedItem[];
  try {
    const decoded: unknown = JSON.parse(cache.payload);
    if (!Array.isArray(decoded) || decoded.some(item => !item || typeof item !== 'object' || !Number.isSafeInteger(item.type_id) || item.type_id <= 0 || !Number.isFinite(item.quantity) || item.quantity <= 0 || (item.is_included !== undefined && typeof item.is_included !== 'boolean'))) throw new Error('Invalid contract items');
    payload = decoded;
  } catch { return Response.json({ error: "合同明细格式无效，已略过估价，请等待同步更新", code: "INVALID_CACHE" }, { status: 422 }); }
  const asItem=(item: CachedItem)=>({type_id:Number(item.type_id),quantity:Number(item.quantity),name_zh:item.name_zh||item.name});
  const merged = mergeContractItems(payload.filter(item=>item.is_included!==false).map(asItem));
  const paymentItems=mergeContractItems(payload.filter(item=>item.is_included===false).map(asItem));
  if (!merged.length) return Response.json({ error: "合同没有可估价的收到物品；需要支付的物品不计入收到物品估值", code: "EMPTY_CONTRACT", payment_items:paymentItems }, { status: 422 });
  if(merged.length>500)return Response.json({error:'合同物品种类超过 500，不能截断后估价'},{status:422});
  const ids = merged.map(item => item.type_id), placeholders = ids.map(() => "?").join(",");
  const [names, orders, history, volumes, header] = await Promise.all([
    db.prepare(`SELECT type_id,name_zh,name_en FROM item_types WHERE type_id IN (${placeholders})`).bind(...ids).all<{ type_id: number; name_zh: string | null; name_en: string | null }>(),
    snapshotQuotes(db, ids),
    db.prepare(`SELECT type_id,SUM(average_price * volume) / NULLIF(SUM(volume),0) AS weighted_average,SUM(volume) AS volume FROM market_daily WHERE region_id=? AND trade_date>=date('now','-30 day') AND type_id IN (${placeholders}) GROUP BY type_id`).bind(MARKET_REGION_ID, ...ids).all<{ type_id: number; weighted_average: number | null; volume: number }>(),
    db.prepare(`SELECT type_id,volume,packaged_volume,is_repackable FROM sde_type_reference WHERE type_id IN (${placeholders})`).bind(...ids).all<SdeRow>(),
    db.prepare("SELECT contract_id,contract_type,price,date_issued,date_expired,start_location_id FROM contract_headers WHERE contract_id=? LIMIT 1").bind(contractId).first(),
  ]);
  const nameMap = new Map(names.results.map(row => [row.type_id, row])), orderMap = new Map(orders.map(row => [row.type_id, row])), historyMap = new Map(history.results.map(row => [row.type_id, row])), volumeMap = new Map(volumes.results.map(row => [row.type_id, row]));
  const rows = merged.map(item => { const name = nameMap.get(item.type_id), order = orderMap.get(item.type_id), historyRow = historyMap.get(item.type_id), volume = volumeMap.get(item.type_id); const sellPrice = Number(order?.sell_price || 0), buyPrice = Number(order?.buy_price || 0), historyPrice = Number(historyRow?.weighted_average || 0); const estimatePrice = historyPrice > 0 ? historyPrice : null; return { type_id: item.type_id, quantity: item.quantity, name_zh: name?.name_zh || item.name_zh || `物品 ${item.type_id}`, name_en: name?.name_en || null, sell_price: sellPrice || null, buy_price: buyPrice || null, sell_total: sellPrice > 0 ? sellPrice * item.quantity : null, buy_total: buyPrice > 0 ? buyPrice * item.quantity : null, estimate_price: estimatePrice, estimate_total: estimatePrice == null ? null : estimatePrice * item.quantity, volume: volume?.volume ?? null, packaged_volume: volume?.packaged_volume ?? null, is_repackable: Boolean(volume?.is_repackable), buy_volume: Number(order?.buy_volume || 0), sell_volume: Number(order?.sell_volume || 0), history_price: historyPrice || null, collected_at: order?.collected_at || null }; });
  const sum = (key: "sell_total" | "buy_total" | "estimate_total") => rows.reduce((total, row) => total + (row[key] || 0), 0);
  const missingCount = rows.filter(row => row.sell_price == null || row.buy_price == null).length;
  const rareCount = rows.filter(row => row.buy_price != null && row.sell_price == null).length;
  return Response.json({ contract_id: contractId, region_id: MARKET_REGION_ID, source: "本地全量订单快照 · 伏尔戈星域", fetched_at: cache.fetched_at, contract: header || null, payment_items:paymentItems, missing_quotes: rareCount ? `可能存在的稀有/高价值物品 ${rareCount}` : missingCount, totals: { sell: sum("sell_total"), buy: sum("buy_total"), estimate: sum("estimate_total") }, rows }, { headers: { "cache-control": "no-store" } });
}

export async function POST(request: Request) {
  let body: unknown;
  try { body = await request.json(); } catch { return Response.json({ error: "请输入合同物品文本" }, { status: 400 }); }
  if (!body || typeof body !== 'object' || Array.isArray(body) || !('text' in body) || typeof body.text !== 'string') return Response.json({ error: "请输入有效的合同物品文本", code: "INVALID_INPUT" }, { status: 400 });
  if (body.text.length > 1024 * 1024) return Response.json({ error: "合同文本过大，请分批查询", code: "INPUT_TOO_LARGE" }, { status: 413 });
  let parsed: ReturnType<typeof parseContractText>;
  try { parsed = parseContractText(body.text); }
  catch (error) {
    if (error instanceof ContractTextError) return Response.json({ error: error.message, code: "INVALID_CONTRACT_LINES", issues: error.issues, issue_count: error.issueCount }, { status: 422 });
    throw error;
  }
  if (!parsed.length) return Response.json({ error: "没有识别到有效物品，请按“品目\t数量\t分类\t类型\t槽位”粘贴" }, { status: 400 });
  if (new Set(parsed.map(item => item.name)).size > 500) return Response.json({ error: "合同物品种类超过 500，请分批查询", code: "TOO_MANY_ITEMS" }, { status: 422 });
  const db = await ensureSchema();
  const names = [...new Set(parsed.map(item => item.name))], placeholders = names.map(() => "?").join(",");
  const numericIds=names.filter(name=>/^[1-9]\d*$/.test(name)).map(Number).filter(Number.isSafeInteger);
  const idPlaceholders=(numericIds.length?numericIds:[-1]).map(()=>'?').join(',');
  const catalog = (await db.prepare(`SELECT type_id,name_zh,name_en FROM item_types WHERE name_zh IN (${placeholders}) OR name_en IN (${placeholders}) OR type_id IN (${idPlaceholders})`).bind(...names, ...names,...(numericIds.length?numericIds:[-1])).all<{ type_id: number; name_zh: string | null; name_en?: string | null }>()).results;
  let resolveName=createContractNameResolver(catalog);
  const unresolvedNames = names.filter(name => resolveName(name).candidates.length===0);
  if (unresolvedNames.length) {
    try {
      const resolved = await lookupNames(unresolvedNames);
      for (const row of resolved.inventory_types || []) catalog.push({type_id:row.id,name_zh:row.name});
    } catch { /* local catalog remains authoritative when Serenity ESI is unavailable */ }
  }
  resolveName=createContractNameResolver(catalog);
  const ambiguities=names.map(name=>({name,...resolveName(name)})).filter(row=>row.ambiguous);
  if(ambiguities.length)return Response.json({error:`同名物品存在歧义：${ambiguities.map(row=>`${row.name}（候选 ID：${row.candidates.map(item=>item.type_id).join('、')}）`).join('；')}。请把品目名称改为对应物品 ID 后重试。`,code:'AMBIGUOUS_ITEM',ambiguous:ambiguities.map(({name,candidates})=>({name,candidates}))},{status:409});
  const unresolved = names.filter(name => !resolveName(name).item);
  const unresolvedItems = unresolved.map(name => ({ name, quantity: parsed.filter(item => item.name === name).reduce((sum, item) => sum + item.quantity, 0) }));
  const grouped = new Map<number, { type_id: number; quantity: number; name_zh?: string }>();
  for (const item of parsed) {
    const match = resolveName(item.name).item; if (!match) continue;
    const previous = grouped.get(match.type_id), quantity = (previous?.quantity || 0) + item.quantity;
    if (!Number.isSafeInteger(quantity)) return Response.json({ error: "物品合并后的数量超过可安全计算的整数范围，本次未进行估价。", code: "INVALID_CONTRACT_LINES", issues: [{ line: item.line, name: item.name, reason: "合并后的数量超过可安全计算的整数范围" }], issue_count: 1 }, { status: 422 });
    if (previous) previous.quantity = quantity;
    else grouped.set(match.type_id, { type_id: match.type_id, quantity, name_zh: match.name_zh || item.name });
  }
  if (!grouped.size) return Response.json({ error: `无法在本地物品目录中匹配：${unresolved.join("、")}`, code: "UNRESOLVED_ITEMS", unresolved, unresolved_items: unresolvedItems }, { status: 422 });
  return Response.json({ ...await quoteItems(db, [...grouped.values()], unresolved), unresolved_items: unresolvedItems, input_count: parsed.length, merged_count: grouped.size }, { headers: { "cache-control": "no-store" } });
}
