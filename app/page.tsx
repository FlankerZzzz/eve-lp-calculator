"use client";

import { type Dispatch, type SetStateAction, useCallback, useEffect, useMemo, useRef, useState } from "react";

type SortKey = "lp_cost" | "isk_cost" | "materialCost" | "sell_price" | "buy_price" | "maxProfit" | "minProfit" | "lpRatio" | "volume";
type SortDirection = "asc" | "desc";
type TableSort = { key: SortKey; direction: SortDirection };

type FactionOption = { faction_id: number; name: string };
type CorporationOption = { corporation_id: number; faction_id: number | null; name: string; offer_count: number };
type Counts = { corporations: number; items: number; offers: number; history_rows: number; order_types: number };
type Material = { type_id: number; quantity: number; item_name: string; buy_price: number; sell_price: number; material_kind?: string };
type StoredOffer = {
  corporation_id: number; offer_id: number; type_id: number; quantity: number; lp_cost: number; isk_cost: number;
  corporation_name: string; faction_id: number | null; faction_name: string | null; item_name: string;
  historical_price: number; daily_volume: number; buy_price: number; sell_price: number; materials: Material[];
  is_blueprint: number; product_type_id: number | null; product_name: string | null; revenue_quantity: number;
};
type CalculatedMaterial = Material & { unitPrice: number; cost: number };
type CalculatedOffer = StoredOffer & { materialCost: number; unitPrice: number; netRevenue: number; profit: number; maxProfit: number | null; minProfit: number | null; lpRatio: number; volume: number; affordableRedemptions: number; calculatedMaterials: CalculatedMaterial[] };
type OptimizationLine = { offer: CalculatedOffer; count: number };
type OptimizationResult = { lines: OptimizationLine[]; usedLp: number; remainingLp: number; totalProfit: number; lpRatio: number; exact: boolean };
type MarketOrderLevel = { side: "buy" | "sell"; level: number; price: number; volume: number };
type MarketHistoryDay = { trade_date: string; average_price: number; highest_price: number; lowest_price: number; volume: number };
type MarketOrderSnapshot = { type_id: number; item_name: string; buy_price: number | null; sell_price: number | null; buy_volume: number | null; sell_volume: number | null; collected_at: string | null; buy_levels: MarketOrderLevel[]; sell_levels: MarketOrderLevel[]; history: MarketHistoryDay[]; history_summary: { days: number; total_volume: number; weighted_average: number | null } };
type ImplantSet = { name: string; item_count: number; total_lp: number; lp_ratio: number | null; priced_count: number; market_value: number | null; items: { level: string; type_id: number; name: string; lp_cost: number; sell_price: number }[] };

function ItemIcon({ typeId, name, size = 32, className = "" }: { typeId: number; name: string; size?: 32 | 64 | 128; className?: string }) {
  return <img className={`item-icon ${className}`.trim()} src={`/api/data/item-icon?type_id=${typeId}&size=${size}`} width={size} height={size} loading="lazy" decoding="async" alt={`${name}图标`} />;
}

const NPC_CORPORATION_FACTION_FALLBACKS = new Map([[1000437, 500010]]);

function EntityIcon({ id, name, kind }: { id: number; name: string; kind: "faction" | "corporation" }) {
  const fallbackFactionId = kind === "corporation" ? NPC_CORPORATION_FACTION_FALLBACKS.get(id) : undefined;
  const factionFallback = fallbackFactionId ? `&fallback_faction_id=${fallbackFactionId}` : "";
  return <img className="entity-icon" src={`/api/data/entity-icon?kind=${kind}&id=${id}&size=64${factionFallback}`} width={32} height={32} loading="lazy" decoding="async" alt={`${name}徽标`} />;
}

function sortCalculatedOffers(source: CalculatedOffer[], sort: TableSort) {
  return [...source].sort((a, b) => {
    const left = a[sort.key];
    const right = b[sort.key];
    if (left === null && right === null) return a.item_name.localeCompare(b.item_name, "zh-CN");
    if (left === null) return 1;
    if (right === null) return -1;
    const difference = left - right;
    if (difference === 0) return a.item_name.localeCompare(b.item_name, "zh-CN");
    return sort.direction === "asc" ? difference : -difference;
  });
}

