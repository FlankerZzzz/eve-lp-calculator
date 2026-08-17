const ESI_BASE = process.env.ESI_BASE_URL || "https://ali-esi.evepc.163.com";
export const ESI_DATASOURCE = "serenity";
export const MARKET_REGION_ID = 10000002;

export class EsiError extends Error {
  constructor(public status: number, public path: string, public detail?: string) {
    super(`ESI ${status}: ${path}${detail ? ` · ${detail}` : ""}`);
  }
}

export function isMarketUnavailable(error: unknown) {
  return error instanceof EsiError && (
    (error.status === 400 && /type not tradable on market/i.test(error.detail || "")) ||
    (error.status === 404 && /type not found/i.test(error.detail || ""))
  );
}

const RETRY_DELAYS = [1000, 2000, 4000, 8000];
const sleep = (milliseconds: number) => new Promise(resolve => setTimeout(resolve, milliseconds));

async function esiFetch(path: string, query: URLSearchParams, init: { method?: string; body?: string } = {}) {
  const url = `${ESI_BASE.replace(/\/$/, "")}/latest${path}?${query}`;
  let lastNetworkError = "";
  for (let attempt = 0; attempt <= RETRY_DELAYS.length; attempt++) {
    try {
      const response = await fetch(url, {
        method: init.method || "GET",
        body: init.body,
        headers: { accept: "application/json", "content-type": "application/json", "user-agent": "Chenxi-LP-Calculator/local" },
        cache: "no-store",
        signal: AbortSignal.timeout(20000),
      });
      const retryable = response.status === 420 || response.status === 429 || response.status >= 500;
      if (response.ok || !retryable || attempt === RETRY_DELAYS.length) return response;
      const retryAfter = Number(response.headers.get("retry-after") || 0) * 1000;
      await response.body?.cancel().catch(() => undefined);
      await sleep(Math.max(RETRY_DELAYS[attempt], Math.min(retryAfter, 30000)));
    } catch (error) {
      lastNetworkError = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
      if (attempt === RETRY_DELAYS.length) {
        throw new EsiError(502, path, `连接晨曦 ESI 失败，已重试 5 次；${lastNetworkError}`);
      }
      await sleep(RETRY_DELAYS[attempt]);
    }
  }
  throw new EsiError(502, path, `连接晨曦 ESI 失败；${lastNetworkError}`);
}

export async function esiPost<T>(path: string, body: unknown, params: Record<string, string | number> = {}) {
  const query = new URLSearchParams({ datasource: ESI_DATASOURCE });
  for (const [key, value] of Object.entries(params)) query.set(key, String(value));
  const response = await esiFetch(path, query, { method: "POST", body: JSON.stringify(body) });
  if (!response.ok) throw new EsiError(response.status, path, (await response.text()).slice(0, 160));
  return response.json() as Promise<T>;
}

export async function esiGet<T>(path: string, params: Record<string, string | number> = {}) {
  const query = new URLSearchParams({ datasource: ESI_DATASOURCE });
  for (const [key, value] of Object.entries(params)) query.set(key, String(value));
  const response = await esiFetch(path, query);
  if (!response.ok) throw new EsiError(response.status, path, (await response.text()).slice(0, 160));
  return response.json() as Promise<T>;
}

export type MarketOrder = { is_buy_order: boolean; price: number; volume_remain: number };

export async function fetchMarketOrders(typeId: number) {
  const path = `/markets/${MARKET_REGION_ID}/orders/`;
  const params = { order_type: "all", type_id: typeId, page: 1 };
  const query = new URLSearchParams({ datasource: ESI_DATASOURCE, ...Object.fromEntries(Object.entries(params).map(([key, value]) => [key, String(value)])) });
  const first = await esiFetch(path, query);
  if (!first.ok) throw new EsiError(first.status, path, (await first.text()).slice(0, 160));
  const firstOrders = await first.json() as MarketOrder[];
  const pageCount = Math.min(Number(first.headers.get("x-pages") || 1), 20);
  const allOrders = [...firstOrders];
  for (let page = 2; page <= pageCount; page += 4) {
    const pages = await Promise.all(
      Array.from({ length: Math.min(4, pageCount - page + 1) }, (_, offset) =>
        esiGet<MarketOrder[]>(path, { ...params, page: page + offset })
      )
    );
    pages.forEach(rows => allOrders.push(...rows));
  }
  return allOrders;
}

export function summarizeOrders(orders: MarketOrder[]) {
  const buys = orders.filter(order => order.is_buy_order && order.price > 0);
  const sells = orders.filter(order => !order.is_buy_order && order.price > 0);
  const maxBuy = Math.max(...buys.map(order => order.price), 0);
  const totalBuyVolume = buys.reduce((sum, order) => sum + order.volume_remain, 0);
  const filteredBuys = buys.filter(order => !(order.price < maxBuy * 0.2 && order.volume_remain > totalBuyVolume * 0.1));
  const levels = (source: MarketOrder[], direction: "asc" | "desc") => {
    const grouped = new Map<number, number>();
    for (const order of source) grouped.set(order.price, (grouped.get(order.price) ?? 0) + order.volume_remain);
    return [...grouped.entries()]
      .sort(([left], [right]) => direction === "asc" ? left - right : right - left)
      .slice(0, 5)
      .map(([price, volume], index) => ({ level: index + 1, price, volume }));
  };
  return {
    buyPrice: Math.max(...filteredBuys.map(order => order.price), 0),
    sellPrice: sells.length ? Math.min(...sells.map(order => order.price)) : 0,
    buyVolume: filteredBuys.reduce((sum, order) => sum + order.volume_remain, 0),
    sellVolume: sells.reduce((sum, order) => sum + order.volume_remain, 0),
    buyLevels: levels(filteredBuys, "desc"),
    sellLevels: levels(sells, "asc"),
  };
}

export function orderLevelStatements(db: D1Database, typeId: number, summary: ReturnType<typeof summarizeOrders>, collectedAt: string) {
  return [
    db.prepare("DELETE FROM market_order_levels WHERE region_id=? AND type_id=?").bind(MARKET_REGION_ID, typeId),
    ...summary.buyLevels.map(item => db.prepare("INSERT INTO market_order_levels (region_id, type_id, side, level, price, volume, collected_at) VALUES (?, ?, 'buy', ?, ?, ?, ?)").bind(MARKET_REGION_ID, typeId, item.level, item.price, item.volume, collectedAt)),
    ...summary.sellLevels.map(item => db.prepare("INSERT INTO market_order_levels (region_id, type_id, side, level, price, volume, collected_at) VALUES (?, ?, 'sell', ?, ?, ?, ?)").bind(MARKET_REGION_ID, typeId, item.level, item.price, item.volume, collectedAt)),
  ];
}

export async function batchStatements(db: D1Database, statements: D1PreparedStatement[], size = 80) {
  for (let index = 0; index < statements.length; index += size) await db.batch(statements.slice(index, index + size));
}
