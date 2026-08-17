const url = "https://ali-esi.evepc.163.com/latest/markets/10000002/orders/?datasource=serenity&order_type=all&type_id=34&page=1";
const started = Date.now();
const results = await Promise.all(Array.from({ length: 100 }, async () => {
  const t = Date.now();
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(20000) });
    await response.arrayBuffer();
    return { status: response.status, ms: Date.now() - t };
  } catch (error) {
    return { status: "ERR", ms: Date.now() - t, error: String(error) };
  }
}));
console.log(JSON.stringify({ totalMs: Date.now() - started, ok: results.filter(x => x.status === 200).length, errors: results.filter(x => x.status === "ERR").length, maxMs: Math.max(...results.map(x => x.ms)), avgMs: Math.round(results.reduce((s, x) => s + x.ms, 0) / results.length), statuses: Object.groupBy(results, x => x.status), }, null, 2));
