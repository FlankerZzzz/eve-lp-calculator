import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../", import.meta.url);
const source = path => readFile(new URL(path, root), "utf8");

test("最大利润用最低卖单、最小利润用最高收单", async () => {
  const [page, route, esi] = await Promise.all([source("app/page.tsx"), source("app/api/data/offers/route.ts"), source("lib/esi-server.ts")]);
  assert.match(page, /offer\.sell_price \* revenueQuantity/);
  assert.match(page, /offer\.buy_price \* revenueQuantity/);
  assert.match(route, /sell_price \* revenue_quantity \* \? - isk_cost - material_total END max_profit/);
  assert.match(route, /buy_price \* revenue_quantity \* \? - isk_cost - material_total END min_profit/);
  assert.match(esi, /buyPrice: Math\.max/);
  assert.match(esi, /sellPrice: sells\.length \? Math\.min/);
});

test("首页只读取每日固定榜单快照", async () => {
  const [page, route, worker] = await Promise.all([source("app/page.tsx"), source("app/api/data/offers/route.ts"), source("scripts/sync-worker.mjs")]);
  assert.match(page, /热门物品前五/);
  assert.match(route, /FROM ranking_snapshots/);
  assert.match(worker, /rebuildRankings/);
  assert.doesNotMatch(route, /ORDER BY daily_volume DESC, lp_ratio DESC LIMIT 5/);
});

test("组合计算的全量材料查询按小批次执行", async () => {
  const route = await source("app/api/data/offers/route.ts");
  assert.match(route, /index \+= 20/);
  assert.match(route, /offers\.slice\(index, index \+ 20\)/);
  assert.match(route, /pageSize = requestedSize === "all"/);
});

test("历史同步跳过不可交易和不存在的物品", async () => {
  const [history, esi] = await Promise.all([source("app/api/sync/history/route.ts"), source("lib/esi-server.ts")]);
  assert.match(history, /if \(!isMarketUnavailable\(error\)\) throw error/);
  assert.match(esi, /type not tradable on market/i);
  assert.match(esi, /type not found/i);
});

test("历史同步使用较保守的 50 并发和 1 秒间隔", async () => {
  const [history, worker] = await Promise.all([source("app/api/sync/history/route.ts"), source("scripts/sync-worker.mjs")]);
  assert.match(history, /LIMIT 50/);
  assert.match(history, /concurrency: 50/);
  assert.match(worker, /job\.kind === "history" \? 1000/);
});

test("市场订单使用独立按钮", async () => {
  const [page, esi, route] = await Promise.all([source("app/page.tsx"), source("lib/esi-server.ts"), source("app/api/data/market-orders/route.ts")]);
  assert.doesNotMatch(page, /role="button"/);
  assert.match(page, /<button className="market-order-link"/);
  assert.match(page, /当前收单 · 价格从高到低/);
  assert.match(page, /当前卖单 · 价格从低到高/);
  assert.match(esi, /\.slice\(0, 5\)/);
  assert.match(esi, /grouped\.set\(order\.price/);
  assert.match(route, /FROM market_order_levels/);
});

test("企业页识别完整六件脑插套装并为单件保留订单按钮", async () => {
  const [page, route] = await Promise.all([source("app/page.tsx"), source("app/api/data/offers/route.ts")]);
  assert.match(route, /const levels = \["Alpha", "Beta", "Gamma", "Delta", "Epsilon", "Omega"\]/);
  assert.match(route, /filter\(\(\[, set\]\) => set\.size === 6\)/);
  assert.match(route, /market_value/);
  assert.match(page, /implantSetPanel/);
  assert.match(page, /item\.type_id, name: item\.name/);
});
