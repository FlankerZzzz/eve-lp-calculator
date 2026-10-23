"use client";

import { type Dispatch, type ReactNode, type SetStateAction, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { contractPayment } from '../lib/contract-analysis';

type SortKey = "lp_cost" | "isk_cost" | "materialCost" | "sell_price" | "buy_price" | "maxProfit" | "minProfit" | "lpRatio" | "volume";
type SortDirection = "asc" | "desc";
type TableSort = { key: SortKey; direction: SortDirection };
type HistoryWindow = 30 | 15 | 7 | 3 | 1;
type HistoryPrices = Record<HistoryWindow, number>;
type DailyVolumePoint = { trade_date: string; volume: number };

function publishedVolumePoints(points: DailyVolumePoint[]) {
  const lastPublishedIndex = points.findLastIndex(point => point.volume > 0);
  return lastPublishedIndex >= 0 ? points.slice(0, lastPublishedIndex + 1) : [];
}

function chineseTradeDate(value: string) {
  const [year, month, day] = value.split("-").map(Number);
  return year && month && day ? `${year}年${month}月${day}日` : value;
}

type FactionOption = { faction_id: number; name: string };
type CorporationOption = { corporation_id: number; faction_id: number | null; name: string; offer_count: number };
type Counts = { corporations: number; items: number; offers: number; history_rows: number; order_types: number };
type Material = { type_id: number; quantity: number; item_name: string; buy_price: number; sell_price: number; sell_available_volume?: number; material_kind?: string; historical_prices?: HistoryPrices; sell_execution_price?: number; sell_execution_coverage?: number };
type StoredOffer = {
  corporation_id: number; offer_id: number; type_id: number; quantity: number; lp_cost: number; isk_cost: number;
  is_high_sec?: 'Y' | 'N'; is_blocked?: 'Y' | 'N';
  corporation_name: string; faction_id: number | null; faction_name: string | null; item_name: string;
  historical_price: number; historical_prices?: HistoryPrices; daily_volume: number; daily_volumes?: DailyVolumePoint[]; buy_price: number; sell_price: number; buy_execution_price?: number; buy_execution_coverage?: number; materials: Material[];
  is_blueprint: number; product_type_id: number | null; product_name: string | null; revenue_quantity: number;
};
type CalculatedMaterial = Material & { unitPrice: number; cost: number; historyUnitPrice: number; historyCost: number };
type CalculatedOffer = StoredOffer & { materialCost: number; unitPrice: number; netRevenue: number; profit: number; historyProfit: number | null; historyLpRatio: number | null; historyDeviation: number | null; maxProfit: number | null; minProfit: number | null; lpRatio: number; volume: number; materialsCovered: boolean; outputCovered: boolean; outputPrice: number; outputPriceSource: "buy" | "expected" | "sell" | "missing"; calculatedMaterials: CalculatedMaterial[] };
type OptimizationLine = { offer: CalculatedOffer; count: number };
type OptimizationResult = { lines: OptimizationLine[]; usedLp: number; remainingLp: number; totalProfit: number; lpRatio: number; exact: boolean };
type MarketOrderLevel = { side: "buy" | "sell"; level: number; price: number; volume: number; location_name?: string };
type MarketHistoryDay = { trade_date: string; average_price: number; highest_price: number; lowest_price: number; volume: number };
type MarketOrderSnapshot = { type_id: number; item_name: string; buy_price: number | null; sell_price: number | null; buy_volume: number | null; sell_volume: number | null; collected_at: string | null; buy_levels: MarketOrderLevel[]; sell_levels: MarketOrderLevel[]; history: MarketHistoryDay[]; history_summary: { days: number; total_volume: number; weighted_average: number | null } };
type ContractMatch = { contract_id: number; date_issued: string; date_expired: string; price: number; unit_price: number | null; payment_type?: 'ISK' | 'PLEX'; plex_quantity?: number; set_count: number; start_location_id: number; end_location_id: number; location_name?: string; solar_system_id?: number | null };
type ContractState = { loading: boolean; contracts: ContractMatch[]; stale?: boolean; fetchedAt?: string | null; error?: string };
type BlueprintContractMatch = ContractMatch & { copy_count?: number; runs?: number | null; material_efficiency?: number | null; time_efficiency?: number | null; price_per_run?: number | null };
type BlueprintContractState = Omit<ContractState, "contracts"> & { contracts: BlueprintContractMatch[]; status?: string };
type ImplantSet = { name: string; is_blueprint?: boolean; item_count: number; total_lp: number; lp_ratio: number | null; priced_count: number; market_value: number | null; items: { level: string; type_id: number; market_type_id?: number; name: string; lp_cost: number; isk_cost: number; material_cost: number; buy_price: number; expected_price: number; sell_price: number; valuation_price: number; price_source: "buy" | "expected" | "sell" | "missing"; materials?: Material[] }[] };
type ImplantMaterialShortage = { type_id: number; item_name: string; required: number; available: number; missing: number };

function implantMaterialRequirements(set: ImplantSet, setCount: number): ImplantMaterialShortage[] {
  const totals = new Map<number, ImplantMaterialShortage>();
  for (const item of set.items) for (const material of item.materials ?? []) {
    const current = totals.get(material.type_id) ?? { type_id: material.type_id, item_name: material.item_name, required: 0, available: material.sell_available_volume ?? 0, missing: 0 };
    current.required += material.quantity * setCount;
    current.available = Math.max(current.available, material.sell_available_volume ?? 0);
    totals.set(material.type_id, current);
  }
  return [...totals.values()].map(material => ({ ...material, missing: Math.max(0, material.required - material.available) }));
}
const MAX_CALCULATION_LP = 99_990_000;
const APP_VERSION = "V2.1.3";
const LP_STORAGE_KEY = "eve-lp-calculator:lp";
const OPTIMIZATION_STORAGE_KEY = "eve-lp-calculator:optimization";
const FAVORITE_CORPORATIONS_STORAGE_KEY = "eve-lp-calculator:favorite-corporations";

async function copyText(text: string) {
  if (window.isSecureContext && navigator.clipboard?.writeText) {
    try { await navigator.clipboard.writeText(text); return true; } catch { /* use HTTP-compatible fallback */ }
  }
  const field = document.createElement("textarea");
  field.value = text;
  field.setAttribute("readonly", "");
  field.style.position = "fixed";
  field.style.left = "-9999px";
  document.body.appendChild(field);
  field.select();
  const copied = document.execCommand("copy");
  field.remove();
  return copied;
}

function ItemIcon({ typeId, name, size = 32, className = "" }: { typeId: number; name: string; size?: 32 | 64 | 128; className?: string }) {
  // The icon endpoint controls caching and supplies a validated local image response.
  // eslint-disable-next-line @next/next/no-img-element
  return <img className={`item-icon ${className}`.trim()} src={`/api/data/item-icon?type_id=${typeId}&size=${size}`} width={size} height={size} loading="lazy" decoding="async" alt={`${name}图标`} />;
}

const NPC_CORPORATION_FACTION_FALLBACKS = new Map([[1000437, 500010]]);

function EntityIcon({ id, name, kind }: { id: number; name: string; kind: "faction" | "corporation" }) {
  const fallbackFactionId = kind === "corporation" ? NPC_CORPORATION_FACTION_FALLBACKS.get(id) : undefined;
  const factionFallback = fallbackFactionId ? `&fallback_faction_id=${fallbackFactionId}` : "";
  // The icon endpoint controls caching and supplies a validated local image response.
  // eslint-disable-next-line @next/next/no-img-element
  return <img className="entity-icon" src={`/api/data/entity-icon?kind=${kind}&id=${id}&size=64${factionFallback}`} width={32} height={32} loading="lazy" decoding="async" alt={`${name}徽标`} />;
}

function SalesSparkline({ points = [] }: { points?: DailyVolumePoint[] }) {
  const width = 100;
  const baseline = 29;
  const plotHeight = 25;
  const recent = publishedVolumePoints(points).slice(-30);
  const series = [...Array(Math.max(0, 30 - recent.length)).fill(null), ...recent];
  const values = series.map(point => Math.max(0, point?.volume ?? 0));
  const maximum = Math.max(0, ...values);
  const total = values.reduce((sum, value) => sum + value, 0);
  const coordinates = values.map((value, index) => {
    const x = index * width / 29;
    const y = baseline - (maximum > 0 ? Math.sqrt(value / maximum) * plotHeight : 0);
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  }).join(" ");
  const formatDate = (value?: string) => {
    if (!value) return "—";
    const [, month, day] = value.split("-");
    return `${Number(month)}/${Number(day)}`;
  };
  const dateIndexes = [0, 7, 14, 21, 29];
  return <span className="sales-sparkline" aria-label={`最近30个有效历史日销量趋势，合计${total.toLocaleString()}，最高单日${maximum.toLocaleString()}，纵向使用平方根缩放`}><svg viewBox={`0 0 ${width} 32`} preserveAspectRatio="none" role="img"><title>最近30个有效历史日每日销量走势，零值位于基线，纵向使用平方根缩放</title><line className="sales-baseline" x1="0" y1={baseline} x2={width} y2={baseline} /><polyline className="sales-line" points={coordinates} /></svg><span className="sales-date-axis" aria-hidden="true">{dateIndexes.map(index => <i key={index}>{formatDate(series[index]?.trade_date)}</i>)}</span></span>;
}

function SalesTrend({ points = [] }: { points?: DailyVolumePoint[] }) {
  const values = publishedVolumePoints(points).slice(-6).map(point => Math.max(0, point.volume));
  if (values.length < 6) return <span className="sales-trend neutral">3日走势 暂无</span>;
  const previous = values.slice(0, 3).reduce((sum, value) => sum + value, 0) / 3;
  const current = values.slice(3).reduce((sum, value) => sum + value, 0) / 3;
  if (previous === 0 && current === 0) return <span className="sales-trend neutral" title="最近3天日均销量与此前3天均为0">3日走势 持平</span>;
  if (previous === 0) return <span className="sales-trend up" title={`最近3天日均销量 ${current.toLocaleString(undefined, { maximumFractionDigits: 1 })}`}>3日走势 ↑ 新增</span>;
  const change = (current - previous) / previous * 100;
  const direction = change > 0 ? "up" : change < 0 ? "down" : "neutral";
  const symbol = change > 0 ? "↑" : change < 0 ? "↓" : "·";
  return <span className={`sales-trend ${direction}`} title={`最近3天日均 ${current.toLocaleString(undefined, { maximumFractionDigits: 1 })}；此前3天日均 ${previous.toLocaleString(undefined, { maximumFractionDigits: 1 })}`}>3日走势 {symbol} {Math.abs(change).toLocaleString(undefined, { maximumFractionDigits: 1 })}%</span>;
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
  useEffect(() => { if (lp > MAX_CALCULATION_LP) setLp(MAX_CALCULATION_LP); }, [lp]);
  const [tax, setTax] = useState(3);
  const [windowDays] = useState(30);
  const [historyWindow, setHistoryWindow] = useState<HistoryWindow>(30);
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
  const [implantSets, setImplantSets] = useState<ImplantSet[]>([]);
  const [expandedImplantSets, setExpandedImplantSets] = useState<Set<string>>(new Set());
  const [implantContracts, setImplantContracts] = useState<Record<string, ContractState>>({});
  const [expandedImplantContracts, setExpandedImplantContracts] = useState<Set<string>>(new Set());
  const [blueprintContracts, setBlueprintContracts] = useState<Record<number, BlueprintContractState>>({});
  const [expandedBlueprintContracts, setExpandedBlueprintContracts] = useState<Set<string>>(new Set());
  const [expandedImplantItems, setExpandedImplantItems] = useState<Set<string>>(new Set());
  const [expandedImplantExchange, setExpandedImplantExchange] = useState(false);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState("10");
  const [popularPage, setPopularPage] = useState(1);
  const [ratioPage, setRatioPage] = useState(1);
  const [rankingPageSize, setRankingPageSize] = useState("10");
  const [showBoosterBlueprints, setShowBoosterBlueprints] = useState(false);
  const [showUnvaluedOnly, setShowUnvaluedOnly] = useState(false);
  const [showHighSecOnly, setShowHighSecOnly] = useState(false);
  const [loading, setLoading] = useState(true);
  const [status, setStatus] = useState("正在读取本地数据库…");
  const [databaseState, setDatabaseState] = useState<"CHECKING" | "ONLINE" | "OFFLINE">("CHECKING");
  const [sortKey, setSortKey] = useState<SortKey>("lpRatio");
  const [sortDirection, setSortDirection] = useState<SortDirection>("desc");
  const [popularSort, setPopularSort] = useState<TableSort>({ key: "volume", direction: "desc" });
  const [ratioSort, setRatioSort] = useState<TableSort>({ key: "lpRatio", direction: "desc" });
  const [expandedOffers, setExpandedOffers] = useState<Set<string>>(new Set());
  const [optimizing, setOptimizing] = useState(false);
  const [optimization, setOptimization] = useState<OptimizationResult | null>(null);
  const [storageReady, setStorageReady] = useState(false);
  const [marketTarget, setMarketTarget] = useState<{ typeId: number; name: string } | null>(null);
  const [marketSnapshot, setMarketSnapshot] = useState<MarketOrderSnapshot | null>(null);
  const [marketLoading, setMarketLoading] = useState(false);
  const [orderPageSize, setOrderPageSize] = useState<10 | 20 | 50>(10);
  const [buyOrderPage, setBuyOrderPage] = useState(1);
  const [sellOrderPage, setSellOrderPage] = useState(1);
  const marketTriggerRef = useRef<HTMLElement | null>(null);
  const [copyToast, setCopyToast] = useState<string | null>(null);
  const copyToastTimerRef = useRef<number | null>(null);
  const [favoriteCorporationIds, setFavoriteCorporationIds] = useState<number[]>([]);
  const [editingFavorites, setEditingFavorites] = useState(false);
  const corporationPickerRef = useRef<HTMLDivElement | null>(null);
  const blueprintContractControllersRef = useRef(new Map<number, AbortController>());
  const offersRequestRef = useRef(0);
  const optionsRequestRef = useRef<Promise<{ factions: FactionOption[]; corporations: CorporationOption[]; counts: Counts }> | null>(null);
  const loadedBlueprintContractTypesRef = useRef(new Set<number>());
  useEffect(() => {
    try {
      const savedLp = Number(window.localStorage.getItem(LP_STORAGE_KEY));
      if (Number.isFinite(savedLp) && savedLp >= 0) setLp(Math.min(MAX_CALCULATION_LP, savedLp));
      const savedOptimization = window.localStorage.getItem(OPTIMIZATION_STORAGE_KEY);
      if (savedOptimization) setOptimization(JSON.parse(savedOptimization) as OptimizationResult);
      const savedFavorites = JSON.parse(window.localStorage.getItem(FAVORITE_CORPORATIONS_STORAGE_KEY) || "[]") as unknown;
      if (Array.isArray(savedFavorites)) setFavoriteCorporationIds(savedFavorites.filter((value): value is number => Number.isInteger(value) && value > 0));
    } catch { /* 浏览器禁用存储时仍保持页面计算可用 */ }
    setStorageReady(true);
  }, []);
  useEffect(() => {
    if (!storageReady) return;
    try { window.localStorage.setItem(LP_STORAGE_KEY, String(Math.min(MAX_CALCULATION_LP, lp))); } catch { /* ignore */ }
  }, [lp, storageReady]);
  useEffect(() => {
    if (!storageReady) return;
    try {
      if (optimization) window.localStorage.setItem(OPTIMIZATION_STORAGE_KEY, JSON.stringify(optimization));
      else window.localStorage.removeItem(OPTIMIZATION_STORAGE_KEY);
    } catch { /* ignore */ }
  }, [optimization, storageReady]);
  useEffect(() => {
    if (!storageReady) return;
    try { window.localStorage.setItem(FAVORITE_CORPORATIONS_STORAGE_KEY, JSON.stringify(favoriteCorporationIds)); } catch { /* ignore */ }
  }, [favoriteCorporationIds, storageReady]);
  useEffect(() => {
    if (!corporationPickerOpen) return;
    const closeOnOutsideClick = (event: PointerEvent) => {
      if (!corporationPickerRef.current?.contains(event.target as Node)) setCorporationPickerOpen(false);
    };
    document.addEventListener("pointerdown", closeOnOutsideClick);
    return () => document.removeEventListener("pointerdown", closeOnOutsideClick);
  }, [corporationPickerOpen]);

  const openMarket = useCallback((target: { typeId: number; name: string }, trigger: HTMLElement) => {
    marketTriggerRef.current = trigger;
    setMarketTarget(target);
    setBuyOrderPage(1);
    setSellOrderPage(1);
  }, []);
  const closeMarket = useCallback(() => {
    const trigger = marketTriggerRef.current;
    setMarketTarget(null);
    requestAnimationFrame(() => trigger?.focus());
  }, []);
  const showCopyToast = useCallback((message: string) => {
    setCopyToast(message);
    if (copyToastTimerRef.current !== null) window.clearTimeout(copyToastTimerRef.current);
    copyToastTimerRef.current = window.setTimeout(() => setCopyToast(null), 3600);
  }, []);
  const loadBlueprintContracts = useCallback((typeId: number) => {
    if (!Number.isInteger(typeId) || typeId <= 0 || loadedBlueprintContractTypesRef.current.has(typeId) || blueprintContractControllersRef.current.has(typeId)) return;
    const controller = new AbortController();
    blueprintContractControllersRef.current.set(typeId, controller);
    setBlueprintContracts(current => ({ ...current, [typeId]: { loading: true, contracts: [] } }));
    void fetch(`/api/data/contracts?blueprint_type_id=${typeId}&page_size=10`, { cache: "no-store", signal: controller.signal })
      .then(async response => {
        if (!response.ok) throw new Error("公开合同查询失败");
        return response.json() as Promise<{ contracts: BlueprintContractMatch[]; stale: boolean; fetched_at: string | null; status: string; error?: string | null }>;
      })
      .then(data => {
        if (controller.signal.aborted) return;
        if (data.status === "ready") loadedBlueprintContractTypesRef.current.add(typeId);
        setBlueprintContracts(current => ({ ...current, [typeId]: { loading: false, contracts: data.contracts, stale: data.stale, fetchedAt: data.fetched_at, status: data.status, error: data.error || undefined } }));
      })
      .catch(error => {
        if (controller.signal.aborted) return;
        setBlueprintContracts(current => ({ ...current, [typeId]: { loading: false, contracts: [], error: error instanceof Error ? error.message : "公开合同查询失败" } }));
      })
      .finally(() => { blueprintContractControllersRef.current.delete(typeId); });
  }, []);

  const loadOptions = useCallback(() => {
    // Bootstrap and connectivity confirmation share one request, not a polling loop.
    if (!optionsRequestRef.current) {
      optionsRequestRef.current = (async () => {
        const response = await fetch("/api/data/options", { cache: "no-store" });
        if (!response.ok) throw new Error("无法读取数据库选项");
        const data = await response.json() as { factions: FactionOption[]; corporations: CorporationOption[]; counts: Counts };
        if (!Array.isArray(data.factions) || !Array.isArray(data.corporations)) throw new Error("数据库选项格式错误");
        return data;
      })().finally(() => { optionsRequestRef.current = null; });
    }
    return optionsRequestRef.current;
  }, []);

  const loadOffers = useCallback(async (signal?: AbortSignal) => {
    const requestId = ++offersRequestRef.current;
    const isCurrent = () => !signal?.aborted && requestId === offersRequestRef.current;
    if (!isCurrent()) return;
    setLoading(true);
    if (!corporationId) { setPopularOffers([]); setHighRatioOffers([]); }
    try {
      const params = new URLSearchParams({ days: String(windowDays), tax: String(tax), price_mode: "卖价" });
      if (showBoosterBlueprints) params.set("include_booster_blueprints", "1");
      if (!corporationId) params.set("exclude", showHighSecOnly ? "1" : "0");
      if (factionId) params.set("faction_id", String(factionId));
      if (corporationId) {
        params.set("corporation_id", String(corporationId));
        params.set("view", "detail");
        // 企业详情必须先取得完整结果，才能按逐档成交价和价格回退规则
        // 计算全局排序；服务端按原始价格分页会造成每页各自排序。
        params.set("page_size", "all");
      }
      const response = await fetch(`/api/data/offers?${params}`, { cache: "no-store", signal });
      if (!response.ok) throw new Error("无法读取兑换数据");
      if (corporationId) {
        const data = await response.json() as { offers: StoredOffer[]; total: number; pages: number; implant_sets?: ImplantSet[] };
        if (!isCurrent()) return;
        if (!Array.isArray(data.offers) || !Number.isFinite(data.total)) throw new Error("兑换数据格式错误");
        setDetailOffers(data.offers);
        setImplantSets(data.implant_sets || []);
        setStatus(`企业详情：已载入全部 ${data.total.toLocaleString()} 条兑换方案`);
      } else {
        const data = await response.json() as { popular: StoredOffer[]; highRatio: StoredOffer[]; calculatedAt?: string | null };
        if (!isCurrent()) return;
        if (!Array.isArray(data.popular) || !Array.isArray(data.highRatio)) throw new Error("兑换数据格式错误");
        setPopularOffers(data.popular);
        setHighRatioOffers(data.highRatio);
        const uniqueCount = new Set([...data.popular, ...data.highRatio].map(offer => `${offer.corporation_id}:${offer.offer_id}`)).size;
        setStatus(uniqueCount ? `首页已载入 ${uniqueCount} 条${showHighSecOnly ? "高安" : "全部有效方案"}独立榜单 · ${data.calculatedAt ? new Date(data.calculatedAt).toLocaleString("zh-CN") : "等待重算"}` : "尚无对应榜单快照，请到 SYNC 页面手动重算");
      }
      setDatabaseState("ONLINE");
    } catch (error) {
      if (!isCurrent()) return;
      setStatus(error instanceof Error ? error.message : "读取数据库失败");
      setPopularOffers([]);
      setHighRatioOffers([]);
      setDetailOffers([]);
      setImplantSets([]);
      // A failed offers endpoint does not by itself mean the database is offline.
      try {
        await loadOptions();
        if (isCurrent()) setDatabaseState("ONLINE");
      } catch {
        if (isCurrent()) setDatabaseState("OFFLINE");
      }
    } finally { if (isCurrent()) setLoading(false); }
  }, [corporationId, factionId, showBoosterBlueprints, showHighSecOnly, tax, windowDays, loadOptions]);

  useEffect(() => {
    let cancelled = false;
    const requestId = offersRequestRef.current;
    void loadOptions().then(data => {
      if (cancelled) return;
      setFactions(data.factions);
      setCorporations(data.corporations);
      if (requestId === offersRequestRef.current) setDatabaseState("ONLINE");
    }).catch(error => {
      if (cancelled || requestId !== offersRequestRef.current) return;
      setDatabaseState("OFFLINE");
      setStatus(error instanceof Error ? error.message : "读取数据库失败");
    });
    return () => { cancelled = true; };
  }, [loadOptions]);
  useEffect(() => {
    const controller = new AbortController();
    void loadOffers(controller.signal);
    return () => controller.abort();
  }, [loadOffers]);
  useEffect(() => {
    if (!corporationId || !implantSets.length) { setImplantContracts({}); return; }
    let cancelled = false;
    const controller = new AbortController();
    const initial = Object.fromEntries(implantSets.map(set => [`${set.name}:${set.is_blueprint ? "blueprint" : "direct"}`, { loading: true, contracts: [] }]));
    setImplantContracts(initial);
    Promise.all(implantSets.map(async set => {
      const key = `${set.name}:${set.is_blueprint ? "blueprint" : "direct"}`;
      try {
        const typeIds = set.items.map(item => item.market_type_id || item.type_id).join(",");
        const response = await fetch(`/api/data/contracts?type_ids=${typeIds}&page_size=10`, { cache: "no-store", signal: controller.signal });
        const data = await response.json() as { contracts: ContractMatch[]; stale: boolean; fetched_at: string | null; error?: string | null };
        if (!response.ok) throw new Error(data.error || "公开合同查询失败");
        return [key, { loading: false, contracts: data.contracts, stale: data.stale, fetchedAt: data.fetched_at, error: data.error || undefined }] as const;
      } catch (error) { return [key, { loading: false, contracts: [], error: error instanceof Error ? error.message : "公开合同查询失败" }] as const; }
    })).then(results => { if (!cancelled) setImplantContracts(Object.fromEntries(results)); });
    return () => { cancelled = true; controller.abort(); };
  }, [corporationId, implantSets]);
  useEffect(() => {
    for (const controller of blueprintContractControllersRef.current.values()) controller.abort();
    blueprintContractControllersRef.current.clear();
    loadedBlueprintContractTypesRef.current.clear();
    setBlueprintContracts({});
    setExpandedBlueprintContracts(new Set());
  }, [corporationId]);
  useEffect(() => () => {
    for (const controller of blueprintContractControllersRef.current.values()) controller.abort();
    blueprintContractControllersRef.current.clear();
  }, []);
  useEffect(() => { setOptimization(null); }, [corporationId, lp, showBoosterBlueprints, tax, windowDays]);
  useEffect(() => {
    if (!marketTarget) return;
    const controller = new AbortController();
    setMarketLoading(true);
    setMarketSnapshot(null);
    fetch(`/api/data/market-orders?type_id=${marketTarget.typeId}`, { cache: "no-store", signal: controller.signal })
      .then(async response => { if (!response.ok) throw new Error("本地数据库暂无订单数据"); return response.json() as Promise<MarketOrderSnapshot>; })
      .then(snapshot => { if (!controller.signal.aborted) setMarketSnapshot(snapshot); })
      .catch(() => { if (!controller.signal.aborted) setMarketSnapshot(null); })
      .finally(() => { if (!controller.signal.aborted) setMarketLoading(false); });
    return () => controller.abort();
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
  useEffect(() => {
    const nativeAlert = window.alert;
    window.alert = message => showCopyToast(String(message));
    return () => { window.alert = nativeAlert; };
  }, [showCopyToast]);

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
  const favoriteCorporations = useMemo(() => favoriteCorporationIds.map(id => corporations.find(corporation => corporation.corporation_id === id)).filter((corporation): corporation is CorporationOption => Boolean(corporation)), [corporations, favoriteCorporationIds]);
  const selectedCorporationIsFavorite = corporationId > 0 && favoriteCorporationIds.includes(corporationId);
  const openFavoriteCorporation = (corporation: CorporationOption) => {
    if (corporation.corporation_id === corporationId) {
      setFactionId(0);
      setCorporationId(0);
      setCorporationPickerOpen(false);
      setPage(1);
      return;
    }
    setFactionId(corporation.faction_id || 0);
    setCorporationId(corporation.corporation_id);
    setCorporationPickerOpen(false);
    setPage(1);
  };
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

  const calculate = useCallback((source: StoredOffer[]) => source.map(offer => {
    const calculatedMaterials = offer.materials.map(material => {
      const unitPrice = material.sell_execution_price || material.sell_price;
      const historyUnitPrice = material.historical_prices?.[historyWindow] || 0;
      return { ...material, unitPrice, cost: material.quantity * unitPrice, historyUnitPrice, historyCost: material.quantity * historyUnitPrice };
    });
    const materialCost = calculatedMaterials.reduce((sum, material) => sum + material.cost, 0);
    const historyMaterialCost = calculatedMaterials.reduce((sum, material) => sum + material.historyCost, 0);
    const unitPrice = offer.historical_prices?.[historyWindow] || (historyWindow === 30 ? offer.historical_price : 0);
    const revenueQuantity = offer.revenue_quantity || offer.quantity;
    const netRevenue = unitPrice * revenueQuantity * (1 - tax / 100);
    const profit = netRevenue - offer.isk_cost - materialCost;
    const materialsCovered = calculatedMaterials.every(material => material.quantity <= 0 || (material.sell_execution_coverage ?? (material.sell_price > 0 ? 1 : 0)) >= 1);
    const outputCovered = (offer.buy_execution_coverage ?? (offer.buy_price > 0 ? 1 : 0)) >= 1;
    const maxProfit = offer.sell_price > 0 ? offer.sell_price * revenueQuantity * (1 - tax / 100) - offer.isk_cost - materialCost : null;
    const rawBuyPrice = offer.buy_execution_price || offer.buy_price;
    // 当前订单快照存在收单时必须信任真实收单。价格差距很大并不代表
    // 订单错误；旧启发式会把真实低价收单误替换成卖单。
    const hasBuyOrder = rawBuyPrice > 0;
    // 历史价格只用于参考。没有真实收单时，当前可成交价值按 0 处理，
    // 避免历史估值进入 LP 比例、排序或最优组合计算。
    const immediateBuyPrice = hasBuyOrder ? rawBuyPrice : 0;
    const outputPriceSource: CalculatedOffer["outputPriceSource"] = hasBuyOrder ? "buy" : unitPrice > 0 ? "expected" : "missing";
    const minProfit = hasBuyOrder ? immediateBuyPrice * revenueQuantity * (1 - tax / 100) - offer.isk_cost - materialCost : null;
    const lpRatio = hasBuyOrder && offer.lp_cost > 0 && minProfit !== null ? minProfit / offer.lp_cost : 0;
    const historyProfit = unitPrice > 0 && calculatedMaterials.every(material => material.quantity <= 0 || material.historyUnitPrice > 0) ? netRevenue - offer.isk_cost - historyMaterialCost : null;
    const historyLpRatio = offer.lp_cost > 0 && historyProfit !== null ? historyProfit / offer.lp_cost : null;
    const historyDeviation = historyLpRatio !== null && historyLpRatio !== 0 ? (lpRatio - historyLpRatio) / Math.abs(historyLpRatio) * 100 : null;
    return { ...offer, materialCost, unitPrice, netRevenue, profit, historyProfit, historyLpRatio, historyDeviation, maxProfit, minProfit, lpRatio, volume: offer.daily_volume, materialsCovered, outputCovered, outputPrice: immediateBuyPrice, outputPriceSource, calculatedMaterials };
  }), [historyWindow, tax]);

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
      const candidates = calculate(data.offers).filter(offer => offer.lp_cost > 0 && offer.minProfit !== null && offer.minProfit > 0 && offer.materialsCovered && offer.outputCovered);
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
  const latestPublishedTradeDate = useMemo(() => [...detailOffers, ...popularOffers, ...highRatioOffers]
    .flatMap(offer => publishedVolumePoints(offer.daily_volumes ?? []).map(point => point.trade_date))
    .sort()
    .at(-1) ?? "", [detailOffers, highRatioOffers, popularOffers]);

  const sortedDetails = useMemo(() => sortCalculatedOffers(detailCalculated, { key: sortKey, direction: sortDirection }), [detailCalculated, sortDirection, sortKey]);
  const sortedPopular = useMemo(() => sortCalculatedOffers(popularCalculated, popularSort), [popularCalculated, popularSort]);
  const sortedRatio = useMemo(() => sortCalculatedOffers(ratioCalculated, ratioSort), [ratioCalculated, ratioSort]);
  const rankingSize = Number(rankingPageSize);
  const popularPageCount = Math.max(1, Math.ceil(sortedPopular.length / rankingSize));
  const ratioPageCount = Math.max(1, Math.ceil(sortedRatio.length / rankingSize));
  const visiblePopular = useMemo(() => sortedPopular.slice((popularPage - 1) * rankingSize, popularPage * rankingSize), [popularPage, rankingSize, sortedPopular]);
  const visibleRatio = useMemo(() => sortedRatio.slice((ratioPage - 1) * rankingSize, ratioPage * rankingSize), [ratioPage, rankingSize, sortedRatio]);
  const unvaluedDetailCount = useMemo(() => sortedDetails.filter(offer => offer.outputPriceSource !== "buy").length, [sortedDetails]);
  const filteredDetails = useMemo(() => showUnvaluedOnly ? sortedDetails.filter(offer => offer.outputPriceSource !== "buy") : sortedDetails, [showUnvaluedOnly, sortedDetails]);
  const detailPageSize = pageSize === "all" ? Math.max(1, filteredDetails.length) : Number(pageSize);
  const detailPages = Math.max(1, Math.ceil(filteredDetails.length / detailPageSize));
  const safeDetailPage = Math.min(page, detailPages);
  const visibleDetails = useMemo(() => pageSize === "all" ? filteredDetails : filteredDetails.slice((safeDetailPage - 1) * detailPageSize, safeDetailPage * detailPageSize), [detailPageSize, filteredDetails, pageSize, safeDetailPage]);
  useEffect(() => { if (page > detailPages) setPage(detailPages); }, [detailPages, page]);

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
  const ContractPrice = ({ value, unit = "套", currency="ISK" }: { value: number | null; unit?: string; currency?: string }) => <strong className="contract-price">{value===null?"暂无价格":`${formatNumber(value, currency==='PLEX'?2:0)} ${currency}/${unit}`}<small>{value===null?"支付价格待确认":currency==='PLEX'?"纯 PLEX 支付，不折算 ISK":`约 ${magnitudeHint(value)} ISK/${unit}`}</small></strong>;
  const toggleMaterials = (key: string, blueprintTypeId?: number) => {
    const opening = !expandedOffers.has(key);
    setExpandedOffers(current => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key); else next.add(key);
      return next;
    });
    if (opening && blueprintTypeId) loadBlueprintContracts(blueprintTypeId);
  };
  const blueprintContractPanel = (offer: CalculatedOffer, key: string) => {
    const contractState = blueprintContracts[offer.type_id];
    const contractsExpanded = expandedBlueprintContracts.has(key);
    return <>
      <div className="blueprint-material-summary" aria-label="蓝图材料与收益汇总">
        <div><span>总材料成本</span><strong>{formatNumber(offer.materialCost)} ISK</strong><small>约 {magnitudeHint(offer.materialCost)} ISK</small></div>
        <div><span>产出物收单价</span><strong>{offer.outputPrice > 0 ? `${formatNumber(offer.outputPrice)} ISK` : "暂无收单"}</strong><small>{offer.outputPrice > 0 ? `每件约 ${magnitudeHint(offer.outputPrice)} ISK · 本方案产出 ${formatNumber(offer.revenue_quantity || offer.quantity)}` : "合同价不参与利润"}</small></div>
        <div><span>最小利润</span><strong className={offer.minProfit === null ? "profit-missing" : offer.minProfit >= 0 ? "profit-positive" : "profit-negative"}>{offer.minProfit === null ? "—" : `${formatNumber(offer.minProfit)} ISK`}</strong><small>{offer.minProfit === null ? "需有真实收单" : `约 ${magnitudeHint(offer.minProfit)} ISK`}</small></div>
        <div><span>LP 比例</span><strong className="yield">{offer.lpRatio > 0 ? `${formatNumber(offer.lpRatio)} ISK/LP` : "—"}</strong><small>{offer.lpRatio > 0 ? "按当前收单与材料成本" : "合同价不参与利润"}</small></div>
      </div>
      <div className="blueprint-contracts">
        <div className="blueprint-contract-head"><span>蓝图公开合同价格<small>仅作参考，不参与利润计算</small></span><button type="button" className="expand-mark" aria-expanded={contractsExpanded} onClick={() => { loadBlueprintContracts(offer.type_id); setExpandedBlueprintContracts(current => { const next = new Set(current); if (next.has(key)) next.delete(key); else next.add(key); return next; }); }}>{contractsExpanded ? "−" : "+"}</button></div>
        {contractState?.stale && contractState.fetchedAt && <p className="contract-stale-warning">合同缓存已过期，以下为上次成功数据 · {new Date(contractState.fetchedAt).toLocaleString("zh-CN")}</p>}
        {contractState?.loading ? <p>正在查询蓝图公开合同…</p> : contractState?.contracts.length ? <div className="blueprint-contract-list">{contractState.contracts.slice(0, contractsExpanded ? 10 : 1).map(contract => {
          const copyCount = Math.max(1, contract.copy_count ?? contract.set_count ?? 1);
          const totalRuns = contract.runs ? contract.runs * copyCount : null;
          const redemptionQuantity = Math.max(1, offer.quantity);
          const exchangeMaterialCost = offer.calculatedMaterials.filter(material => material.material_kind !== "制造材料").reduce((sum, material) => sum + material.cost, 0);
          const contractReferenceRatio = offer.lp_cost > 0 && contract.unit_price!==null ? (contract.unit_price * redemptionQuantity - offer.isk_cost - exchangeMaterialCost) / offer.lp_cost : null;
          const mailUrl = `<url=contract:${contract.solar_system_id || 30000142}//${contract.contract_id}>${offer.item_name}</url>`;
          return <div key={contract.contract_id}>
            <ContractPrice value={contract.unit_price} unit="张" />
            <span className="blueprint-contract-ratio"><b>{contractReferenceRatio === null ? "—" : formatNumber(contractReferenceRatio)}</b><small>ISK/LP · 合同参考比例</small></span>
            <button type="button" className="contract-copy-link" onClick={async () => { const copied = await copyText(mailUrl); window.alert(copied ? "邮件 URL 已复制，请粘贴至邮件使用" : `自动复制失败，请手动复制：\n${mailUrl}`); }}>{offer.item_name}</button>
            <span>拷贝 {copyCount} 张{totalRuns !== null ? ` · 总计 ${formatNumber(totalRuns)} 流程` : " · 流程待确认"}</span>
            <span className="blueprint-contract-properties">{contract.runs !== null && contract.runs !== undefined ? `每张 ${formatNumber(contract.runs)} 流程` : "每张流程待确认"}{contract.price_per_run && contract.price_per_run > 0 ? ` · 每流程 ${formatNumber(contract.price_per_run)} ISK` : ""}</span>
            <small>{contract.location_name || `空间站 #${contract.start_location_id}`} · 合同 #{contract.contract_id}</small>
          </div>;
        })}</div> : <p>{contractState?.error || (contractState?.status === "pending" ? "合同缓存正在建立，请稍后重试" : "暂无符合条件的公开蓝图合同")}</p>}
      </div>
    </>;
  };
  const historyWindowLabel = historyWindow === 1 ? "最近交易" : `${historyWindow}天`;
  const outputCoverageWarning = (offer: CalculatedOffer) => offer.outputPriceSource === "expected" ? "无收单 · 历史估值仅供参考 · 按 0 计算" : offer.outputPriceSource === "missing" ? "无收单及历史估值 · 按 0 计算" : "收单不足";
  const outputPriceLabel = (offer: CalculatedOffer) => offer.outputPriceSource === "buy" ? "收单价" : "收单价格（按 0）";

  const rankingTable = (title: string, subtitle: string, rows: CalculatedOffer[], sort: TableSort, onSort: (key: SortKey) => void, headerAction?: ReactNode) => <div className="table">
    <div className="section-head ranking-head"><div><p className="eyebrow">{subtitle}</p><h2>{title}</h2>{title === "企业兑换详情" && selectedCorporation && <div className="detail-corporation-block"><div className="detail-corporation-identity"><span>{selectedFaction?.name || "未知势力"}</span><i>·</i><strong>{selectedCorporation.name}</strong></div><div className="detail-corporation-card"><EntityIcon id={selectedCorporation.corporation_id} name={selectedCorporation.name} kind="corporation" /><span><strong>{selectedCorporation.name}</strong><small>{selectedFaction?.name || "未知势力"}</small></span><button type="button" className={selectedCorporationIsFavorite ? "active" : ""} aria-pressed={selectedCorporationIsFavorite} onClick={() => setFavoriteCorporationIds(current => current.includes(selectedCorporation.corporation_id) ? current.filter(id => id !== selectedCorporation.corporation_id) : [...current, selectedCorporation.corporation_id])}>{selectedCorporationIsFavorite ? "取消收藏" : "添加到收藏夹"}</button></div></div>}</div>{headerAction}</div>
    <div className="table-scroll">
      <div className="mobile-sort" aria-label={`${title}排序`}><span>排序</span><button onClick={() => onSort("lpRatio")}>LP 比例{sortArrow("lpRatio", sort)}</button><button onClick={() => onSort("minProfit")}>最小利润{sortArrow("minProfit", sort)}</button><button onClick={() => onSort("volume")}>日均量{sortArrow("volume", sort)}</button></div>
      <div className="offer-grid thead"><span>物品</span><span>数量</span><span>成本</span><span>价格</span><span>利润</span><button className="sort-button" onClick={() => onSort("volume")}>30天日均交易量{sortArrow("volume", sort)}</button><button className="sort-button" onClick={() => onSort("lpRatio")}>比例{sortArrow("lpRatio", sort)}</button></div>
      {loading ? <div className="empty-state">正在读取数据库…</div> : rows.length ? rows.map(offer => {
        const key = `${offer.corporation_id}:${offer.offer_id}`;
        const isBest = false;
        const expanded = expandedOffers.has(key);
        const marketTypeId = offer.product_type_id || offer.type_id;
        const marketName = offer.product_name || offer.item_name;
        const hasOutputRisk = offer.outputPriceSource !== "buy" || !offer.outputCovered || offer.lpRatio === 0;
        const hasCoverageShortage = !offer.materialsCovered || hasOutputRisk;
        return <div className={`offer-group ${hasCoverageShortage ? "coverage-shortage" : ""}`} key={`${title}:${key}`}>
          <article className="mobile-offer-card">
            <header><div className="mobile-offer-name"><ItemIcon typeId={offer.type_id} name={offer.item_name} /><div><strong>{offer.item_name}</strong><small className="offer-affiliation"><span>{offer.faction_name || "未知势力"}</span><span>{offer.corporation_name}</span></small></div></div><button className="market-order-link" onClick={event => openMarket({ typeId: marketTypeId, name: marketName }, event.currentTarget)}>市场订单</button></header>
            <div className="mobile-key-metrics"><div><small>最小利润</small><strong className={offer.minProfit === null ? "profit-missing" : offer.minProfit >= 0 ? "profit-positive" : "profit-negative"}>{offer.minProfit === null ? "—" : `${formatNumber(offer.minProfit)} ISK`}</strong><em>{offer.minProfit === null ? "暂无收单" : `${magnitudeHint(offer.minProfit)} ISK`}</em>{(!offer.materialsCovered || !offer.outputCovered) && <i className="coverage-alert">{!offer.materialsCovered ? "材料不足" : outputCoverageWarning(offer)}</i>}</div><div><small>LP 比例</small><strong className="yield">{formatNumber(offer.lpRatio)}<em>ISK/LP</em></strong>{offer.lpRatio === 0 && <i className="coverage-alert">{offer.lp_cost <= 0 ? "LP 成本为 0 · 比例不可计算" : "无估值 · 请自行评估价值"}</i>}</div></div>
            <div className="history-comparison mobile"><span>{historyWindow === 1 ? "最近交易日" : `${historyWindow} 日`}历史收益</span><b>{offer.historyProfit === null ? "历史价格不完整" : `${formatNumber(offer.historyProfit)} ISK · ${formatNumber(offer.historyLpRatio || 0)} ISK/LP`}</b>{offer.historyDeviation !== null && <i className={offer.historyDeviation >= 0 ? "up" : "down"}>即时收益 {offer.historyDeviation >= 0 ? "高于" : "低于"}（指示价格） {formatNumber(Math.abs(offer.historyDeviation), 1)}%</i>}</div>
            <div className="mobile-quick-facts"><span>LP 成本 <b>{formatNumber(offer.lp_cost)}</b></span><span>30天日均量 <b>{formatNumber(offer.volume, 2)}</b></span></div>
            <details className="mobile-offer-details"><summary>查看全部价格与成本</summary><dl><div><dt>数量</dt><dd>{formatNumber(offer.quantity)}</dd></div><div><dt>ISK 成本</dt><dd>{formatNumber(offer.isk_cost)}</dd></div><div><dt>材料成本（逐档买入）</dt><dd>{formatNumber(offer.materialCost)}</dd></div><div><dt>卖单价</dt><dd>{offer.sell_price > 0 ? formatNumber(offer.sell_price) : "—"}</dd></div><div><dt>{outputPriceLabel(offer)}</dt><dd>{formatNumber(offer.outputPrice)}</dd></div><div><dt>最大利润</dt><dd>{offer.maxProfit === null ? "—" : formatNumber(offer.maxProfit)}</dd></div></dl></details>
            <button className="mobile-material-toggle" onClick={() => toggleMaterials(key, offer.is_blueprint ? offer.type_id : undefined)} aria-expanded={expanded}>{offer.is_blueprint ? (expanded ? "收起蓝图成本与合同" : `查看蓝图成本与合同${offer.materials.length ? `（${offer.materials.length}项材料）` : ""}`) : offer.materials.length ? (expanded ? "收起材料明细" : `查看材料明细（${offer.materials.length}）`) : "无需额外材料"}</button>
          </article>
          <div className={`offer-grid row ${isBest ? "winner" : ""}`}>
            <div className="item"><button className="expand-mark" onClick={() => toggleMaterials(key, offer.is_blueprint ? offer.type_id : undefined)} aria-expanded={expanded} aria-label={`${expanded ? "收起" : "展开"}${offer.item_name}${offer.is_blueprint ? "成本与合同" : "材料"}`}>{offer.materials.length || offer.is_blueprint ? (expanded ? "−" : "+") : "·"}</button><ItemIcon typeId={offer.type_id} name={offer.item_name} /><div><strong>{offer.item_name}</strong><small className="offer-affiliation"><span>{offer.faction_name || "未知势力"}</span><span>{offer.corporation_name}</span></small><button className="market-order-link" onClick={event => openMarket({ typeId: marketTypeId, name: marketName }, event.currentTarget)}>市场订单</button></div>{isBest && <mark>最佳</mark>}</div>
            <span>{formatNumber(offer.revenue_quantity || offer.quantity)}</span>
            <div className="metric-stack cost-stack"><span><small>LP成本</small><b>{formatNumber(offer.lp_cost)}</b></span><span><small>ISK成本</small><b>{formatNumber(offer.isk_cost)}</b></span><span><small>材料成本</small><b>{formatNumber(offer.materialCost)}</b></span></div>
            <div className="metric-stack price-stack"><span><small>卖单价</small><b>{offer.sell_price > 0 ? formatNumber(offer.sell_price) : "—"}</b></span><span className="indicator"><small>指示价格 · {historyWindowLabel}</small><b>{offer.unitPrice > 0 ? formatNumber(offer.unitPrice) : "—"}</b></span><span><small>{outputPriceLabel(offer)}</small><b>{formatNumber(offer.outputPrice)}</b></span></div>
            <div className="metric-stack profit-stack"><span><small>最大利润</small><b className={offer.maxProfit === null ? "profit-missing" : offer.maxProfit >= 0 ? "profit-positive" : "profit-negative"}>{offer.maxProfit === null ? "—" : formatNumber(offer.maxProfit)}</b>{!offer.materialsCovered && <i className="coverage-alert">材料不足</i>}</span><span className="indicator"><small>指示价格利润</small><b className={offer.historyProfit === null ? "profit-missing" : offer.historyProfit >= 0 ? "profit-positive" : "profit-negative"}>{offer.historyProfit === null ? "—" : formatNumber(offer.historyProfit)}</b></span><span><small>最小利润</small><b className={offer.minProfit === null ? "profit-missing" : offer.minProfit >= 0 ? "profit-positive" : "profit-negative"}>{offer.minProfit === null ? "—" : formatNumber(offer.minProfit)}</b>{(!offer.materialsCovered || !offer.outputCovered) && <i className="coverage-alert">{!offer.materialsCovered ? "材料不足" : outputCoverageWarning(offer)}</i>}</span></div>
            <span className="volume-value">{formatNumber(offer.volume, 2)}</span><strong className="yield">{formatNumber(offer.lpRatio)}<small>ISK/LP</small>{offer.lpRatio === 0 && <i className="coverage-alert">{offer.lp_cost <= 0 ? "LP成本为0" : "请自行估值"}</i>}</strong>
          </div>
          <div className="history-comparison"><span>{historyWindow === 1 ? "最近交易日" : `${historyWindow} 日`}历史交易对比</span><b>{offer.historyProfit === null ? "价格不完整" : `${formatNumber(offer.historyProfit)} ISK · ${formatNumber(offer.historyLpRatio || 0)} ISK/LP`}</b>{offer.historyDeviation !== null && <i className={offer.historyDeviation >= 0 ? "up" : "down"}>即时收益 {offer.historyDeviation >= 0 ? "高于" : "低于"}（指示价格） {formatNumber(Math.abs(offer.historyDeviation), 1)}%</i>}<SalesSparkline points={offer.daily_volumes} /><SalesTrend points={offer.daily_volumes} /><small>当前订单覆盖 {formatNumber((offer.buy_execution_coverage ?? 0) * 100, 1)}%</small></div>
          {expanded && <div className="material-panel"><div className="material-head"><span>材料类型</span><span>物品</span><span>数量</span><span>逐档成交均价</span><span>成本</span><span>订单</span></div>{offer.calculatedMaterials.length ? offer.calculatedMaterials.map(material => { const sellCoverage = material.sell_execution_coverage ?? (material.sell_price > 0 ? 1 : 0); return <div className={`material-row ${sellCoverage < 1 ? "order-shortage" : ""}`} key={`${key}:${material.material_kind || "材料"}:${material.type_id}`}><span>{material.material_kind || "兑换材料"}</span><strong className="icon-label"><ItemIcon typeId={material.type_id} name={material.item_name} />{material.item_name}{sellCoverage < 1 && <small className="material-warning">卖单不足 · 请核对实际订单情况，避免无法兑换</small>}</strong><span>{formatNumber(material.quantity)}</span><span>{formatNumber(material.unitPrice)} ISK <small>· 可满足 {formatNumber(sellCoverage * 100, 1)}%</small></span><span>{formatNumber(material.cost)} ISK</span><button className="market-order-button" onClick={event => openMarket({ typeId: material.type_id, name: material.item_name }, event.currentTarget)}>市场订单</button></div>}) : <div className="no-materials">该兑换方案不需要额外材料</div>}{offer.is_blueprint ? blueprintContractPanel(offer, key) : null}</div>}
        </div>;
      }) : <div className="empty-state"><b>暂无符合条件的数据</b><span>请同步基础资料和当前市场订单。</span></div>}
    </div>
  </div>;

  const unvaluedFilter = <div className={`unvalued-filter${showUnvaluedOnly ? " active" : ""}`}><span>请自行评估价值</span><button type="button" aria-pressed={showUnvaluedOnly} onClick={() => { setShowUnvaluedOnly(value => !value); setPage(1); }}>无估值或异常估值（{unvaluedDetailCount}）</button><select aria-label="企业兑换详情每页数量" value={pageSize} onChange={event => { setPageSize(event.target.value); setPage(1); }}><option value="10">每页 10 条</option><option value="20">每页 20 条</option><option value="50">每页 50 条</option><option value="all">全部数据</option></select></div>;
  const rankingPager = (label: string, currentPage: number, pageCount: number, setCurrentPage: Dispatch<SetStateAction<number>>) => <div className="ranking-pagination"><span>{label} · 第 {currentPage} / {pageCount} 页</span><select aria-label={`${label}每页数量`} value={rankingPageSize} onChange={event => { setRankingPageSize(event.target.value); setPopularPage(1); setRatioPage(1); }}><option value="10">每页 10 条</option><option value="20">每页 20 条</option><option value="50">每页 50 条</option><option value="100">每页 100 条</option></select><button type="button" disabled={currentPage <= 1} onClick={() => setCurrentPage(value => Math.max(1, value - 1))}>上一页</button><button type="button" disabled={currentPage >= pageCount} onClick={() => setCurrentPage(value => Math.min(pageCount, value + 1))}>下一页</button></div>;
  const boosterBlueprintToggle = <div className={`booster-blueprint-filter${showBoosterBlueprints ? " active" : ""}`}><span>{showBoosterBlueprints ? "当前包含增效剂蓝图" : "已过滤增效剂蓝图"}</span><button type="button" aria-pressed={showBoosterBlueprints} onClick={() => { setShowBoosterBlueprints(value => !value); setPage(1); setPopularPage(1); setRatioPage(1); }}>{showBoosterBlueprints ? "隐藏增效剂蓝图" : "显示增效剂蓝图"}</button></div>;
  const detailTable = rankingTable("企业兑换详情", `${showUnvaluedOnly ? "无估值或异常估值" : `共 ${sortedDetails.length.toLocaleString()} 条`} · 当前第 ${safeDetailPage} / ${detailPages} 页`, visibleDetails, { key: sortKey, direction: sortDirection }, toggleSort, <div className="detail-header-actions">{boosterBlueprintToggle}{unvaluedFilter}</div>);
  const historySelector = <div className="history-selector" aria-label="历史价格对比周期"><span>历史价对比</span>{([30, 15, 7, 1] as HistoryWindow[]).map(value => { const recentDateHint = value === 1 ? (latestPublishedTradeDate ? `最近交易日：${chineseTradeDate(latestPublishedTradeDate)}` : "最近交易日：等待历史数据") : undefined; return <button type="button" className={historyWindow === value ? "active" : ""} aria-pressed={historyWindow === value} aria-label={recentDateHint} title={recentDateHint} key={value} onClick={() => setHistoryWindow(value)}>{value === 1 ? "最近交易日" : `${value} 日`}</button>})}</div>;
  const marketOrderColumn = (side: "buy" | "sell") => {
    const levels = side === "buy" ? marketSnapshot?.buy_levels ?? [] : marketSnapshot?.sell_levels ?? [];
    const currentPage = side === "buy" ? buyOrderPage : sellOrderPage;
    const setCurrentPage = side === "buy" ? setBuyOrderPage : setSellOrderPage;
    const pageCount = Math.max(1, Math.ceil(levels.length / orderPageSize));
    const safePage = Math.min(currentPage, pageCount);
    const visibleLevels = levels.slice((safePage - 1) * orderPageSize, safePage * orderPageSize);
    return <div key={side}><small>{side === "buy" ? "当前收单 · 价格从高到低" : "当前卖单 · 价格从低到高"}</small><div className="order-level-head"><span>档位</span><span>价格</span><span>数量</span><span>空间站</span></div><div className="order-level-list">{visibleLevels.length ? visibleLevels.map(level => <div key={`${level.level}-${level.location_name}`}><i>{level.level}</i><b>{formatNumber(level.price)} ISK</b><span>{formatNumber(level.volume)} 个</span><small>{level.location_name || "未知地点"}</small></div>) : <p>暂无订单数据，请重新同步当前订单</p>}</div><div className="order-pagination"><span>共 {levels.length} 档 · 第 {safePage}/{pageCount} 页</span><button type="button" disabled={safePage <= 1} onClick={() => setCurrentPage(value => Math.max(1, value - 1))}>上一页</button><button type="button" disabled={safePage >= pageCount} onClick={() => setCurrentPage(value => Math.min(pageCount, value + 1))}>下一页</button></div></div>;
  };
  const corporationCalculator = <><section className="control-card compact corporation-calculator"><div className="control-title"><span className="step">01</span><div><b>LP计算器</b><p>使用全部兑换方案计算，不受当前分页影响</p></div></div><label className="amount-label">可用 LP <div className="amount-field"><input type="text" inputMode="numeric" value={formatNumber(lp)} onChange={event => setLp(Math.max(0, Number(event.target.value.replace(/[^0-9]/g, "")) || 0))} /><small>{magnitudeHint(lp)}</small></div><span>LP</span></label><label>需求材料 <strong className="fixed-value">卖单价</strong></label><label>产出物 <strong className="fixed-value">收单价</strong></label><label>交易税 <input type="number" min="0" max="100" value={tax} onChange={event => setTax(Number(event.target.value))} /><span>%</span></label><button className="calculate-button" disabled={optimizing || lp <= 0} onClick={optimizeCorporation}>{optimizing ? "正在计算…" : "计算最优组合"}</button></section>{optimization && <section className="optimization-result"><div className="optimization-summary"><div><small>预计税后总利润</small><strong>{formatNumber(optimization.totalProfit)} ISK</strong><em>{magnitudeHint(optimization.totalProfit)} ISK</em></div><div><small>总体 LP 比例</small><strong>{formatNumber(optimization.lpRatio)} ISK/LP</strong><em>税后净利润 ÷ 已使用 LP</em></div><div><small>已使用 LP</small><b>{formatNumber(optimization.usedLp)}</b><em>{magnitudeHint(optimization.usedLp)} LP</em></div><div><small>剩余 LP</small><b>{formatNumber(optimization.remainingLp)}</b><em>{magnitudeHint(optimization.remainingLp)} LP</em></div><span>{optimization.exact ? "精确组合" : "大额 LP：尾部精确优化"}</span></div><div className="optimization-lines">{optimization.lines.map(line => <div key={line.offer.offer_id}><strong className="icon-label"><ItemIcon typeId={line.offer.type_id} name={line.offer.item_name} />{line.offer.item_name}</strong><b>× {formatNumber(line.count)}</b><span>消耗 {formatNumber(line.offer.lp_cost * line.count)} LP<small>{magnitudeHint(line.offer.lp_cost * line.count)}</small></span><span>利润 {formatNumber(line.offer.minProfit! * line.count)} ISK<small>{magnitudeHint(line.offer.minProfit! * line.count)}</small></span></div>)}</div></section>}</>;
  const implantExchangeRows = implantSets.map(set => ({ set, count: set.total_lp > 0 ? Math.floor(lp / set.total_lp) : 0 })).filter(({ count }) => count > 0);

  const lpOnlyImplantExchangePanel = implantExchangeRows.length ? <section className="implant-exchange-panel">
    <button type="button" className="implant-set-title" aria-expanded={expandedImplantExchange} onClick={() => setExpandedImplantExchange(value => !value)}>
      <span className="expand-mark">{expandedImplantExchange ? "−" : "+"}</span>
      <span><p className="eyebrow">当前 LP 整套兑换估算</p><h3>我能兑换几套脑插</h3></span>
    </button>
    {expandedImplantExchange && <div className="implant-exchange-list">{implantExchangeRows.map(({ set, count }) => {
      const usedLp = set.total_lp * count;
      const value = set.market_value === null ? null : set.market_value * count;
      const materials = implantMaterialRequirements(set, count);
      const shortages = materials.filter(material => material.missing > 0);
      return <div className={`implant-exchange-card${shortages.length ? " material-shortage" : ""}`} key={`${set.name}:${set.is_blueprint ? "blueprint" : "direct"}`}>
        <div className="implant-exchange-title"><strong>可兑换 {formatNumber(count)} 套{set.name}套</strong><span>每套 {formatNumber(set.total_lp)} LP</span><i className="coverage-alert exchange-lp-only">仅按 LP 粗略计算，材料未参与套数限制</i>{shortages.length > 0 && <i className="coverage-alert exchange-material-check">材料可能不足，请检查材料</i>}</div>
        <div className="implant-exchange-metrics"><div><small>套装总价值</small><b>{value === null ? "价格未齐全" : `${formatNumber(value)} ISK`}</b><em>{value === null ? "部分脑插缺少市场价格" : `约 ${magnitudeHint(value)} ISK`}</em></div><div><small>整套 LP 比例</small><b>{set.lp_ratio === null ? "—" : `${formatNumber(set.lp_ratio)} ISK/LP`}</b><em>{set.lp_ratio === null ? "价格或材料成本不完整" : "按扣除税费和成本后的净利润计算"}</em></div><div><small>剩余 LP</small><b>{formatNumber(lp - usedLp)} LP</b><em>已使用 {formatNumber(usedLp)} LP</em></div></div>
      </div>;
    })}</div>}
  </section> : null;

  const riskAwareImplantSetPanel = implantSets.length ? <section className="implant-sets">
    <div><p className="eyebrow">特殊商品</p><h3>六件套脑插市场价</h3><span>LP 比例优先按当前收单计算，不考虑收单数量；缺少收单时回落 30 天历史价</span></div>
    {implantSets.map(set => {
      const setKey = `${set.name}:${set.is_blueprint ? "blueprint" : "direct"}`;
      const expanded = expandedImplantSets.has(setKey);
      const contractState = implantContracts[setKey];
      const contractsExpanded = expandedImplantContracts.has(setKey);
      const setMaterialShortages = implantMaterialRequirements(set, 1).filter(material => material.missing > 0);
      const setRedemptionCost = set.items.reduce((sum, item) => sum + item.isk_cost + item.material_cost, 0);
      const missingPriceItems = set.items.filter(item => item.price_source === "missing");
      const sellPricedCount = set.items.filter(item => item.sell_price > 0).length;
      const buyPricedCount = set.items.filter(item => item.buy_price > 0).length;
      const sellPricesComplete = sellPricedCount === set.item_count;
      const buyPricesComplete = buyPricedCount === set.item_count;
      const setBuyTotal = set.items.reduce((sum, item) => sum + (item.buy_price || 0), 0);
      const setSellTotal = set.items.reduce((sum, item) => sum + (item.sell_price || 0), 0);
      return <div className={`implant-set${setMaterialShortages.length ? " material-shortage" : ""}${missingPriceItems.length ? " price-shortage" : ""}`} key={setKey}>
        <div className="implant-set-title"><button type="button" className="expand-mark implant-set-toggle" aria-expanded={expanded} onClick={() => setExpandedImplantSets(value => { const next = new Set(value); if (next.has(setKey)) next.delete(setKey); else next.add(setKey); return next; })}>{expanded ? "−" : "+"}</button><strong>{set.name}套{set.is_blueprint ? "(蓝图)" : ""}（6件）</strong>{setMaterialShortages.length > 0 && <i className="coverage-alert">检查材料</i>}{missingPriceItems.length > 0 && <i className="coverage-alert">收单完整度 {set.priced_count}/{set.item_count}</i>}</div>
        {expanded && <>
          <div className="implant-levels">{set.items.map((item, index) => {
            const itemKey = `${setKey}:${item.level}`;
            const itemExpanded = expandedImplantItems.has(itemKey);
            const materialShortages = (item.materials ?? []).filter(material => (material.sell_available_volume ?? 0) < material.quantity);
            const itemRisk = materialShortages.length > 0 || item.price_source !== "buy";
            const priceHint = item.price_source === "expected" ? "无收单 · 采用历史估值" : item.price_source === "missing" ? "无收单及历史成交 · 不参与 LP 比例" : "";
            return <div className={itemRisk ? "implant-item-risk" : ""} key={item.level}><i>{index + 1}</i><ItemIcon typeId={item.type_id} name={item.name} /><span>{item.name}{materialShortages.length > 0 && <small className="material-warning">材料不足</small>}{priceHint && <small className="material-warning">{priceHint}</small>}</span><b>{item.valuation_price > 0 ? `${formatNumber(item.valuation_price)} ISK` : "无可靠价格"}</b><em>{formatNumber(item.lp_cost)} LP</em><button className="market-order-link" onClick={event => openMarket({ typeId: item.market_type_id || item.type_id, name: item.name }, event.currentTarget)}>市场订单</button><button type="button" className="market-order-link material-toggle" aria-expanded={itemExpanded} onClick={() => setExpandedImplantItems(value => { const next = new Set(value); if (next.has(itemKey)) next.delete(itemKey); else next.add(itemKey); return next; })}>材料</button>{itemExpanded && <div className="implant-item-materials">{item.materials?.length ? item.materials.map(material => { const available = material.sell_available_volume ?? 0; const missing = Math.max(0, material.quantity - available); return <span className={missing > 0 ? "material-missing" : ""} key={material.type_id}>{material.item_name}：需要 {formatNumber(material.quantity)}，现有卖单 {formatNumber(available)}{missing > 0 ? `，缺少 ${formatNumber(missing)}` : "，充足"}</span>; }) : <span>该脑插不需要额外材料</span>}</div>}</div>;
          })}</div>
          <div className="implant-total"><div><span>套装市场卖价</span><strong>{sellPricesComplete ? `${formatNumber(setSellTotal)} ISK` : `数据不完整（${sellPricedCount}/${set.item_count}）`}<small>{sellPricesComplete ? `约 ${magnitudeHint(setSellTotal)} ISK` : `缺少 ${set.item_count - sellPricedCount} 件卖单，未合计`}</small></strong></div><div><span>套装市场收单价</span><strong>{buyPricesComplete ? `${formatNumber(setBuyTotal)} ISK` : `数据不完整（${buyPricedCount}/${set.item_count}）`}<small>{buyPricesComplete ? `约 ${magnitudeHint(setBuyTotal)} ISK · LP 比例优先采用此价` : `缺少 ${set.item_count - buyPricedCount} 件收单，缺少时回落历史价`}</small></strong></div><div className="implant-total-lp"><span>总计 LP</span><strong>{formatNumber(set.total_lp)} LP<small>约 {magnitudeHint(set.total_lp)} LP</small></strong></div><div className="implant-total-ratio"><span>LP 比例</span><strong>{set.lp_ratio === null ? "—" : `${formatNumber(set.lp_ratio)} ISK/LP`}<small>{set.lp_ratio === null ? `收单和历史价均不完整（${set.priced_count}/${set.item_count}）` : "按收单价，缺少时回落历史估值，扣除税费和成本"}</small></strong></div></div>
          <div className="implant-contracts"><div className="implant-contract-head"><span>公开合同价格</span><button type="button" className="expand-mark implant-set-toggle" aria-expanded={contractsExpanded} onClick={() => setExpandedImplantContracts(value => { const next = new Set(value); if (next.has(setKey)) next.delete(setKey); else next.add(setKey); return next; })}>{contractsExpanded ? "−" : "+"}</button></div>{contractState?.stale && <p className="contract-stale-warning">合同缓存已过期，以下为上次成功数据{contractState.fetchedAt ? ` · ${new Date(contractState.fetchedAt).toLocaleString("zh-CN")}` : ""}</p>}{contractState?.loading ? <p>正在查询公开合同…</p> : contractState?.contracts.length ? <div className="implant-contract-list">{contractState.contracts.slice(0, contractsExpanded ? 10 : 1).map(contract => {
            const payment=contractPayment(contract);
            const contractReferenceRatio = payment.currency==='ISK'&&payment.value!==null&&set.total_lp>0 ? (payment.value-setRedemptionCost)/set.total_lp : null;
            const mailUrl = `<url=contract:${contract.solar_system_id || 30000142}//${contract.contract_id}>${set.name}套</url>`;
            return <div key={contract.contract_id}><ContractPrice value={payment.value} currency={payment.currency}/><span className="implant-contract-ratio"><b>{contractReferenceRatio===null?"—":formatNumber(contractReferenceRatio)}</b><small>{payment.currency==='PLEX'?"PLEX 支付 · 不计算 ISK/LP":"ISK/LP · 合同参考比例"}</small></span><button type="button" className="contract-copy-link" onClick={async()=>{const copied=await copyText(mailUrl);window.alert(copied?"邮件 URL 已复制，请粘贴至邮件使用":`自动复制失败，请手动复制：\n${mailUrl}`);}}>{set.name}套</button><span>{contract.set_count>1?`×${contract.set_count}套 / 每套 ${payment.value===null?'待确认':formatNumber(payment.value,2)} ${payment.currency}`:"六件套"}</span><small>{contract.location_name||`空间站 #${contract.start_location_id}`} · 合同 #{contract.contract_id}</small></div>;
          })}</div>:<p>{contractState?.error||"暂无符合条件的公开六件套合同"}</p>}</div>
        </>}
      </div>;
    })}
  </section> : null;

  return <main className="home-page">
    {copyToast && <div className="copy-toast" role="status" aria-live="polite"><span className="copy-toast-mark">✓</span><span>{copyToast}</span><button type="button" aria-label="关闭提示" onClick={() => setCopyToast(null)}>×</button></div>}
    <nav className="topbar"><div className="brand"><span className="mark">✦</span><span>LP<span className="accent">/</span>换算器</span><small>数据源：晨曦</small></div><span className="database-state">{status}</span><a className="nav-action" href="/sync">数据同步 →</a></nav>

    <section className="command-hero">
      <div className="command-copy">
        <div className="hero-kicker"><span>NEW EDEN MARKET INTELLIGENCE</span><i>SECURE CHANNEL 7</i></div>
        <h1><span>忠诚点</span><em>战术收益终端</em></h1>
        <p>一个纯净的忠诚点收益计算器</p>
        <div className="hero-tags"><span>EVE DATA CORE</span><span>QUANTUM LINK</span><span>STARFLEET LCARS</span></div>
      </div>
      <div className="orbital-display" aria-hidden="true">
        <div className="orbit orbit-one" />
        <div className="orbit orbit-two" />
        <div className="orbit orbit-three" />
        <div className="nav-reticle"><span>ISK</span><b>/</b><span>LP</span><small>YIELD VECTOR</small></div>
        <i className="contact contact-a" /><i className="contact contact-b" /><i className="contact contact-c" />
        <div className="orbit-caption caption-a">JITA // 4-4</div><div className="orbit-caption caption-b">VECTOR 03.71</div>
      </div>
    </section>

    <section className="telemetry-strip" aria-label="终端状态">
      <div className={`database-telemetry ${databaseState.toLowerCase()}`}><span>DATA LINK</span><b>DATABASE</b><i>{databaseState}</i></div>
      <div><span>MARKET WINDOW</span><b>{windowDays} DAYS</b><i>ROLLING</i></div>
      <div><span>TAX PROFILE</span><b>{tax.toFixed(1)}%</b><i>ACTIVE</i></div>
      <div><span>NAV STATUS</span><b>{loading ? "SCANNING" : "ONLINE"}</b><i>{loading ? "ACQUIRING" : "NOMINAL"}</i></div>
    </section>
    <section className={`corporation-favorites${editingFavorites ? " editing" : ""}`} aria-label="军团收藏夹">
      <div className="favorite-heading"><div><span>收藏夹</span><small>常用军团快捷入口</small></div><button type="button" onClick={() => setEditingFavorites(value => !value)}>{editingFavorites ? "完成编辑" : "编辑收藏夹"}</button></div>
      <div className="favorite-cards">{favoriteCorporations.length ? favoriteCorporations.map(corporation => <div className={corporation.corporation_id === corporationId ? "active" : ""} key={corporation.corporation_id}><button type="button" className="favorite-corporation" onClick={() => openFavoriteCorporation(corporation)}><EntityIcon id={corporation.corporation_id} name={corporation.name} kind="corporation" /><span><strong>{corporation.name}</strong><small>{factions.find(faction => faction.faction_id === corporation.faction_id)?.name || "未知势力"}</small></span></button>{editingFavorites && <button type="button" className="favorite-remove" aria-label={`从收藏夹删除${corporation.name}`} onClick={() => setFavoriteCorporationIds(current => current.filter(id => id !== corporation.corporation_id))}>×</button>}</div>) : <p>暂无收藏军团，可在企业兑换详情中添加</p>}</div>
    </section>
    <div className="history-toolbar"><span>市场基准价</span>{historySelector}<small>即时收益按订单深度成交；历史收益按所选周期成交均价估算</small></div>

    <section className="results"><div className="section-head"><div>{corporationId > 0 && <p className="eyebrow">企业详情</p>}<h2>{corporationId ? "全部兑换方案" : "精选兑换方案"}</h2><p className="sub">{corporationId ? "具体企业使用数据库分页查询 · " : ""}基于伏尔戈市场 {windowDays} 天历史交易数据</p></div><div className="filters">{corporationId === 0 && <button type="button" className={`high-sec-filter${showHighSecOnly ? " active" : ""}`} aria-pressed={showHighSecOnly} onClick={() => { setShowHighSecOnly(current => !current); setPopularPage(1); setRatioPage(1); }}>{showHighSecOnly ? "已仅展示高安势力" : "仅展示高安势力"}</button>}<div className="corporation-picker" ref={corporationPickerRef}><button className="picker-trigger" type="button" aria-expanded={corporationPickerOpen} onClick={() => { const opening = !corporationPickerOpen; setCorporationPickerOpen(opening); if (opening && !pickerFactionId) setPickerFactionId(factionId || corporationGroups[0]?.faction_id || 0); }}><span>{selectedFaction?.name || "全部势力"} <b>/</b> {selectedCorporation?.name || "全部企业"}</span><i>{corporationPickerOpen ? "⌃" : "⌄"}</i></button>{corporationPickerOpen && <div className="picker-menu"><div className="picker-search"><input aria-label="搜索企业" autoFocus placeholder="输入企业中文或英文名" value={corporationSearchInput} onChange={event => setCorporationSearchInput(event.target.value)} onKeyDown={event => { if (event.key === "Enter") applyCorporationSearch(); }} /><button type="button" onClick={applyCorporationSearch}>搜索</button></div><div className="picker-columns"><div className="faction-list"><button className={!factionId && !corporationId ? "selected" : ""} type="button" onClick={() => { setFactionId(0); setCorporationId(0); setCorporationPickerOpen(false); setPage(1); }}>全部势力与企业 <span>›</span></button>{corporationGroups.map(group => <button className={pickerFactionId === group.faction_id ? "active" : ""} type="button" key={group.faction_id} onClick={() => setPickerFactionId(group.faction_id)}><EntityIcon id={group.faction_id} name={group.name} kind="faction" /><b className="entity-name">{group.name}</b><small>{group.corporations.length}</small><span>›</span></button>)}{ungroupedCorporations.length > 0 && <button className={pickerFactionId === 0 ? "active" : ""} type="button" onClick={() => setPickerFactionId(0)}>其他企业<small>{ungroupedCorporations.length}</small><span>›</span></button>}</div><div className="corporation-list">{pickerCorporations.length ? pickerCorporations.map(corporation => <button className={corporationId === corporation.corporation_id ? "selected" : ""} type="button" key={corporation.corporation_id} onClick={() => { setFactionId(corporation.faction_id || 0); setCorporationId(corporation.corporation_id); setCorporationPickerOpen(false); setPage(1); }}><EntityIcon id={corporation.corporation_id} name={corporation.name} kind="corporation" /><b className="entity-name">{corporation.name}</b><small>{corporation.offer_count} 个方案</small></button>) : <p>该分类暂无匹配企业</p>}</div></div></div>}</div>{corporationId > 0 && <select aria-label="每页数量" value={pageSize} onChange={event => { setPageSize(event.target.value); setPage(1); }}><option value="10">每页 10 条</option><option value="20">每页 20 条</option><option value="50">每页 50 条</option><option value="all">全部数据</option></select>}</div></div>
      {corporationId ? <>{corporationCalculator}{lpOnlyImplantExchangePanel}{riskAwareImplantSetPanel}{boosterBlueprintToggle}{detailTable}{pageSize !== "all" && <div className="pagination"><button disabled={safeDetailPage <= 1} onClick={() => setPage(value => Math.max(1, value - 1))}>上一页</button><span>第 {safeDetailPage} / {detailPages} 页</span><button disabled={safeDetailPage >= detailPages} onClick={() => setPage(value => Math.min(detailPages, value + 1))}>下一页</button></div>}</> : <>{boosterBlueprintToggle}{rankingTable("热销榜", "前 100 条 · 按 30 日内日均交易量", visiblePopular, popularSort, key => toggleTableSort(setPopularSort, key))}{rankingPager("热销榜", popularPage, popularPageCount, setPopularPage)}{rankingTable("价值榜", "前 100 条 · 按最高收单价计算的税后单位 LP 利润", visibleRatio, ratioSort, key => toggleTableSort(setRatioSort, key))}{rankingPager("价值榜", ratioPage, ratioPageCount, setRatioPage)}</>}
    </section>
    {marketTarget && <div className="market-modal-backdrop" onMouseDown={event => { if (event.target === event.currentTarget) closeMarket(); }}>
      <section className="market-modal" role="dialog" aria-modal="true" aria-labelledby="market-modal-title">
        <header><div className="market-modal-title"><ItemIcon typeId={marketTarget.typeId} name={marketTarget.name} size={64} className="item-icon-large" /><div><small>本地数据库 · 当前订单快照</small><h2 id="market-modal-title">{marketTarget.name}</h2><code>TYPE ID {marketTarget.typeId}</code></div></div><button aria-label="关闭" onClick={closeMarket}>×</button></header>
        {marketLoading ? <div className="market-modal-loading">正在读取本地数据库…</div> : marketSnapshot?.collected_at ? <>
          <div className="order-page-size"><span>每页显示</span>{([10, 20, 50] as const).map(size => <button type="button" className={orderPageSize === size ? "active" : ""} key={size} onClick={() => { setOrderPageSize(size); setBuyOrderPage(1); setSellOrderPage(1); }}>{size}</button>)}</div>
          <div className="market-order-grid">{(["sell", "buy"] as const).map(marketOrderColumn)}</div>
          <details className="market-history"><summary>历史成交（最近 30 日）</summary><div className="market-history-summary"><span>交易天数 <b>{marketSnapshot.history_summary.days}</b></span><span>总成交量 <b>{formatNumber(marketSnapshot.history_summary.total_volume)}</b></span><span>加权均价 <b>{marketSnapshot.history_summary.weighted_average === null ? "—" : `${formatNumber(marketSnapshot.history_summary.weighted_average)} ISK`}</b></span></div>{marketSnapshot.history.length ? <div className="market-history-table"><div><span>日期</span><span>均价</span><span>最高</span><span>最低</span><span>成交量</span></div>{marketSnapshot.history.map(day => <div key={day.trade_date}><span>{day.trade_date}</span><span>{formatNumber(day.average_price)}</span><span>{formatNumber(day.highest_price)}</span><span>{formatNumber(day.lowest_price)}</span><span>{formatNumber(day.volume)}</span></div>)}</div> : <p>暂无历史成交数据</p>}</details>
          <footer><span>采集时间</span><b>{new Date(marketSnapshot.collected_at).toLocaleString("zh-CN")}</b></footer>
        </> : <div className="market-modal-loading">本地数据库暂无该物品的订单快照，请先执行当前订单同步。</div>}
      </section>
    </div>}
    <footer><span>版本 {APP_VERSION}</span></footer>
  </main>;
}
