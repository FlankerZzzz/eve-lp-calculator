import net from "node:net";

const baseUrl = process.env.SYNC_BASE_URL || "http://localhost:3000";
const idleDelay = 1000;
const batchDelay = 500;
const lockPort = 33991;
const transientFailures = new Map();
let roundRobinIndex = 0;
let lastRankingDueCheck = 0;
let lastScheduleKey = "";

const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

async function acquireSingleInstanceLock() {
  while (true) {
    const server = net.createServer();
    const acquired = await new Promise(resolve => {
      server.once("error", () => resolve(false));
      server.listen(lockPort, "127.0.0.1", () => resolve(true));
    });
    if (acquired) {
      console.log(`[sync-worker] 已获得单实例锁 127.0.0.1:${lockPort}`);
      return server;
    }
    server.close();
    console.log("[sync-worker] 另一个同步器正在运行，5 秒后再次检查");
    await sleep(5000);
  }
}

async function resumeAfterTransientFailure(job, status) {
  const failures = (transientFailures.get(job.kind) || 0) + 1;
  transientFailures.set(job.kind, failures);
  if (failures > 10) return false;
  const wait = [30000, 60000, 120000, 180000, 300000][Math.min(failures - 1, 4)];
  console.log(`[sync-worker] ${job.kind} 瞬时错误 HTTP ${status}，${wait / 1000} 秒后自动续跑（${failures}/10）`);
  await sleep(wait);
  const statusData = await readStatus().catch(() => null);
  const latest = statusData?.jobs?.find(candidate => candidate.kind === job.kind);
  if (latest?.status === "paused" || latest?.status === "complete") return false;
  if (latest?.status === "running") return true;
  const response = await fetch(`${baseUrl}/api/sync/control`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ kind: job.kind, action: "start" }),
  });
  return response.ok;
}

async function readStatus() {
  const response = await fetch(`${baseUrl}/api/sync/status`, { cache: "no-store" });
  if (!response.ok) throw new Error(`状态接口 HTTP ${response.status}`);
  return response.json();
}

async function scheduleDueJobs() {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Shanghai", hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  }).formatToParts(new Date()).filter(part => part.type === "hour" || part.type === "minute").map(part => [part.type, Number(part.value)]));
  const hour = parts.hour;
  const minute = parts.minute;
  const key = `${new Date().toISOString().slice(0, 10)}-${hour}:${minute}`;
  if (key === lastScheduleKey) return false;
  const orderHours = new Set([0, 3, 9, 12, 15, 18, 21]);
  const isOrderDue = minute === 0 && orderHours.has(hour);
  const isHistoryDue = hour === 0 && minute === 30;
  if (!isOrderDue && !isHistoryDue) return false;
  const kind = isHistoryDue ? "history" : "orders";
  const response = await fetch(`${baseUrl}/api/sync/control`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ kind, action: "restart" }),
  });
  if (response.ok || response.status === 409) {
    lastScheduleKey = key;
    console.log(`[sync-worker] 定时启动 ${kind}：Asia/Shanghai ${hour}:${String(minute).padStart(2, "0")}`);
    return true;
  }
  return false;
}

async function nextRunningJob() {
  await scheduleDueJobs();
  const data = await readStatus();
  const running = data.jobs?.filter(job => job.status === "running") || [];
  if (running.some(job => job.kind === "orders")) return null;
  if (!running.length && Date.now() - lastRankingDueCheck > 60000) {
    lastRankingDueCheck = Date.now();
    const due = await fetch(`${baseUrl}/api/sync/rankings`, { cache: "no-store" }).then(response => response.ok ? response.json() : null).catch(() => null);
    if (due?.due) {
      await fetch(`${baseUrl}/api/sync/control`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ kind: "rankings", action: "start" }) });
      return nextRunningJob();
    }
  }
  if (!running.length) return null;
  const job = running[roundRobinIndex % running.length];
  roundRobinIndex = (roundRobinIndex + 1) % Math.max(1, running.length);
  return job;
}

function calculatedOffer(offer) {
  const materialCost = (offer.materials || []).reduce((sum, material) => sum + material.quantity * (material.sell_price || 0), 0);
  const revenueQuantity = offer.revenue_quantity || offer.quantity;
  const maxProfit = offer.sell_price > 0 ? offer.sell_price * revenueQuantity * 0.97 - offer.isk_cost - materialCost : null;
  const minProfit = offer.buy_price > 0 ? offer.buy_price * revenueQuantity * 0.97 - offer.isk_cost - materialCost : null;
  return { ...offer, material_total: materialCost, max_profit: maxProfit, min_profit: minProfit, lp_ratio: offer.lp_cost > 0 && minProfit !== null ? minProfit / offer.lp_cost : 0 };
}

