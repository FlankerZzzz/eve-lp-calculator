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
  const [page, policy] = await Promise.all([source("app/page.tsx"), source("lib/data-policy.ts")]);
  assert.match(policy, /HIGH_SEC_FACTION_IDS = new Set\(\[500001, 500002, 500003, 500004, 500007, 500008, 500015, 500016\]\)/);
  assert.match(page, /params.set\("exclude", showHighSecOnly \? "1" : "0"\)/);
  for (const corporationId of [1000179, 1000180, 1000181, 1000182]) {
    assert.match(policy, new RegExp(String(corporationId)));
  }
  assert.doesNotMatch(page, /calculated\.filter\(isHighSecOffer\)/);
  assert.match(page, /仅展示高安势力/);
  assert.match(page, /aria-pressed=\{showHighSecOnly\}/);
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

check("共享功能栏支持 LP、合同入口与本地固定状态", async () => {
  const [layout, sidebar, contractPage, styles] = await Promise.all([
    source("app/layout.tsx"), source("app/tool-sidebar.tsx"), source("app/contracts/page.tsx"), source("app/globals.css"),
  ]);
  assert.match(layout, /<ToolSidebar \/>/);
  assert.match(sidebar, /LP 计算器/);
  assert.match(sidebar, /合同工具/);
  assert.match(sidebar, /eve-lp-calculator:tool-sidebar-pinned/);
  assert.match(sidebar, /aria-pressed=\{pinned\}/);
  assert.match(styles, /\.tool-sidebar:hover/);
  assert.match(styles, /body\.tool-sidebar-pinned \.tool-workspace/);
  assert.match(styles, /\.tool-sidebar\.mobile-open/);
  assert.match(contractPage, /合同分析/);
  assert.match(contractPage, /contract-analysis/);
});

check("合同清空按钮重置输入结果筛选和排序，并防止旧请求回填", async () => {
  const page = await source("app/contracts/page.tsx");
  assert.match(page, /className="contract-analyzer-actions"/);
  assert.match(page, /onClick=\{clear\}>清空/);
  assert.match(page, /analysisRequest\.current\?\.abort\(\)/);
  assert.match(page, /setText\(""\); setAnalysis\(null\); setLoading\(false\); setActiveAlertState\(null\)/);
  assert.match(page, /setSortState\(\{ key: "name", direction: "asc" \}\)/);
  assert.match(page, /if \(controller\.signal\.aborted\) return/);
  assert.match(page, /analysisRequest\.current === controller/);
});

check("合同分析固定使用晨曦市场并分别展示卖出、收购与加权估价", async () => {
  const [route, page, core] = await Promise.all([source("app/api/data/contract-analysis/route.ts"), source("app/contracts/page.tsx"), source("lib/contract-analysis.ts")]);
  assert.match(route, /MARKET_REGION_ID/);
  assert.match(route, /contract_item_cache/);
  assert.match(route, /market_order_book/);
  assert.doesNotMatch(route, /fetchMarketOrders/);
  assert.match(route, /market_daily/);
  assert.doesNotMatch(route, /weightedEstimate/);
  assert.match(route, /estimatePrice = historyPrice > 0 \? historyPrice : null/);
  assert.match(page, /卖单价/);
  assert.match(page, /卖单总价/);
  assert.match(page, /收单价/);
  assert.match(page, /收单总价/);
  assert.match(page, /历史单价/);
  assert.match(page, /历史总价/);
  assert.match(core, /sellVolume/);
  assert.match(core, /买Volume|buyVolume/);
  assert.match(core, /Intl.NumberFormat\("en-US"/);
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
  assert.match(route, /buy_execution_price: execution\.price \|\| offer\.buy_price/);
  assert.match(route, /buy_execution_coverage: execution\.price \? execution\.coverage/);
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



check("市场订单使用独立按钮", async () => {
  const [page, esi, route] = await Promise.all([source("app/page.tsx"), source("lib/esi-server.ts"), source("app/api/data/market-orders/route.ts")]);
  assert.doesNotMatch(page, /role="button"/);
  assert.match(page, /<button className="market-order-link"/);
  assert.match(page, /当前收单 · 价格从高到低/);
  assert.match(page, /当前卖单 · 价格从低到高/);
  assert.doesNotMatch(esi, /\.slice\(0, 5\)/);
  assert.match(esi, /grouped\.set\(order\.price/);
  assert.match(route, /FROM market_order_book/);
  assert.match(route, /location_name/);
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
  assert.match(route, /item\.buy_price > 0 \? item\.buy_price : item\.expected_price/);
  assert.doesNotMatch(route, /item\.sell_price > 0 \? item\.sell_price : item\.expected_price/);
  assert.match(page, /无收单 · 采用历史估值/);
  assert.match(page, /无收单及历史成交 · 不参与 LP 比例/);
  assert.match(page, /数据不完整（\$\{sellPricedCount\}\/\$\{set\.item_count\}）/);
  assert.match(page, /LP 比例优先采用此价/);
  assert.match(route, /expected_price/);
  assert.match(route, /priceSource/);
  assert.match(page, /material-missing/);
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