export default function Home() {
  const [lp, setLp] = useState(100000);
  const [tax, setTax] = useState(3);
  const [windowDays] = useState(30);
  const [query, setQuery] = useState("");
  const [corporationSearchInput, setCorporationSearchInput] = useState("");
  const [corporationSearch, setCorporationSearch] = useState("");
  const [corporationPickerOpen, setCorporationPickerOpen] = useState(false);
  const [pickerFactionId, setPickerFactionId] = useState(0);
  const [factionId, setFactionId] = useState(0);
  const [corporationId, setCorporationId] = useState(0);
  const [factions, setFactions] = useState<FactionOption[]>([]);
  const [corporations, setCorporations] = useState<CorporationOption[]>([]);
  const [popularOffers, setPopularOffers] = useState<StoredOffer[]>([]);
  const [highRatioOffers, setHighRatioOffers] = useState<StoredOffer[]>([]);
  const [detailOffers, setDetailOffers] = useState<StoredOffer[]>([]);
  const [detailTotal, setDetailTotal] = useState(0);
  const [detailPages, setDetailPages] = useState(1);
  const [implantSets, setImplantSets] = useState<ImplantSet[]>([]);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState("10");
  const [showBoosterBlueprints, setShowBoosterBlueprints] = useState(false);
  const [loading, setLoading] = useState(true);
  const [status, setStatus] = useState("正在读取本地数据库…");
  const [sortKey, setSortKey] = useState<SortKey>("lpRatio");
  const [sortDirection, setSortDirection] = useState<SortDirection>("desc");
  const [popularSort, setPopularSort] = useState<TableSort>({ key: "volume", direction: "desc" });
  const [ratioSort, setRatioSort] = useState<TableSort>({ key: "lpRatio", direction: "desc" });
  const [expandedOffers, setExpandedOffers] = useState<Set<string>>(new Set());
  const [optimizing, setOptimizing] = useState(false);
  const [optimization, setOptimization] = useState<OptimizationResult | null>(null);
  const [marketTarget, setMarketTarget] = useState<{ typeId: number; name: string } | null>(null);
  const [marketSnapshot, setMarketSnapshot] = useState<MarketOrderSnapshot | null>(null);
  const [marketLoading, setMarketLoading] = useState(false);
  const marketTriggerRef = useRef<HTMLElement | null>(null);

  const openMarket = useCallback((target: { typeId: number; name: string }, trigger: HTMLElement) => {
    marketTriggerRef.current = trigger;
    setMarketTarget(target);
  }, []);
  const closeMarket = useCallback(() => {
    const trigger = marketTriggerRef.current;
    setMarketTarget(null);
    requestAnimationFrame(() => trigger?.focus());
  }, []);

  const loadOptions = useCallback(async () => {
    const response = await fetch("/api/data/options", { cache: "no-store" });
    if (!response.ok) throw new Error("无法读取数据库选项");
    const data = await response.json() as { factions: FactionOption[]; corporations: CorporationOption[]; counts: Counts };
    setFactions(data.factions);
    setCorporations(data.corporations);
  }, []);

  const loadOffers = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams({ days: String(windowDays), tax: String(tax), price_mode: "卖价" });
      if (showBoosterBlueprints) params.set("include_booster_blueprints", "1");
      if (factionId) params.set("faction_id", String(factionId));
      if (corporationId) {
        params.set("corporation_id", String(corporationId));
        params.set("view", "detail");
        params.set("page", String(page));
        params.set("page_size", pageSize);
        params.set("sort_key", sortKey);
        params.set("sort_direction", sortDirection);
      }
      const response = await fetch(`/api/data/offers?${params}`, { cache: "no-store" });
      if (!response.ok) throw new Error("无法读取兑换数据");
      if (corporationId) {
        const data = await response.json() as { offers: StoredOffer[]; total: number; pages: number; implant_sets?: ImplantSet[] };
        setDetailOffers(data.offers);
        setDetailTotal(data.total);
        setDetailPages(data.pages);
        setImplantSets(data.implant_sets || []);
        setStatus(`企业详情：第 ${page} 页，共 ${data.total.toLocaleString()} 条兑换方案`);
      } else {
        const data = await response.json() as { popular: StoredOffer[]; highRatio: StoredOffer[]; calculatedAt?: string | null };
        setPopularOffers(data.popular);
        setHighRatioOffers(data.highRatio);
        const uniqueCount = new Set([...data.popular, ...data.highRatio].map(offer => `${offer.corporation_id}:${offer.offer_id}`)).size;
        setStatus(uniqueCount ? `首页已载入 ${uniqueCount} 条固定榜单 · ${data.calculatedAt ? new Date(data.calculatedAt).toLocaleString("zh-CN") : "等待重算"}` : "尚无榜单快照，请到 SYNC 页面手动重算");
      }
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "读取数据库失败");
      setPopularOffers([]);
      setHighRatioOffers([]);
      setDetailOffers([]);
      setImplantSets([]);
    } finally { setLoading(false); }
  }, [corporationId, factionId, page, pageSize, showBoosterBlueprints, sortDirection, sortKey, tax, windowDays]);

  useEffect(() => { loadOptions().catch(error => setStatus(error instanceof Error ? error.message : "读取数据库失败")); }, [loadOptions]);
  useEffect(() => { loadOffers(); }, [loadOffers]);
  useEffect(() => { setOptimization(null); }, [corporationId, lp, showBoosterBlueprints, tax, windowDays]);
  useEffect(() => {
    if (!marketTarget) return;
    setMarketLoading(true);
    setMarketSnapshot(null);
    fetch(`/api/data/market-orders?type_id=${marketTarget.typeId}`, { cache: "no-store" })
      .then(async response => { if (!response.ok) throw new Error("本地数据库暂无订单数据"); return response.json() as Promise<MarketOrderSnapshot>; })
      .then(setMarketSnapshot).catch(() => setMarketSnapshot(null)).finally(() => setMarketLoading(false));
  }, [marketTarget]);
  useEffect(() => {
    if (!marketTarget) return;
    (document.querySelector(".market-modal header button") as HTMLButtonElement | null)?.focus();
    const close = (event: KeyboardEvent) => { if (event.key === "Escape") closeMarket(); };
    window.addEventListener("keydown", close);
    return () => {
      window.removeEventListener("keydown", close);
      requestAnimationFrame(() => marketTriggerRef.current?.focus());
    };
  }, [closeMarket, marketTarget]);

  const searchedCorporations = useMemo(() => {
    const keyword = corporationSearch.trim().toLocaleLowerCase();
    return corporations.filter(corporation => !keyword || corporation.name.toLocaleLowerCase().includes(keyword) || corporation.corporation_id === corporationId);
  }, [corporationId, corporationSearch, corporations]);
  const corporationGroups = useMemo(() => factions.map(faction => ({
    ...faction,
    corporations: searchedCorporations.filter(corporation => corporation.faction_id === faction.faction_id),
  })).filter(group => group.corporations.length > 0), [factions, searchedCorporations]);
  const ungroupedCorporations = useMemo(() => searchedCorporations.filter(corporation => corporation.faction_id === null || !factions.some(faction => faction.faction_id === corporation.faction_id)), [factions, searchedCorporations]);
  const selectedCorporation = useMemo(() => corporations.find(corporation => corporation.corporation_id === corporationId), [corporationId, corporations]);
  const selectedFaction = useMemo(() => factions.find(faction => faction.faction_id === factionId), [factionId, factions]);
  const pickerCorporations = useMemo(() => pickerFactionId
    ? corporationGroups.find(group => group.faction_id === pickerFactionId)?.corporations ?? []
    : ungroupedCorporations, [corporationGroups, pickerFactionId, ungroupedCorporations]);
  const applyCorporationSearch = () => {
    setCorporationSearch(corporationSearchInput);
    const keyword = corporationSearchInput.trim().toLocaleLowerCase();
    const firstMatch = corporations.find(corporation => !keyword || corporation.name.toLocaleLowerCase().includes(keyword));
    if (firstMatch?.faction_id) setPickerFactionId(firstMatch.faction_id);
    setPage(1);
  };

  const calculate = useCallback((source: StoredOffer[], applyQuery = true) => source.filter(offer => !applyQuery || offer.item_name.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase())).map(offer => {
    const calculatedMaterials = offer.materials.map(material => {
      const unitPrice = material.sell_price;
      return { ...material, unitPrice, cost: material.quantity * unitPrice };
    });
    const materialCost = calculatedMaterials.reduce((sum, material) => sum + material.cost, 0);
    const unitPrice = offer.historical_price;
    const revenueQuantity = offer.revenue_quantity || offer.quantity;
    const netRevenue = unitPrice * revenueQuantity * (1 - tax / 100);
    const profit = netRevenue - offer.isk_cost - materialCost;
    const maxProfit = offer.sell_price > 0 ? offer.sell_price * revenueQuantity * (1 - tax / 100) - offer.isk_cost - materialCost : null;
    const minProfit = offer.buy_price > 0 ? offer.buy_price * revenueQuantity * (1 - tax / 100) - offer.isk_cost - materialCost : null;
    const lpRatio = offer.lp_cost > 0 && minProfit !== null ? minProfit / offer.lp_cost : 0;
    const affordableRedemptions = offer.lp_cost > 0 ? Math.floor(lp / offer.lp_cost) : 0;
    return { ...offer, materialCost, unitPrice, netRevenue, profit, maxProfit, minProfit, lpRatio, volume: offer.daily_volume, affordableRedemptions, calculatedMaterials };
  }), [lp, query, tax]);

  const optimizeCorporation = useCallback(async () => {
    if (!corporationId || lp <= 0) return;
    setOptimizing(true);
    setOptimization(null);
    try {
      const params = new URLSearchParams({ corporation_id: String(corporationId), view: "detail", page_size: "all", days: String(windowDays), tax: String(tax), price_mode: "卖价" });
      if (showBoosterBlueprints) params.set("include_booster_blueprints", "1");
      const response = await fetch(`/api/data/offers?${params}`, { cache: "no-store" });
      if (!response.ok) throw new Error("无法读取当前企业全部兑换方案");
      const data = await response.json() as { offers: StoredOffer[] };
      const candidates = calculate(data.offers, false).filter(offer => offer.lp_cost > 0 && offer.minProfit !== null && offer.minProfit > 0);
      if (!candidates.length) throw new Error("当前企业没有收单价完整且税后盈利的兑换方案");
      const gcd = (a: number, b: number): number => b ? gcd(b, a % b) : a;
      const lpUnit = candidates.reduce((value, offer) => gcd(value, offer.lp_cost), candidates[0].lp_cost);
      const maxExactCapacity = 500000;
      let fixedOffer: CalculatedOffer | null = null;
      let fixedCount = 0;
      let workingLp = lp;
      const exact = Math.floor(lp / lpUnit) <= maxExactCapacity;
      if (!exact) {
        fixedOffer = [...candidates].sort((a, b) => (b.lpRatio ?? -Infinity) - (a.lpRatio ?? -Infinity))[0];
        const optimizeTailLp = maxExactCapacity * lpUnit;
        fixedCount = Math.max(0, Math.floor((lp - optimizeTailLp) / fixedOffer.lp_cost));
        workingLp -= fixedCount * fixedOffer.lp_cost;
      }
      const capacity = Math.floor(workingLp / lpUnit);
      const profits = new Float64Array(capacity + 1);
      const choices = new Int32Array(capacity + 1);
      choices.fill(-1);
      for (let amount = 1; amount <= capacity; amount++) {
        profits[amount] = profits[amount - 1];
        choices[amount] = -2;
        for (let index = 0; index < candidates.length; index++) {
          const cost = Math.floor(candidates[index].lp_cost / lpUnit);
          if (cost <= amount) {
            const value = profits[amount - cost] + candidates[index].minProfit!;
            if (value > profits[amount]) { profits[amount] = value; choices[amount] = index; }
          }
        }
      }
      const counts = new Map<number, number>();
      if (fixedOffer && fixedCount) counts.set(fixedOffer.offer_id, fixedCount);
      let cursor = capacity;
      while (cursor > 0) {
        const selected = choices[cursor];
        if (selected === -2) { cursor--; continue; }
        if (selected < 0) break;
        const offer = candidates[selected];
        counts.set(offer.offer_id, (counts.get(offer.offer_id) || 0) + 1);
        cursor -= Math.floor(offer.lp_cost / lpUnit);
      }
      const lines = candidates.filter(offer => counts.has(offer.offer_id)).map(offer => ({ offer, count: counts.get(offer.offer_id)! })).sort((a, b) => (b.offer.lpRatio ?? -Infinity) - (a.offer.lpRatio ?? -Infinity));
      const usedLp = lines.reduce((sum, line) => sum + line.offer.lp_cost * line.count, 0);
      const totalProfit = lines.reduce((sum, line) => sum + line.offer.minProfit! * line.count, 0);
      const lpRatio = usedLp > 0 ? totalProfit / usedLp : 0;
      setOptimization({ lines, usedLp, remainingLp: lp - usedLp, totalProfit, lpRatio, exact });
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "组合计算失败");
    } finally { setOptimizing(false); }
  }, [calculate, corporationId, lp, showBoosterBlueprints, tax, windowDays]);

  const detailCalculated = useMemo(() => calculate(detailOffers), [calculate, detailOffers]);
  const popularCalculated = useMemo(() => calculate(popularOffers), [calculate, popularOffers]);
  const ratioCalculated = useMemo(() => calculate(highRatioOffers), [calculate, highRatioOffers]);

  const sortedDetails = useMemo(() => sortCalculatedOffers(detailCalculated, { key: sortKey, direction: sortDirection }), [detailCalculated, sortDirection, sortKey]);
  const sortedPopular = useMemo(() => sortCalculatedOffers(popularCalculated, popularSort), [popularCalculated, popularSort]);
  const sortedRatio = useMemo(() => sortCalculatedOffers(ratioCalculated, ratioSort), [ratioCalculated, ratioSort]);

  function toggleSort(key: SortKey) {
    if (corporationId) setPage(1);
    if (sortKey === key) setSortDirection(direction => direction === "desc" ? "asc" : "desc");
    else { setSortKey(key); setSortDirection("desc"); }
  }
  const toggleTableSort = (setter: Dispatch<SetStateAction<TableSort>>, key: SortKey) => setter(current => current.key === key ? { key, direction: current.direction === "desc" ? "asc" : "desc" } : { key, direction: "desc" });
  const sortArrow = (key: SortKey, sort: TableSort) => sort.key === key ? (sort.direction === "desc" ? " ↓" : " ↑") : " ↕";

  const formatNumber = (value: number, digits = 0) => value.toLocaleString(undefined, { maximumFractionDigits: digits });
  const magnitudeHint = (value: number) => {
    const absolute = Math.abs(value);
    const sign = value < 0 ? "−" : "";
    const unit = (divisor: number) => (absolute / divisor).toLocaleString(undefined, { maximumFractionDigits: 2 });
    if (absolute >= 100000000) return `${sign}${unit(100000000)} 亿`;
    if (absolute >= 10000) return `${sign}${unit(10000)} 万`;
    if (absolute >= 1000) return `${sign}${unit(1000)} 千`;
    return `${sign}${unit(1)}`;
  };
  const toggleMaterials = (key: string) => setExpandedOffers(current => {
    const next = new Set(current);
    if (next.has(key)) next.delete(key); else next.add(key);
    return next;
  });

  const rankingTable = (title: string, subtitle: string, rows: CalculatedOffer[], sort: TableSort, onSort: (key: SortKey) => void) => <div className="table">
    <div className="section-head ranking-head"><div><p className="eyebrow">{subtitle}</p><h2>{title}</h2></div></div>
    <div className="table-scroll">
      <div className="mobile-sort" aria-label={`${title}排序`}><span>排序</span><button onClick={() => onSort("lpRatio")}>LP 比例{sortArrow("lpRatio", sort)}</button><button onClick={() => onSort("minProfit")}>最小利润{sortArrow("minProfit", sort)}</button><button onClick={() => onSort("volume")}>日均量{sortArrow("volume", sort)}</button></div>
      <div className="offer-grid thead"><span>物品</span><span>数量</span><button className="sort-button" onClick={() => onSort("lp_cost")}>LP成本{sortArrow("lp_cost", sort)}</button><button className="sort-button" onClick={() => onSort("isk_cost")}>ISK成本{sortArrow("isk_cost", sort)}</button><button className="sort-button" onClick={() => onSort("materialCost")}>材料成本（卖价）{sortArrow("materialCost", sort)}</button><button className="sort-button" onClick={() => onSort("sell_price")}>当前卖单{sortArrow("sell_price", sort)}</button><button className="sort-button" onClick={() => onSort("buy_price")}>当前收单{sortArrow("buy_price", sort)}</button><button className="sort-button" onClick={() => onSort("maxProfit")}>最大利润{sortArrow("maxProfit", sort)}</button><button className="sort-button" onClick={() => onSort("minProfit")}>最小利润{sortArrow("minProfit", sort)}</button><button className="sort-button" onClick={() => onSort("volume")}>日均交易量{sortArrow("volume", sort)}</button><button className="sort-button" onClick={() => onSort("lpRatio")}>LP比例{sortArrow("lpRatio", sort)}</button></div>
      {loading ? <div className="empty-state">正在读取数据库…</div> : rows.length ? rows.map(offer => {
        const key = `${offer.corporation_id}:${offer.offer_id}`;
        const isBest = false;
        const expanded = expandedOffers.has(key);
        const marketTypeId = offer.product_type_id || offer.type_id;
        const marketName = offer.product_name || offer.item_name;
        return <div className="offer-group" key={`${title}:${key}`}>
          <article className="mobile-offer-card">
            <header><div className="mobile-offer-name"><ItemIcon typeId={offer.type_id} name={offer.item_name} /><div><strong>{offer.item_name}</strong><small>{offer.faction_name || "未知势力"} · {offer.corporation_name}</small></div></div><button className="market-order-link" onClick={event => openMarket({ typeId: marketTypeId, name: marketName }, event.currentTarget)}>市场订单</button></header>
            <div className="mobile-key-metrics"><div><small>最小利润</small><strong className={offer.minProfit === null ? "profit-missing" : offer.minProfit >= 0 ? "profit-positive" : "profit-negative"}>{offer.minProfit === null ? "—" : `${formatNumber(offer.minProfit)} ISK`}</strong><em>{offer.minProfit === null ? "暂无收单" : `${magnitudeHint(offer.minProfit)} ISK`}</em></div><div><small>LP 比例</small><strong className="yield">{formatNumber(offer.lpRatio)}<em>ISK/LP</em></strong></div></div>
            <div className="mobile-quick-facts"><span>LP 成本 <b>{formatNumber(offer.lp_cost)}</b></span><span>日均量 <b>{formatNumber(offer.volume, 2)}</b></span><span>可兑换 <b>{offer.affordableRedemptions} 次</b></span></div>
            <details className="mobile-offer-details"><summary>查看全部价格与成本</summary><dl><div><dt>数量</dt><dd>{formatNumber(offer.quantity)}</dd></div><div><dt>ISK 成本</dt><dd>{formatNumber(offer.isk_cost)}</dd></div><div><dt>材料成本（卖价）</dt><dd>{formatNumber(offer.materialCost)}</dd></div><div><dt>当前卖单</dt><dd>{offer.sell_price > 0 ? formatNumber(offer.sell_price) : "—"}</dd></div><div><dt>当前收单</dt><dd>{offer.buy_price > 0 ? formatNumber(offer.buy_price) : "—"}</dd></div><div><dt>最大利润</dt><dd>{offer.maxProfit === null ? "—" : formatNumber(offer.maxProfit)}</dd></div></dl></details>
            <button className="mobile-material-toggle" onClick={() => toggleMaterials(key)} aria-expanded={expanded}>{offer.materials.length ? (expanded ? "收起材料明细" : `查看材料明细（${offer.materials.length}）`) : "无需额外材料"}</button>
          </article>
          <div className={`offer-grid row ${isBest ? "winner" : ""}`}>
            <div className="item"><button className="expand-mark" onClick={() => toggleMaterials(key)} aria-expanded={expanded} aria-label={`${expanded ? "收起" : "展开"}${offer.item_name}材料`}>{offer.materials.length ? (expanded ? "−" : "+") : "·"}</button><ItemIcon typeId={offer.type_id} name={offer.item_name} /><div><strong>{offer.item_name}</strong><small>{offer.faction_name || "未知势力"} · {offer.corporation_name} · 可兑换 {offer.affordableRedemptions} 次{offer.is_blueprint ? ` · 产出 ${offer.product_name || `物品 ${offer.product_type_id}`} × ${offer.revenue_quantity}` : ""}</small><button className="market-order-link" onClick={event => openMarket({ typeId: marketTypeId, name: marketName }, event.currentTarget)}>市场订单</button></div>{isBest && <mark>最佳</mark>}</div>
            <span>{formatNumber(offer.quantity)}</span><span>{formatNumber(offer.lp_cost)}</span><span>{formatNumber(offer.isk_cost)}</span><span>{formatNumber(offer.materialCost)}</span><span>{offer.sell_price > 0 ? formatNumber(offer.sell_price) : "—"}</span><span>{offer.buy_price > 0 ? formatNumber(offer.buy_price) : "—"}</span>
            <strong className={offer.maxProfit === null ? "profit-missing" : offer.maxProfit >= 0 ? "profit-positive" : "profit-negative"}>{offer.maxProfit === null ? "—" : formatNumber(offer.maxProfit)}</strong><strong className={offer.minProfit === null ? "profit-missing" : offer.minProfit >= 0 ? "profit-positive" : "profit-negative"}>{offer.minProfit === null ? "—" : formatNumber(offer.minProfit)}</strong><span>{formatNumber(offer.volume, 2)}</span><strong className="yield">{formatNumber(offer.lpRatio)}<small>ISK/LP</small></strong>
          </div>
          {expanded && <div className="material-panel"><div className="material-head"><span>材料类型</span><span>物品</span><span>数量</span><span>材料单价（卖价）</span><span>成本</span><span>订单</span></div>{offer.calculatedMaterials.length ? offer.calculatedMaterials.map(material => <div className="material-row" key={`${key}:${material.material_kind || "材料"}:${material.type_id}`}><span>{material.material_kind || "兑换材料"}</span><strong className="icon-label"><ItemIcon typeId={material.type_id} name={material.item_name} />{material.item_name}</strong><span>{formatNumber(material.quantity)}</span><span>{formatNumber(material.unitPrice)} ISK</span><span>{formatNumber(material.cost)} ISK</span><button className="market-order-button" onClick={event => openMarket({ typeId: material.type_id, name: material.item_name }, event.currentTarget)}>市场订单</button></div>) : <div className="no-materials">该兑换方案不需要额外材料</div>}</div>}
        </div>;
      }) : <div className="empty-state"><b>暂无符合条件的数据</b><span>请同步基础资料和当前市场订单。</span></div>}
    </div>
  </div>;

  const detailTable = rankingTable("企业兑换详情", `共 ${detailTotal.toLocaleString()} 条 · 当前第 ${page} / ${detailPages} 页`, sortedDetails, { key: sortKey, direction: sortDirection }, toggleSort);
  const boosterBlueprintToggle = <div className={`booster-blueprint-filter${showBoosterBlueprints ? " active" : ""}`}><span>{showBoosterBlueprints ? "当前包含增效剂蓝图" : "已过滤增效剂蓝图"}</span><button type="button" aria-pressed={showBoosterBlueprints} onClick={() => { setShowBoosterBlueprints(value => !value); setPage(1); }}>{showBoosterBlueprints ? "隐藏增效剂蓝图" : "显示增效剂蓝图"}</button></div>;
  const corporationCalculator = <><section className="control-card compact corporation-calculator"><div className="control-title"><span className="step">01</span><div><b>当前企业 LP 组合优化</b><p>使用全部兑换方案计算，不受当前分页影响</p></div></div><label className="amount-label">可用 LP <div className="amount-field"><input type="text" inputMode="numeric" value={formatNumber(lp)} onChange={event => setLp(Math.max(0, Number(event.target.value.replace(/[^0-9]/g, "")) || 0))} /><small>{magnitudeHint(lp)}</small></div><span>LP</span></label><label>需求材料 <strong className="fixed-value">卖单价</strong></label><label>产出物 <strong className="fixed-value">收单价</strong></label><label>交易税 <input type="number" min="0" max="100" value={tax} onChange={event => setTax(Number(event.target.value))} /><span>%</span></label><button className="calculate-button" disabled={optimizing || lp <= 0} onClick={optimizeCorporation}>{optimizing ? "正在计算…" : "计算最优组合"}</button></section>{optimization && <section className="optimization-result"><div className="optimization-summary"><div><small>预计税后总利润</small><strong>{formatNumber(optimization.totalProfit)} ISK</strong><em>{magnitudeHint(optimization.totalProfit)} ISK</em></div><div><small>总体 LP 比例</small><strong>{formatNumber(optimization.lpRatio)} ISK/LP</strong><em>税后净利润 ÷ 已使用 LP</em></div><div><small>已使用 LP</small><b>{formatNumber(optimization.usedLp)}</b><em>{magnitudeHint(optimization.usedLp)} LP</em></div><div><small>剩余 LP</small><b>{formatNumber(optimization.remainingLp)}</b><em>{magnitudeHint(optimization.remainingLp)} LP</em></div><span>{optimization.exact ? "精确组合" : "大额 LP：尾部精确优化"}</span></div><div className="optimization-lines">{optimization.lines.map(line => <div key={line.offer.offer_id}><strong className="icon-label"><ItemIcon typeId={line.offer.type_id} name={line.offer.item_name} />{line.offer.item_name}</strong><b>× {formatNumber(line.count)}</b><span>消耗 {formatNumber(line.offer.lp_cost * line.count)} LP<small>{magnitudeHint(line.offer.lp_cost * line.count)}</small></span><span>利润 {formatNumber(line.offer.minProfit! * line.count)} ISK<small>{magnitudeHint(line.offer.minProfit! * line.count)}</small></span></div>)}</div></section>}</>;
  const implantSetPanel = implantSets.length ? <section className="implant-sets"><div><p className="eyebrow">特殊商品</p><h3>成套脑插市场价值</h3><span>完整 Alpha–Omega 六件套，按六件当前最高收单价合计</span></div>{implantSets.map(set => <div className="implant-set" key={set.name}><div className="implant-set-title"><strong>{set.name}套（6件）</strong></div><div className="implant-levels">{set.items.map((item, index) => <div key={item.level}><i>{index + 1}</i><ItemIcon typeId={item.type_id} name={item.name} /><span>{item.name}</span><b>{item.sell_price > 0 ? `${formatNumber(item.sell_price)} ISK` : "暂无卖单"}</b><em>{formatNumber(item.lp_cost)} LP</em><button className="market-order-link" onClick={event => openMarket({ typeId: item.type_id, name: item.name }, event.currentTarget)}>市场订单</button></div>)}</div><div className="implant-total"><div className="implant-total-ratio"><span>LP 比例</span><strong>{set.lp_ratio === null ? "—" : `${formatNumber(set.lp_ratio)} ISK/LP`}<small>{set.lp_ratio === null ? "价格未齐全" : "按扣除税费和成本后的净利润 ÷ 总 LP"}</small></strong></div><div><span>总价</span><strong>{set.market_value === null ? "价格未齐全" : `${formatNumber(set.market_value)} ISK`}<small>约 {set.market_value === null ? "—" : `${magnitudeHint(set.market_value)} ISK`}</small></strong></div><div className="implant-total-lp"><span>总计 LP</span><strong>{formatNumber(set.total_lp)} LP<small>约 {magnitudeHint(set.total_lp)} LP</small></strong></div></div></div>)}</section> : null;

  return <main>
    <nav className="topbar"><div className="brand"><span className="mark">✦</span><span>LP<span className="accent">/</span>换算器</span><small>晨曦 · 本地数据库</small></div><span className="database-state">{status}</span><a className="nav-action" href="/sync">数据同步 →</a></nav>

    <section className="results"><div className="section-head"><div><p className="eyebrow">{corporationId ? "企业详情" : "数据库榜单"}</p><h2>{corporationId ? "全部兑换方案" : "精选兑换方案"}</h2><p className="sub">{corporationId ? "具体企业使用数据库分页查询" : "仅在全部企业时展示两个前五榜单，不加载全量数据"} · {windowDays} 日历史成交 · 税率 {tax}%</p></div><div className="filters"><input aria-label="搜索物品" placeholder="⌕  搜索当前结果" value={query} onChange={event => setQuery(event.target.value)} /><div className="corporation-picker"><button className="picker-trigger" type="button" aria-expanded={corporationPickerOpen} onClick={() => { const opening = !corporationPickerOpen; setCorporationPickerOpen(opening); if (opening && !pickerFactionId) setPickerFactionId(factionId || corporationGroups[0]?.faction_id || 0); }}><span>{selectedFaction?.name || "全部势力"} <b>/</b> {selectedCorporation?.name || "全部企业"}</span><i>{corporationPickerOpen ? "⌃" : "⌄"}</i></button>{corporationPickerOpen && <div className="picker-menu"><div className="picker-search"><input aria-label="搜索企业" autoFocus placeholder="输入企业中文或英文名" value={corporationSearchInput} onChange={event => setCorporationSearchInput(event.target.value)} onKeyDown={event => { if (event.key === "Enter") applyCorporationSearch(); }} /><button type="button" onClick={applyCorporationSearch}>搜索</button></div><div className="picker-columns"><div className="faction-list"><button className={!factionId && !corporationId ? "selected" : ""} type="button" onClick={() => { setFactionId(0); setCorporationId(0); setCorporationPickerOpen(false); setPage(1); }}>全部势力与企业 <span>›</span></button>{corporationGroups.map(group => <button className={pickerFactionId === group.faction_id ? "active" : ""} type="button" key={group.faction_id} onClick={() => setPickerFactionId(group.faction_id)}><EntityIcon id={group.faction_id} name={group.name} kind="faction" /><b className="entity-name">{group.name}</b><small>{group.corporations.length}</small><span>›</span></button>)}{ungroupedCorporations.length > 0 && <button className={pickerFactionId === 0 ? "active" : ""} type="button" onClick={() => setPickerFactionId(0)}>其他企业<small>{ungroupedCorporations.length}</small><span>›</span></button>}</div><div className="corporation-list">{pickerCorporations.length ? pickerCorporations.map(corporation => <button className={corporationId === corporation.corporation_id ? "selected" : ""} type="button" key={corporation.corporation_id} onClick={() => { setFactionId(corporation.faction_id || 0); setCorporationId(corporation.corporation_id); setCorporationPickerOpen(false); setPage(1); }}><EntityIcon id={corporation.corporation_id} name={corporation.name} kind="corporation" /><b className="entity-name">{corporation.name}</b><small>{corporation.offer_count} 个方案</small></button>) : <p>该分类暂无匹配企业</p>}</div></div></div>}</div>{corporationId > 0 && <select aria-label="每页数量" value={pageSize} onChange={event => { setPageSize(event.target.value); setPage(1); }}><option value="10">每页 10 条</option><option value="20">每页 20 条</option><option value="50">每页 50 条</option><option value="all">全部数据</option></select>}</div></div>
      {corporationId ? <>{corporationCalculator}{implantSetPanel}{boosterBlueprintToggle}{detailTable}{pageSize !== "all" && <div className="pagination"><button disabled={page <= 1} onClick={() => setPage(value => Math.max(1, value - 1))}>上一页</button><span>第 {page} / {detailPages} 页</span><button disabled={page >= detailPages} onClick={() => setPage(value => Math.min(detailPages, value + 1))}>下一页</button></div>}</> : <>{boosterBlueprintToggle}{rankingTable("热门物品前五", "按 30 日内日均交易量", sortedPopular, popularSort, key => toggleTableSort(setPopularSort, key))}{rankingTable("高比率前五", "按最高收单价计算的税后单位 LP 利润", sortedRatio, ratioSort, key => toggleTableSort(setRatioSort, key))}</>}
    </section>
    {marketTarget && <div className="market-modal-backdrop" onMouseDown={event => { if (event.target === event.currentTarget) setMarketTarget(null); }}><section className="market-modal" role="dialog" aria-modal="true" aria-labelledby="market-modal-title"><header><div className="market-modal-title"><ItemIcon typeId={marketTarget.typeId} name={marketTarget.name} size={64} className="item-icon-large" /><div><small>本地数据库 · 当前订单快照</small><h2 id="market-modal-title">{marketTarget.name}</h2><code>TYPE ID {marketTarget.typeId}</code></div></div><button aria-label="关闭" onClick={() => setMarketTarget(null)}>×</button></header>{marketLoading ? <div className="market-modal-loading">正在读取本地数据库…</div> : marketSnapshot?.collected_at ? <><div className="market-order-grid">{(["buy", "sell"] as const).map(side => { const levels = side === "buy" ? marketSnapshot.buy_levels : marketSnapshot.sell_levels; return <div key={side}><small>{side === "buy" ? "当前收单 · 价格从高到低" : "当前卖单 · 价格从低到高"}</small><div className="order-level-head"><span>档位</span><span>价格</span><span>数量</span></div><div className="order-level-list">{levels.length ? levels.map(level => <div key={level.level}><i>{level.level}</i><b>{formatNumber(level.price)} ISK</b><span>{formatNumber(level.volume)} 个</span></div>) : <p>暂无五档数据，请重新同步当前订单</p>}</div></div>; })}</div><details className="market-history"><summary>历史成交（最近 30 日）</summary><div className="market-history-summary"><span>交易天数 <b>{marketSnapshot.history_summary.days}</b></span><span>总成交量 <b>{formatNumber(marketSnapshot.history_summary.total_volume)}</b></span><span>加权均价 <b>{marketSnapshot.history_summary.weighted_average === null ? "—" : `${formatNumber(marketSnapshot.history_summary.weighted_average)} ISK`}</b></span></div>{marketSnapshot.history.length ? <div className="market-history-table"><div><span>日期</span><span>均价</span><span>最高</span><span>最低</span><span>成交量</span></div>{marketSnapshot.history.map(day => <div key={day.trade_date}><span>{day.trade_date}</span><span>{formatNumber(day.average_price)}</span><span>{formatNumber(day.highest_price)}</span><span>{formatNumber(day.lowest_price)}</span><span>{formatNumber(day.volume)}</span></div>)}</div> : <p>暂无历史成交数据</p>}</details><footer><span>采集时间</span><b>{new Date(marketSnapshot.collected_at).toLocaleString("zh-CN")}</b></footer></> : <div className="market-modal-loading">本地数据库暂无该物品的订单快照，请先执行当前订单或关联同步。</div>}</section></div>}
    <footer><span>数据存储于项目本地 SQLite/D1</span><span>同步失败不会清空上一轮数据，可稍后继续。</span></footer>
  </main>;
}
