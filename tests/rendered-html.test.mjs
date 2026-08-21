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

test("首页两个榜单使用独立且可切换的排序状态", async () => {
  const page = await source("app/page.tsx");
  assert.match(page, /setPopularSort.*key: "volume", direction: "desc"/);
  assert.match(page, /setRatioSort.*key: "lpRatio", direction: "desc"/);
  assert.match(page, /sortCalculatedOffers\(popularCalculated, popularSort\)/);
  assert.match(page, /sortCalculatedOffers\(ratioCalculated, ratioSort\)/);
  assert.match(page, /toggleTableSort\(setPopularSort, key\)/);
  assert.match(page, /toggleTableSort\(setRatioSort, key\)/);
  assert.match(page, /if \(left === null\) return 1/);
  assert.doesNotMatch(page, /sortedPopular.*b\.volume - a\.volume/);
});

test("手机端使用独立卡片且桌面表格保持默认显示", async () => {
  const [page, css] = await Promise.all([source("app/page.tsx"), source("app/globals.css")]);
  assert.match(page, /className="mobile-offer-card"/);
  assert.match(page, /className="mobile-sort"/);
  assert.match(page, /查看全部价格与成本/);
  assert.match(page, /查看材料明细/);
  assert.match(css, /\.mobile-offer-card,\.mobile-sort\{display:none\}/);
  assert.match(css, /@media\(max-width:760px\)/);
  assert.match(css, /\.table \.offer-grid\.thead,\.table \.offer-grid\.row\{display:none\}/);
  assert.match(css, /\.mobile-offer-card\{display:block/);
  assert.match(css, /\.picker-menu\{inset:max\(10px,env\(safe-area-inset-top\)\)/);
  assert.match(css, /height:100dvh/);
});

test("增效剂蓝图默认过滤且可以手动显示", async () => {
  const [page, route, worker, rankings] = await Promise.all([source("app/page.tsx"), source("app/api/data/offers/route.ts"), source("scripts/sync-worker.mjs"), source("app/api/sync/rankings/route.ts")]);
  assert.match(route, /include_booster_blueprints/);
  assert.match(route, /br\.blueprint_type_id IS NOT NULL/);
  assert.match(route, /增效体/);
  assert.match(route, /%booster%/);
  assert.match(page, /showBoosterBlueprints/);
  assert.match(page, /显示增效剂蓝图/);
  assert.match(page, /隐藏增效剂蓝图/);
  assert.match(worker, /include_booster_blueprints: "1"/);
  assert.match(worker, /slice\(0, 100\)/);
  assert.match(rankings, /rows\.slice\(0, 100\)/);
  assert.match(route, /filter\(offer => includeBoosterBlueprints \|\| !isBoosterBlueprint\(offer\)\)\.slice\(0, 5\)/);
});

test("组合计算的全量材料查询按小批次执行", async () => {
  const route = await source("app/api/data/offers/route.ts");
  assert.match(route, /index \+= 20/);
  assert.match(route, /offers\.slice\(index, index \+ 20\)/);
  assert.match(route, /pageSize = requestedSize === "all"/);
});

test("组合计算只显示扣除成本后的保守利润和 LP 比例", async () => {
  const page = await source("app/page.tsx");
  assert.match(page, /unitPrice = material\.sell_price/);
  assert.match(page, /minProfit = offer\.buy_price > 0/);
  assert.match(page, /lpRatio = usedLp > 0 \? totalProfit \/ usedLp : 0/);
  assert.match(page, /总体 LP 比例/);
  assert.match(page, /税后净利润 ÷ 已使用 LP/);
  assert.doesNotMatch(page, /总体价值（收单）|totalValue/);
});

test("没有独立徽标的古力突击队回退到古斯塔斯势力徽标", async () => {
  const [page, route] = await Promise.all([source("app/page.tsx"), source("app/api/data/entity-icon/route.ts")]);
  assert.match(page, /NPC_CORPORATION_FACTION_FALLBACKS = new Map\(\[\[1000437, 500010\]\]\)/);
  assert.match(page, /fallback_faction_id/);
  assert.match(route, /INTERNATIONAL_DEFAULT_LOGO_HASHES/);
  assert.match(route, /network-faction-fallback/);
  assert.match(route, /corporations\/\$\{fallbackFactionId\}\/logo/);
});

test("历史同步跳过不可交易和不存在的物品", async () => {
  const [history, esi] = await Promise.all([source("app/api/sync/history/route.ts"), source("lib/esi-server.ts")]);
  assert.match(history, /if \(!isMarketUnavailable\(error\)\) throw error/);
  assert.match(esi, /type not tradable on market/i);
  assert.match(esi, /type not found/i);
});

test("历史同步每轮最多 50 条、使用 30 并发和 1 秒间隔", async () => {
  const [history, worker] = await Promise.all([source("app/api/sync/history/route.ts"), source("scripts/sync-worker.mjs")]);
  assert.match(history, /LIMIT 50/);
  assert.match(history, /const HISTORY_CONCURRENCY = 30/);
  assert.match(history, /concurrency: HISTORY_CONCURRENCY/);
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
