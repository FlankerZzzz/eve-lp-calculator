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
  assert.match(page, /热销榜/);
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
  assert.match(page, /const minProfit = hasBuyOrder \?/);
  assert.match(page, /coverage-shortage/);
  assert.doesNotMatch(page, /风险估算/);
  assert.match(page, /收单不足/);
  assert.match(page, /卖单不足 · 请核对实际订单情况，避免无法兑换/);
  assert.match(page, /outputCoverageWarning\(offer\)/);
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

check("后台同步服务由单一容器和单一 Node 进程承载", async () => {
  const [compose, daemon, worker, order, contracts] = await Promise.all([
    source("docker-compose.yml"),
    source("scripts/sync-daemon.mjs"),
    source("scripts/sync-worker.mjs"),
    source("scripts/order-sync-daemon.mjs"),
    source("scripts/contract-sync-daemon.mjs"),
  ]);
  assert.match(compose, /\n  sync:\n/);
  assert.match(compose, /container_name: eve-lp-sync/);
  assert.match(compose, /command: \["node", "scripts\/sync-daemon\.mjs"\]/);
  assert.match(compose, /SYNC_BASE_URL: http:\/\/web:3000/);
  assert.doesNotMatch(compose, /\n  sync-worker:|\n  sync-api:|\n  order-sync:|\n  contract-sync:/);
  assert.match(daemon, /runSyncWorker\(\)/);
  assert.match(daemon, /runOrderSyncDaemon\(\)/);
  assert.match(daemon, /runContractSyncDaemon\(\)/);
  assert.match(daemon, /Promise\.all/);
  assert.match(worker, /export async function runSyncWorker/);
  assert.match(order, /export async function runOrderSyncDaemon/);
  assert.match(contracts, /export async function runContractSyncDaemon/);
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

check("精选榜单支持仅展示可在高安执行任务的势力", async () => {
  const page = await source("app/page.tsx");
  assert.match(page, /HIGH_SEC_FACTION_IDS = new Set\(\[500001, 500002, 500003, 500004, 500007, 500008, 500015, 500016\]\)/);
  for (const corporationId of [1000179, 1000180, 1000181, 1000182]) {
    assert.match(page, new RegExp(String(corporationId)));
  }
  assert.match(page, /calculated\.filter\(isHighSecOffer\)/);
  assert.match(page, /仅展示高安势力/);
  assert.match(page, /aria-pressed=\{showHighSecOnly\}/);
});

check("四个涂装兑换军团在展示、榜单和市场同步中永久排除", async () => {
  const [policy, options, offers, rankings, history, orders, status, syncPage] = await Promise.all([
    source("lib/data-policy.ts"),
    source("app/api/data/options/route.ts"),
    source("app/api/data/offers/route.ts"),
    source("app/api/sync/rankings/route.ts"),
    source("app/api/sync/history/route.ts"),
    source("scripts/order-sync-daemon.mjs"),
    source("app/api/sync/status/route.ts"),
    source("app/sync/page.tsx"),
  ]);
  for (const corporationId of [1000283, 1000284, 1000285, 1000286]) assert.match(policy, new RegExp(String(corporationId)));
  assert.match(policy, /涂装专属兑换军团/);
  assert.match(options, /visibleCorporationSql/);
  assert.match(offers, /isGloballyExcludedCorporation\(corporationId, corporation\.faction_id\)/);
  assert.match(offers, /!isGloballyExcludedCorporation\(offer\.corporation_id, offer\.faction_id\)/);
  assert.match(rankings, /!isGloballyExcludedCorporation\(Number\(offer\?\.corporation_id\)/);
  assert.match(history, /visibleCorporationSql/);
  assert.match(orders, /visibleCorporationSql/);
  assert.match(status, /invalidItemCte[\s\S]*has_invalid_entity_source[\s\S]*has_visible_source/);
  assert.match(syncPage, /显示无效数据/);
  assert.match(syncPage, /排除势力与军团/);
  assert.match(syncPage, /永久跳过市场查询的物品/);
});

check("组合优化同时排除材料和产出订单深度不足的方案", async () => {
  const page = await source("app/page.tsx");
  assert.match(page, /offer\.materialsCovered && offer\.outputCovered/);
});

check("军团收藏夹仅保存在浏览器本地并支持切换与取消", async () => {
  const [page, css] = await Promise.all([source("app/page.tsx"), source("app/globals.css")]);
  assert.match(page, /FAVORITE_CORPORATIONS_STORAGE_KEY/);
  assert.match(page, /window\.localStorage\.setItem\(FAVORITE_CORPORATIONS_STORAGE_KEY/);
  assert.match(page, /selectedCorporationIsFavorite \? "取消收藏" : "添加到收藏夹"/);
  assert.match(page, /openFavoriteCorporation/);
  assert.match(page, /setCorporationId\(0\)/);
  assert.doesNotMatch(page, /fetch\([^\n]*favorite/i);
  assert.match(css, /\.favorite-cards\{[^}]*flex-wrap:wrap[^}]*height:94px[^}]*overflow-x:hidden;overflow-y:auto/);
  assert.match(css, /\.favorite-cards>div\{[^}]*width:max-content[^}]*height:44px/);
});

check("企业选择器点击外部收起且不再显示当前结果搜索框", async () => {
  const page = await source("app/page.tsx");
  assert.match(page, /corporationPickerRef/);
  assert.match(page, /document\.addEventListener\("pointerdown", closeOnOutsideClick\)/);
  assert.match(page, /corporationPickerRef\.current\?\.contains/);
  assert.doesNotMatch(page, /搜索当前结果/);
});

check("手机端企业详情头部不横向溢出且 PC 布局保持独立", async () => {
  const css = await source("app/globals.css");
  assert.match(css, /@media\(max-width:760px\)\{\n  \.table>\.ranking-head\{display:block;min-width:0/);
  assert.match(css, /\.table>\.ranking-head>\.detail-header-actions\{display:flex;flex-direction:column/);
  assert.match(css, /\.detail-corporation-card\{width:100%;min-width:0\}/);
  assert.match(css, /@media\(min-width:761px\)/);
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
  assert.match(rankings, /visibleRows = rows\.filter[\s\S]*\.slice\(0, 100\)/);
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

check("企业详情使用真实收单并在全量结果排序后分页", async () => {
  const [page, route] = await Promise.all([source("app/page.tsx"), source("app/api/data/offers/route.ts")]);
  assert.match(page, /params\.set\("page_size", "all"\)/);
  assert.match(page, /const hasBuyOrder = rawBuyPrice > 0/);
  assert.match(page, /const immediateBuyPrice = hasBuyOrder \? rawBuyPrice : 0/);
  assert.doesNotMatch(page, /expectedOutputPrice > rawBuyPrice \* 10/);
  assert.match(page, /sortCalculatedOffers\(detailCalculated/);
  assert.doesNotMatch(page, /sourcePriority/);
  assert.match(page, /filteredDetails\.slice\(\(safeDetailPage - 1\) \* detailPageSize/);
  assert.match(page, /rankingTable\("企业兑换详情"[^\n]*visibleDetails/);
  assert.match(page, /无估值或异常估值/);
  assert.match(page, /请自行评估价值/);
  assert.doesNotMatch(page, /采用卖单估算/);
  assert.match(page, /const lpRatio = hasBuyOrder && offer\.lp_cost > 0 && minProfit !== null \? minProfit \/ offer\.lp_cost : 0/);
  assert.match(page, /offer\.outputPriceSource !== "buy"/);
  assert.match(page, /offer\.lpRatio === 0/);
  assert.match(page, /LP 成本为 0 · 比例不可计算/);
  assert.match(page, /历史估值仅供参考 · 按 0 计算/);
  assert.match(route, /item\.buy_price > 0 \? item\.buy_price : item\.expected_price/);
  assert.doesNotMatch(route, /item\.expected_price > 0 \? item\.expected_price : item\.sell_price/);
});

check("组合计算按材料和产出数量逐档成交，并显示保守利润和 LP 比例", async () => {
  const page = await source("app/page.tsx");
  assert.match(page, /material\.sell_execution_price \|\| material\.sell_price/);
  assert.match(page, /hasBuyOrder && offer\.lp_cost > 0/);
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
  assert.match(route, /COALESCE\(pt\.type_id, t\.type_id\) type_id/);
  assert.match(route, /blueprint_materials bm/);
  assert.match(route, /filter\(\(\[, set\]\) => set\.size === 6\)/);
  assert.match(route, /market_value/);
  assert.match(page, /riskAwareImplantSetPanel/);
  assert.match(page, /typeId: item\.market_type_id \|\| item\.type_id/);
});

check("脑插可兑换套数只按 LP 计算并列出材料缺口", async () => {
  const [page, route] = await Promise.all([source("app/page.tsx"), source("app/api/data/offers/route.ts")]);
  assert.match(page, /filter\(\(\{ count \}\) => count > 0\)/);
  assert.match(page, /仅按 LP 粗略计算，材料未参与套数限制/);
  assert.match(page, /implantMaterialRequirements/);
  assert.match(page, /现有卖单/);
  assert.match(route, /sell_available_volume/);
  assert.match(page, /材料可能不足，请检查材料/);
  assert.match(page, /无收单 · 采用历史估值/);
  assert.match(page, /无收单及历史估值 · 请自行评估价值/);
  assert.match(route, /expected_price/);
  assert.match(route, /priceSource/);
  assert.match(page, /material-missing/);
});

check("脑插目录由全量同步生成且合同按增量明细签名匹配", async () => {
  const [route, page, catalog, contracts, core] = await Promise.all([
    source("app/api/data/contracts/route.ts"), source("app/page.tsx"), source("app/api/sync/catalog/route.ts"),
    source("scripts/contract-sync-daemon.mjs"), source("scripts/contract-sync-core.mjs"),
  ]);
  assert.doesNotMatch(route, /INSERT INTO implant_catalog/);
  assert.match(route, /sort\(\(a, b\) => a - b\)/);
  assert.match(catalog, /rebuildImplantCatalog/);
  assert.match(catalog, /DELETE FROM implant_catalog/);
  assert.match(contracts, /fetchDirectory\(metrics\)/);
  assert.match(contracts, /contract_item_cache/);
  assert.match(contracts, /DELETE FROM contract_snapshots/);
  assert.doesNotMatch(contracts, /contract\.volume >= 6/);
  assert.match(core, /quantities\.size !== 6/);
  assert.match(core, /setCounts\.size !== 1/);
  assert.match(contracts, /unit_price: contract\.price \/ item\.set_count/);
  assert.match(page, /公开合同价格/);
  assert.match(page, /implant-item-materials/);
  assert.match(page, /setRedemptionCost/);
  assert.match(page, /implant-contract-ratio/);
  assert.match(page, /contract\.unit_price - setRedemptionCost/);
});

check("蓝图展开材料区展示收益汇总并按需查询公开合同", async () => {
  const [page, css] = await Promise.all([source("app/page.tsx"), source("app/globals.css")]);
  assert.match(page, /BlueprintContractMatch/);
  assert.match(page, /blueprintContractControllersRef/);
  assert.match(page, /loadedBlueprintContractTypesRef/);
  assert.match(page, /blueprint_type_id=\$\{typeId\}&page_size=10/);
  assert.match(page, /signal: controller\.signal/);
  assert.match(page, /总材料成本/);
  assert.match(page, /产出物收单价/);
  assert.match(page, /最小利润/);
  assert.match(page, /合同价不参与利润/);
  assert.match(page, /蓝图公开合同价格/);
  assert.match(page, /每流程/);
  assert.doesNotMatch(page, />ME \{contract\.material_efficiency/);
  assert.match(page, /contractReferenceRatio/);
  assert.match(page, /ISK\/LP · 合同参考比例/);
  assert.match(page, /material\.material_kind !== "制造材料"/);
  assert.match(page, /unit="张"/);
  assert.match(page, /data\.status === "ready"/);
  assert.match(page, /仅作参考，不参与利润计算/);
  assert.match(page, /合同缓存正在建立，请稍后重试/);
  assert.match(page, /offer\.is_blueprint \? blueprintContractPanel/);
  assert.match(css, /\.blueprint-material-summary\{[^}]*grid-template-columns:repeat\(4/);
  assert.match(css, /\.blueprint-contract-list>div::before\{content:"复制提示 · 左键单击蓝图名称"/);
  assert.match(css, /@media\(max-width:760px\)\{\.blueprint-material-summary\{grid-template-columns:repeat\(2/);
  assert.match(css, /\.blueprint-contract-list>div\{grid-template-columns:minmax\(0,1fr\) auto/);
});

check("合同地点使用国服吉他四卫星四名称", async () => {
  const [route, daemon] = await Promise.all([source("app/api/data/contracts/route.ts"), source("scripts/contract-sync-daemon.mjs")]);
  assert.match(route, /吉他 4 - 卫星 4 - 加达里海军组装车间/);
  assert.match(daemon, /吉他 4 - 卫星 4 - 加达里海军组装车间/);
});

check("AK 兑换来源由统一无效数据策略排除并保留共享物品", async () => {
  const [policy, options, offers, history, orders, status, catalog] = await Promise.all([
    source("lib/data-policy.ts"), source("app/api/data/options/route.ts"), source("app/api/data/offers/route.ts"),
    source("app/api/sync/history/route.ts"), source("scripts/order-sync-daemon.mjs"), source("app/api/sync/status/route.ts"),
    source("app/api/sync/catalog/route.ts"),
  ]);
  assert.match(policy, /visibleOfferSql/);
  assert.match(policy, /COALESCE\(\$\{alias\}\.ak_cost, 0\) = 0/);
  assert.match(options, /visibleOfferSql/);
  assert.match(offers, /const conditions: string\[\] = \[visibleOffer\]/);
  assert.match(offers, /akOfferKeys/);
  assert.match(history, /visibleOfferSql/);
  assert.match(orders, /visibleOfferSql/);
  assert.match(status, /has_ak_source/);
  assert.match(status, /Analysis Kredits（AK）/);
  assert.match(catalog, /COALESCE\(o\.ak_cost,0\)=0/);
});

check("目录和蓝图通过暂存表原子发布", async () => {
  const [catalog, schema] = await Promise.all([source("app/api/sync/catalog/route.ts"), source("db/d1.ts")]);
  assert.match(schema, /CREATE TABLE IF NOT EXISTS lp_offer_staging/);
  assert.match(schema, /CREATE TABLE IF NOT EXISTS blueprint_recipe_staging/);
  assert.match(catalog, /INSERT INTO lp_offer_staging/);
  assert.match(catalog, /INSERT INTO lp_offers[\s\S]*SELECT corporation_id, offer_id[\s\S]*FROM lp_offer_staging/);
  assert.match(catalog, /UPDATE corporations SET faction_id=\?, offers_synced_at/);
  assert.match(catalog, /INSERT INTO blueprint_recipe_staging/);
  assert.match(catalog, /INSERT OR REPLACE INTO blueprint_checks/);
});

check("前端取消过期请求并提示合同缓存已过期", async () => {
  const [page, css] = await Promise.all([source("app/page.tsx"), source("app/globals.css")]);
  assert.match(page, /loadOffers\(controller\.signal\)/);
  assert.match(page, /return \(\) => controller\.abort\(\)/);
  assert.match(page, /market-orders[\s\S]*signal: controller\.signal/);
  assert.match(page, /合同缓存已过期，以下为上次成功数据/);
  assert.match(css, /contract-stale-warning/);
});

check("只保留当前渲染的脑插面板实现", async () => {
  const page = await source("app/page.tsx");
  assert.match(page, /riskAwareImplantSetPanel/);
  assert.match(page, /lpOnlyImplantExchangePanel/);
  assert.doesNotMatch(page, /enhancedImplantSetPanel|finalImplantSetPanel|const implantExchangePanel/);
});
