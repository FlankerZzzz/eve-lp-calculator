const ESI_BASE = (process.env.ESI_BASE_URL || "https://ali-esi.evepc.163.com").replace(/\/$/, "");
const REGION_ID = 10000002;
const RETRIES = [1000, 2000, 4000, 8000];
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function requestPage(typeId, page) {
  const url = `${ESI_BASE}/latest/markets/${REGION_ID}/orders/?datasource=serenity&order_type=all&type_id=${typeId}&page=${page}`;
  for (let attempt = 0; attempt <= RETRIES.length; attempt += 1) {
    try {
      const response = await fetch(url, { headers: { accept: "application/json", "user-agent": "Chenxi-LP-Calculator/process-worker" }, signal: AbortSignal.timeout(20000) });
      if (response.ok) return { rows: await response.json(), pages: Number(response.headers.get("x-pages") || 1) };
      const detail = (await response.text()).slice(0, 160);
      if ((response.status === 400 && /type not tradable/i.test(detail)) || (response.status === 404 && /type not found/i.test(detail))) return { rows: [], pages: 1 };
      if (![420, 429, 500, 502, 503, 504].includes(response.status) || attempt === RETRIES.length) throw new Error(`ESI ${response.status}: ${detail}`);
    } catch (error) {
      if (attempt === RETRIES.length) throw error;
    }
    await sleep(RETRIES[attempt]);
  }
  return { rows: [], pages: 1 };
}

export async function fetchOrders(typeId) {
  const first = await requestPage(typeId, 1);
  const rows = [...first.rows];
  const pages = Math.min(first.pages, 20);
  for (let page = 2; page <= pages; page += 4) {
    const wave = await Promise.all(Array.from({ length: Math.min(4, pages - page + 1) }, (_, offset) => requestPage(typeId, page + offset)));
    wave.forEach(result => rows.push(...result.rows));
  }
  return rows;
}

export function summarize(orders) {
  const buys = orders.filter(order => order.is_buy_order && order.price > 0);
  const sells = orders.filter(order => !order.is_buy_order && order.price > 0);
  const maxBuy = Math.max(...buys.map(order => order.price), 0);
  const totalBuyVolume = buys.reduce((sum, order) => sum + order.volume_remain, 0);
  const filteredBuys = buys.filter(order => !(order.price < maxBuy * 0.2 && order.volume_remain > totalBuyVolume * 0.1));
  const levels = (source, direction) => {
    const grouped = new Map();
    for (const order of source) grouped.set(order.price, (grouped.get(order.price) || 0) + order.volume_remain);
    return [...grouped.entries()].sort(([a], [b]) => direction === "asc" ? a - b : b - a).slice(0, 5).map(([price, volume], index) => ({ level: index + 1, price, volume }));
  };
  return {
    buyPrice: filteredBuys.length ? Math.max(...filteredBuys.map(order => order.price)) : 0,
    sellPrice: sells.length ? Math.min(...sells.map(order => order.price)) : 0,
    buyVolume: filteredBuys.reduce((sum, order) => sum + order.volume_remain, 0),
    sellVolume: sells.reduce((sum, order) => sum + order.volume_remain, 0),
    buyLevels: levels(filteredBuys, "desc"),
    sellLevels: levels(sells, "asc"),
  };
}

process.on("message", async message => {
  if (!message || !Array.isArray(message.typeIds)) return;
  try {
    await Promise.all(message.typeIds.map(async typeId => {
      const result = { typeId, now: new Date().toISOString(), summary: summarize(await fetchOrders(typeId)) };
      process.send?.({ workerId: message.workerId, batchId: message.batchId, result });
    }));
    process.send?.({ workerId: message.workerId, batchId: message.batchId, done: true });
  } catch (error) {
    process.send?.({ workerId: message.workerId, batchId: message.batchId, error: error instanceof Error ? error.message : String(error) });
  }
});