function signature(offer) {
  const materials = (offer.materials || []).map(item => `${item.material_kind || ""}:${item.type_id}:${item.quantity}`).sort().join("|");
  return `${offer.type_id}:${offer.quantity}:${offer.lp_cost}:${offer.isk_cost}:${offer.product_type_id || 0}:${materials}`;
}

function retainTop(map, offers, compare) {
  for (const offer of offers) {
    const key = signature(offer);
    const previous = map.get(key);
    if (!previous || compare(offer, previous) < 0) map.set(key, offer);
  }
  const top = [...map.values()].sort(compare).slice(0, 100);
  map.clear();
  top.forEach(offer => map.set(signature(offer), offer));
}

async function rebuildRankings(job) {
  const optionsResponse = await fetch(`${baseUrl}/api/data/options`, { cache: "no-store" });
  if (!optionsResponse.ok) throw new Error(`榜单企业列表 HTTP ${optionsResponse.status}`);
  const corporations = (await optionsResponse.json()).corporations || [];
  const popular = new Map();
  const highRatio = new Map();
  let processed = 0;
  for (let index = 0; index < corporations.length; index += 4) {
    const latest = await readStatus();
    const current = latest.jobs?.find(candidate => candidate.kind === "rankings");
    if (current?.status !== "running" || current.run_started_at !== job.run_started_at) return;
    const chunk = corporations.slice(index, index + 4);
    const batches = await Promise.all(chunk.map(async corporation => {
      const params = new URLSearchParams({ corporation_id: String(corporation.corporation_id), view: "detail", page_size: "all", days: "30", tax: "3", include_booster_blueprints: "1" });
      const response = await fetch(`${baseUrl}/api/data/offers?${params}`, { cache: "no-store" });
      if (!response.ok) throw new Error(`企业 ${corporation.corporation_id} 榜单数据 HTTP ${response.status}`);
      return (await response.json()).offers || [];
    }));
    const offers = batches.flat().map(calculatedOffer);
    retainTop(popular, offers.filter(offer => offer.daily_volume > 0), (a, b) => b.daily_volume - a.daily_volume);
    retainTop(highRatio, offers.filter(offer => offer.lp_ratio > 0), (a, b) => b.lp_ratio - a.lp_ratio);
    processed += chunk.length;
    await fetch(`${baseUrl}/api/sync/rankings`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "progress", runStartedAt: job.run_started_at, processed: chunk.length, remaining: corporations.length - processed }) });
  }
  const response = await fetch(`${baseUrl}/api/sync/rankings`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "complete", runStartedAt: job.run_started_at, popular: [...popular.values()].sort((a, b) => b.daily_volume - a.daily_volume).slice(0, 100), highRatio: [...highRatio.values()].sort((a, b) => b.lp_ratio - a.lp_ratio).slice(0, 100) }) });
  if (!response.ok) throw new Error(`保存榜单 HTTP ${response.status}`);
}

async function run() {
  await acquireSingleInstanceLock();
  console.log(`[sync-worker] 等待本地服务 ${baseUrl}`);
  while (true) {
    try {
      const job = await nextRunningJob();
      if (!job) {
        await sleep(idleDelay);
        continue;
      }
      if (job.kind === "rankings") {
        await rebuildRankings(job);
        continue;
      }
      if (job.kind === "orders") {
        await sleep(idleDelay);
        continue;
      }
      const response = await fetch(`${baseUrl}/api/sync/${job.kind}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ runStartedAt: job.run_started_at }),
      });
      const text = await response.text();
      console.log(`[sync-worker] ${job.kind} HTTP ${response.status} ${text.slice(0, 240)}`);
      if (response.ok) transientFailures.set(job.kind, 0);
      if ((response.status === 429 || response.status === 502 || response.status >= 500) && await resumeAfterTransientFailure(job, response.status)) continue;
      const nextBatchDelay = job.kind === "history" ? 1000 : batchDelay;
      await sleep(response.ok ? nextBatchDelay : 5000);
    } catch (error) {
      console.log(`[sync-worker] ${error instanceof Error ? error.message : String(error)}`);
      await sleep(2000);
    }
  }
}

void run();
