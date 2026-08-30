import { ensureSchema } from "../../../../db/d1";

type ContractMatch = { contract_id: number; date_issued: string; date_expired: string; price: number; unit_price: number; set_count: number; start_location_id: number; end_location_id: number; solar_system_id?: number | null; location_name?: string };

function localizeContractLocation(name?: string) {
  return name === "吉他 IV-月球 4·加达里海军组装厂" ? "吉他 4 - 卫星 4 - 加达里海军组装车间" : name;
}

export async function GET(request: Request) {
  const url = new URL(request.url);
  const raw = (url.searchParams.get("type_ids") || "").split(",").map(Number).filter(Number.isInteger);
  const typeIds = [...new Set(raw)].slice(0, 48);
  if (typeIds.length !== 6) return Response.json({ error: "需要六个脑插类型" }, { status: 400 });
  const page = Math.max(1, Number(url.searchParams.get("page") || 1));
  const pageSize = Math.min(20, Math.max(1, Number(url.searchParams.get("page_size") || 10)));
  const db = await ensureSchema();
  const rawKey = typeIds.join(",");
  const key = [...typeIds].sort((a, b) => a - b).join(",");
  const row = await db.prepare("SELECT payload,fetched_at,expires_at,status,error_message FROM contract_snapshots WHERE set_key IN (?,?) ORDER BY CASE WHEN set_key=? THEN 0 ELSE 1 END LIMIT 1")
    .bind(key, rawKey, key).first<{ payload: string; fetched_at: string; expires_at: string; status: string; error_message: string | null }>();
  const contracts = row ? (JSON.parse(row.payload) as ContractMatch[]).map(contract => ({ ...contract, location_name: localizeContractLocation(contract.location_name) })) : [];
  const pagesCount = Math.max(1, Math.ceil(contracts.length / pageSize));
  const safePage = Math.min(page, pagesCount);
  return Response.json({ contracts: contracts.slice((safePage - 1) * pageSize, safePage * pageSize), total: contracts.length, page: safePage, pages: pagesCount, fetched_at: row?.fetched_at ?? null, stale: !row || new Date(row.expires_at).getTime() < Date.now(), status: row?.status ?? "pending", source: "后端合同缓存", error: row?.error_message ?? null }, { headers: { "cache-control": "no-store" } });
}
