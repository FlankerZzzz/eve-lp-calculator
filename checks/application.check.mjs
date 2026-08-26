import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import check from "node:test";

const root = new URL("../", import.meta.url);
const source = path => readFile(new URL(path, root), "utf8");

check("最大利润保留最低卖单参考，最小利润按产出数量逐档吃收单", async () => {
  const [page, route, esi] = await Promise.all([source("app/page.tsx"), source("app/api/data/offers/route.ts"), source("lib/esi-server.ts")]);
  assert.match(page, /offer\.sell_price \* revenueQuantity/);
  assert.match(page, /immediateBuyPrice \* revenueQuantity/);
  assert.match(route, /executionPrice\(orderLevels\.get\(typeId\)\?\.buy/);
  assert.match(route, /sell_price \* revenue_quantity \* \? - isk_cost - material_total END max_profit/);
  assert.match(route, /buy_price \* revenue_quantity \* \? - isk_cost - material_total END min_profit/);
  assert.match(esi, /buyPrice: Math\.max/);
  assert.match(esi, /sellPrice: sells\.length \? Math\.min/);
});

check("首页只读取每日固定榜单快照", async () => {
  const [page, route, worker] = await Promise.all([source("app/page.tsx"), source("app/api/data/offers/route.ts"), source("scripts/sync-worker.mjs")]);
  assert.match(page, /热门物品榜/);
  assert.match(route, /FROM ranking_snapshots/);
  assert.match(worker, /rebuildRankings/);
  assert.doesNotMatch(route, /ORDER BY daily_volume DESC, lp_ratio DESC LIMIT 5/);
});

check("兑换方案物品信息不显示由 LP 输入推算的可兑换次数", async () => {
  const page = await source("app/page.tsx");
  assert.doesNotMatch(page, /affordableRedemptions|showRedemption|可兑换.*次/);
});

check("订单深度不足时保留利润估算并显示材料与收单风险", async () => {
  const page = await source("app/page.tsx");
  assert.match(page, /const maxProfit = offer\.sell_price > 0 \?/);
  assert.match(page, /const minProfit = immediateBuyPrice > 0 \?/);
  assert.match(page, /coverage-shortage/);
  assert.doesNotMatch(page, /风险估算/);
  assert.match(page, /收单不足/);
  assert.match(page, /卖单不足 · 请核对实际订单情况，避免无法兑换/);
  assert.match(page, /offer\.materialsCovered && offer\.outputCovered/);
});

check("订单使用伏尔戈全量双槽快照并按半小时调度", async () => {
  const [daemon, worker, schema] = await Promise.all([source("scripts/order-sync-daemon.mjs"), source("scripts/sync-worker.mjs"), source("db/d1.ts")]);
  assert.match(daemon, /order_type=all&page=\$\{page\}/);
  assert.doesNotMatch(daemon, /orders\/\?[^`\n]*type_id=/);
  assert.match(daemon, /JITA_44_LOCATION_ID = 60003760/);
  assert.match(daemon, /PAGE_CONCURRENCY = 8/);
  assert.match(daemon, /market_order_book_state/);
  assert.match(daemon, /保留上一份完整快照并自动重试/);
  assert.match(worker, /function halfHourSlotKey/);
  assert.match(worker, /orderRunSlot !== currentOrderSlot/);
  assert.match(schema, /CREATE TABLE IF NOT EXISTS market_order_book/);
});

check("榜单按上海时间每日四次更新", async () => {
  const rankings = await source("app/api/sync/rankings/route.ts");
  assert.match(rankings, /RANKING_HOURS = \[9, 15, 18, 21\]/);
  assert.match(rankings, /dueRankingSlot/);
  assert.match(rankings, /本时段榜单已更新/);
});

check("同步控制台不再提供关联同步", async () => {
  const [page, control, status] = await Promise.all([source("app/sync/page.tsx"), source("app/api/sync/control/route.ts"), source("app/api/sync/status/route.ts")]);
  assert.doesNotMatch(page, /linked|关联同步|SQLite\/D1/);
  assert.doesNotMatch(control, /linked/);
  assert.match(status, /kind != 'linked'/);
});

check("首页两个榜单使用独立且可切换的排序状态", async () => {
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

check("手机端使用独立卡片且桌面表格保持默认显示", async () => {
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

check("增效剂蓝图默认过滤且可以手动显示", async () => {
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
  assert.match(route, /filter\(offer => includeBoosterBlueprints \|\| !isBoosterBlueprint\(offer\)\)\.slice\(0, 100\)/);
});

check("首页榜单扩展为前一百并支持分页", async () => {
  const [page, route] = await Promise.all([source("app/page.tsx"), source("app/api/data/offers/route.ts")]);
  assert.match(page, /前 100 条/);
  assert.match(page, /rankingPager/);
  assert.match(page, /每页 100 条/);
  assert.match(route, /filter\(offer => includeBoosterBlueprints \|\| !isBoosterBlueprint\(offer\)\)\.slice\(0, 100\)/);
});

check("组合计算的全量材料查询按小批次执行", async () => {
  const route = await source("app/api/data/offers/route.ts");
  assert.match(route, /index \+= 20/);
  assert.match(route, /offers\.slice\(index, index \+ 20\)/);
  assert.match(route, /pageSize = requestedSize === "all"/);
});

check("组合计算按材料和产出数量逐档成交，并显示保守利润和 LP 比例", async () => {
  const page = await source("app/page.tsx");
  assert.match(page, /material\.sell_execution_price \|\| material\.sell_price/);
  assert.match(page, /immediateBuyPrice > 0/);
  assert.match(page, /lpRatio = usedLp > 0 \? totalProfit \/ usedLp : 0/);
  assert.match(page, /总体 LP 比例/);
  assert.match(page, /税后净利润 ÷ 已使用 LP/);
  assert.doesNotMatch(page, /总体价值（收单）|totalValue/);
});

check("没有独立徽标的古力突击队回退到古斯塔斯势力徽标", async () => {
  const [page, route] = await Promise.all([source("app/page.tsx"), source("app/api/data/entity-icon/route.ts")]);
  assert.match(page, /NPC_CORPORATION_FACTION_FALLBACKS = new Map\(\[\[1000437, 500010\]\]\)/);
  assert.match(page, /fallback_faction_id/);
  assert.match(route, /INTERNATIONAL_DEFAULT_LOGO_HASHES/);
  assert.match(route, /network-faction-fallback/);
  assert.match(route, /corporations\/\$\{fallbackFactionId\}\/logo/);
});

check("历史同步跳过不可交易和不存在的物品", async () => {
  const [history, esi] = await Promise.all([source("app/api/sync/history/route.ts"), source("lib/esi-server.ts")]);
  assert.match(history, /if \(!isMarketUnavailable\(error\)\) throw error/);
  assert.match(esi, /type not tradable on market/i);
  assert.match(esi, /type not found/i);
});

check("历史同步每轮最多 50 条、使用 30 并发和 1 秒间隔", async () => {
  const [history, worker] = await Promise.all([source("app/api/sync/history/route.ts"), source("scripts/sync-worker.mjs")]);
  assert.match(history, /LIMIT 50/);
  assert.match(history, /const HISTORY_CONCURRENCY = 30/);
  assert.match(history, /concurrency: HISTORY_CONCURRENCY/);
  assert.match(worker, /job\.kind === "history" \? 1000/);
});

check("市场订单使用独立按钮", async () => {
  const [page, esi, route] = await Promise.all([source("app/page.tsx"), source("lib/esi-server.ts"), source("app/api/data/market-orders/route.ts")]);
  assert.doesNotMatch(page, /role="button"/);
  assert.match(page, /<button className="market-order-link"/);
  assert.match(page, /当前收单 · 价格从高到低/);
  assert.match(page, /当前卖单 · 价格从低到高/);
  assert.doesNotMatch(esi, /\.slice\(0, 5\)/);
  assert.match(esi, /grouped\.set\(order\.price/);
  assert.match(route, /FROM market_order_levels/);
  assert.match(page, /\[10, 20, 50\]/);
});

check("手机端订单不足材料行避开左侧风险指示线", async () => {
  const css = await source("app/globals.css");
  assert.match(css, /\.material-row\.order-shortage\{padding:12px 8px 12px 12px\}/);
});

check("历史收益支持 30、15、7、3 日和当日均价对比", async () => {
  const [page, route] = await Promise.all([source("app/page.tsx"), source("app/api/data/offers/route.ts")]);
  assert.match(page, /type HistoryWindow = 30 \| 15 \| 7 \| 3 \| 1/);
  assert.match(page, /历史价对比/);
  assert.match(page, /historyDeviation/);
  assert.match(route, /history_30/);
  assert.match(route, /history_15/);
  assert.match(route, /history_7/);
  assert.match(route, /history_3/);
  assert.match(route, /history_1/);
  assert.match(page, /最近交易日/);
  assert.match(route, /MAX\(trade_date\)/);
  assert.match(route, /previousLatest \|\| row\.trade_date > previousLatest\.trade_date/);
  assert.match(route, /latest\.get\(typeId\)\?\.average_price/);
});

check("前端历史周期移除三日选项并为最近交易日标注实际日期", async () => {
  const page = await source("app/page.tsx");
  assert.match(page, /\[30, 15, 7, 1\] as HistoryWindow\[\]/);
  assert.doesNotMatch(page, /\[30, 15, 7, 3, 1\] as HistoryWindow\[\]/);
  assert.match(page, /最近交易日：\$\{chineseTradeDate\(latestPublishedTradeDate\)\}/);
  assert.match(page, /title=\{recentDateHint\}/);
});

check("历史同步错过 00:30 后会补跑且冲突不会被误判成功", async () => {
  const worker = await source("scripts/sync-worker.mjs");
  assert.match(worker, /historyUpdatedDate !== today/);
  assert.match(worker, /response\.status === 409/);
  assert.doesNotMatch(worker, /response\.ok \|\| response\.status === 409/);
  assert.match(worker, /60 秒后重新调度/);
});

check("桌面榜单使用高密度组合列和30天自然日均量", async () => {
  const [page, route, css] = await Promise.all([source("app/page.tsx"), source("app/api/data/offers/route.ts"), source("app/globals.css")]);
  assert.match(page, /30天日均交易量/);
  assert.match(page, /指示价格利润/);
  assert.match(page, /低于.*（指示价格）/);
  assert.match(route, /SUM\(volume\) \/ \?/);
  assert.match(route, /MARKET_REGION_ID, days, cutoff, MARKET_REGION_ID, MARKET_REGION_ID/);
  assert.match(route, /anchorDate\}T00:00:00Z/);
  assert.doesNotMatch(route, /anchorDate\}T00:00:00\+08:00/);
  assert.match(page, /formatNumber\(offer\.revenue_quantity \|\| offer\.quantity\)/);
  assert.doesNotMatch(page, /· 产出 \$\{offer\.product_name/);
  assert.match(css, /volume-value::before.*yield::before/);
  assert.match(page, /function SalesSparkline/);
  assert.match(page, /function publishedVolumePoints/);
  assert.match(page, /findLastIndex\(point => point\.volume > 0\)/);
  assert.match(page, /publishedVolumePoints\(points\)\.slice\(-30\)/);
  assert.match(page, /dateIndexes = \[0, 7, 14, 21, 29\]/);
  assert.match(page, /Math\.sqrt\(value \/ maximum\)/);
  assert.match(page, /function SalesTrend/);
  assert.match(page, /publishedVolumePoints\(points\)\.slice\(-6\)/);
  assert.match(page, /values\.slice\(0, 3\).*values\.slice\(3\)/s);
  assert.match(page, /3日走势/);
  assert.match(route, /historyDates\(latestHistoryDate, 30\)/);
  assert.match(route, /daily_volumes: historyData\.volumes\.get\(typeId\)/);
});

check("企业页识别完整六件脑插套装并为单件保留订单按钮", async () => {
  const [page, route] = await Promise.all([source("app/page.tsx"), source("app/api/data/offers/route.ts")]);
  assert.match(route, /const levels = \["Alpha", "Beta", "Gamma", "Delta", "Epsilon", "Omega"\]/);
  assert.match(route, /filter\(\(\[, set\]\) => set\.size === 6\)/);
  assert.match(route, /market_value/);
  assert.match(page, /implantSetPanel/);
  assert.match(page, /item\.type_id, name: item\.name/);
});
