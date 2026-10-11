"use client";

import { useRef, useState } from "react";
import { formatIsk as baseFormatIsk } from "../../lib/contract-analysis";
import type { ContractInputIssue } from "../../lib/contract-analysis";
const quantityFormatter=new Intl.NumberFormat("en-US");
const nameCollator=new Intl.Collator("zh-CN", { numeric: true, sensitivity: "base" });

function magnitudeHint(value: number | null | undefined) {
  if (value == null || !Number.isFinite(value)) return "";
  const amount = Math.floor(Math.abs(value));
  if (amount >= 100000000) {
    const yi = Math.floor(amount / 100000000);
    const wan = Math.floor((amount % 100000000) / 10000);
    return `${yi}亿${wan ? `${wan}万` : ""}`;
  }
  if (amount >= 10000) return `${Math.floor(amount / 10000)}万`;
  return `${amount}`;
}

type Row = { type_id: number; quantity: number; name_zh: string; name_en: string | null; sell_price: number | null; sell_total: number | null; buy_price: number | null; buy_total: number | null; estimate_price: number | null; estimate_total: number | null; history_price: number | null; volume: number | null; packaged_volume: number | null; is_repackable: boolean };
type Analysis = { source: string; missing_quotes: number | string; unresolved: string[]; unresolved_items?: { name: string; quantity: number }[]; totals: { sell: number; buy: number; estimate: number }; rows: Row[] };
type SortKey = "name" | "quantity" | "sell_unit" | "sell_total" | "buy_unit" | "buy_total" | "history_unit" | "history_total" | "volume_unit" | "volume_total";
const alertLabels: Record<string, string> = { "low-buy": "收单价过低", "high-buy": "收单价过高", "low-sell": "卖单价过低", "high-sell": "卖单价过高", missing: "报价缺失", history: "无历史成交价", rare: "稀有/高价值物品", unresolved: "物品未匹配" };

function ValueCell({ unit, total }: { unit: number | null; total: number | null }) {
  return <div className="contract-value-cell"><strong>{unit == null ? "暂无报价" : `单价：${baseFormatIsk(unit)}`}</strong><span>{total == null ? "总价：暂无" : `总价：${baseFormatIsk(total)}`}</span><small>{total != null ? magnitudeHint(total) : "\u00a0"}</small></div>;
}
function VolumeCell({ row }: { row: Row }) {
  if (row.volume == null) return <div className="contract-volume-cell"><strong>暂无体积</strong><small>物品体积数据缺失</small></div>;
  const packaged = row.packaged_volume ?? row.volume;
  if (row.is_repackable && packaged !== row.volume) return <div className="contract-volume-cell"><span>整船体积：{row.volume.toLocaleString()} m³</span><span>装箱体积：{packaged.toLocaleString()} m³</span><strong>总体积：{(packaged * row.quantity).toLocaleString()} m³</strong></div>;
  return <div className="contract-volume-cell"><span>单位体积：{row.volume.toLocaleString()} m³</span><strong>总体积：{(row.volume * row.quantity).toLocaleString()} m³</strong></div>;
}
function isPriceAnomaly(row: Row) {
  return row.buy_price != null && (row.sell_price == null || row.buy_price > row.sell_price);
}
function isPriceHigh(row: Row) {
  return row.estimate_price != null && [row.sell_price, row.buy_price].some(price => price != null && price > row.estimate_price! * 2);
}
function isPriceLow(row: Row) {
  return row.estimate_price != null && [row.sell_price, row.buy_price].some(price => price != null && price <= row.estimate_price! * 0.5);
}
function isSellHigh(row: Row) { return row.estimate_price != null && row.sell_price != null && row.sell_price > row.estimate_price * 2; }
function isBuyHigh(row: Row) { return row.estimate_price != null && row.buy_price != null && row.buy_price > row.estimate_price * 2; }
function isSellLow(row: Row) { return row.estimate_price != null && row.sell_price != null && row.sell_price <= row.estimate_price * 0.5; }
function isBuyLow(row: Row) { return row.estimate_price != null && row.buy_price != null && row.buy_price <= row.estimate_price * 0.5; }
function hasPriceAnomaly(row: Row) {
  return isPriceAnomaly(row) || row.sell_price == null || row.buy_price == null || row.estimate_price == null;
}

export default function ContractsPage() {
  const analysisRequest = useRef<AbortController | null>(null);
  const textInput = useRef<HTMLTextAreaElement | null>(null);
  const [inputIssues, setInputIssues] = useState<ContractInputIssue[]>([]);
  const [text, setText] = useState(""); const [analysis, setAnalysis] = useState<Analysis | null>(null); const [message, setMessage] = useState("粘贴合同物品清单，每行包含品目和数量。"); const [loading, setLoading] = useState(false); const [activeAlert, setActiveAlertState] = useState<string | null>(null); const [sort, setSortState] = useState<{ key: SortKey; direction: "asc" | "desc" }>({ key: "name", direction: "asc" });
  const setActiveAlert = (key: string | null) => setActiveAlertState(previous => key && previous === key ? null : key);
  function clear() {
    analysisRequest.current?.abort(); analysisRequest.current = null;
    setText(""); setAnalysis(null); setLoading(false); setActiveAlertState(null);
    setInputIssues([]);
    setSortState({ key: "name", direction: "asc" });
    setMessage("粘贴合同物品清单，每行包含品目和数量。");
    textInput.current?.focus();
  }
  async function analyze() {
    if (!text.trim()) { setMessage("请先粘贴合同物品清单"); return; }
    analysisRequest.current?.abort();
    const controller = new AbortController(); analysisRequest.current = controller;
    setLoading(true); setMessage("正在识别物品并查询晨曦市场报价…"); setAnalysis(null); setActiveAlert(null); setInputIssues([]);
    try { const response = await fetch("/api/data/contract-analysis", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text }), cache: "no-store", signal: controller.signal }); const payload = await response.json(); if (controller.signal.aborted) return; if (!response.ok) { if (payload.code === "INVALID_CONTRACT_LINES") setInputIssues(payload.issues || []); if (payload.code === "UNRESOLVED_ITEMS") { setAnalysis({ source: "本地物品目录", missing_quotes: 0, rows: [], totals: { sell: 0, buy: 0, estimate: 0 }, unresolved: payload.unresolved, unresolved_items: payload.unresolved_items }); setActiveAlertState("unresolved"); } throw new Error(payload.error || "合同分析失败"); } setAnalysis(payload); setMessage(`已合并 ${payload.input_count} 条输入为 ${payload.merged_count} 个品目${payload.unresolved.length ? `，另有 ${payload.unresolved.length} 个品目未匹配（未计入估价）` : ""}`); }
    catch (error) { if (!controller.signal.aborted) setMessage(error instanceof Error ? error.message : "合同分析失败"); } finally { if (analysisRequest.current === controller) { analysisRequest.current = null; setLoading(false); } }
  }
  const rareCount = analysis?.rows.filter(row => row.sell_price == null && row.buy_price != null && row.estimate_price == null).length || 0;
  const missingQuoteCount = analysis?.rows.filter(row => row.sell_price == null || row.buy_price == null).length || 0;
  const noHistoryCount = analysis?.rows.filter(row => row.estimate_price == null).length || 0;
  const anomalyCount = 0;
  const highSellCount = analysis?.rows.filter(isSellHigh).length || 0;
  const highBuyCount = analysis?.rows.filter(isBuyHigh).length || 0;
  const lowSellCount = analysis?.rows.filter(isSellLow).length || 0;
  const lowBuyCount = analysis?.rows.filter(isBuyLow).length || 0;
  const totalVolume = analysis?.rows.reduce((sum, row) => sum + ((row.packaged_volume ?? row.volume ?? 0) * row.quantity), 0) || 0;
  const missingVolumeCount=analysis?.rows.filter(row=>row.packaged_volume==null&&row.volume==null).length||0;
  function matchesAlert(row: Row, alert: string) {
    if (alert === "unresolved") return false;
    if (alert === "low-sell") return isSellLow(row);
    if (alert === "high-sell") return isSellHigh(row);
    if (alert === "low-buy") return isBuyLow(row);
    if (alert === "high-buy") return isBuyHigh(row);
    if (alert === "low") return isPriceLow(row);
    if (alert === "high") return isPriceHigh(row);
    if (alert === "missing") return row.sell_price == null || row.buy_price == null;
    if (alert === "history") return row.estimate_price == null;
    if (alert === "rare") return row.sell_price == null && row.buy_price != null && row.estimate_price == null;
    return true;
  }
  const collator = nameCollator;
  const unresolvedRows = (analysis?.unresolved_items ?? analysis?.unresolved.map(name => ({ name, quantity: null })) ?? []).slice().sort((a, b) => {
    const result = sort.key === "quantity" ? Number(a.quantity) - Number(b.quantity) : collator.compare(a.name, b.name);
    return (sort.direction === "desc" && (sort.key === "name" || sort.key === "quantity") ? -result : result) || collator.compare(a.name, b.name);
  });
  function sortValue(row: Row, key: SortKey) { if (key === "name") return row.name_zh || row.name_en || `物品 ${row.type_id}`; if (key === "quantity") return row.quantity; if (key === "sell_unit") return row.sell_price ?? -1; if (key === "sell_total") return row.sell_total ?? -1; if (key === "buy_unit") return row.buy_price ?? -1; if (key === "buy_total") return row.buy_total ?? -1; if (key === "history_unit") return row.estimate_price ?? -1; if (key === "history_total") return row.estimate_total ?? -1; if (key === "volume_unit") return row.volume ?? -1; return (row.packaged_volume ?? row.volume ?? -1) * row.quantity; }
  function setSort(key: SortKey) { setSortState(previous => previous.key === key ? { key, direction: previous.direction === "asc" ? "desc" : "asc" } : { key, direction: "asc" }); }
  const sortedRows = analysis ? analysis.rows.filter(row => !activeAlert || matchesAlert(row, activeAlert)).slice().sort((left, right) => { const a = sortValue(left, sort.key), b = sortValue(right, sort.key); const result = typeof a === "string" && typeof b === "string" ? collator.compare(a, b) : Number(a) - Number(b); if (result !== 0) return sort.direction === "asc" ? result : -result; return collator.compare(left.name_zh, right.name_zh); }) : [];
  return <main className="contract-tool-page">
    <header className="topbar"><div className="brand"><span className="mark">✦</span> 合同工具 <small>CONTRACT INTELLIGENCE</small></div><span className="database-state">晨曦市场 · 吉他 4-4</span></header>
    <section className="contract-tool-hero"><p className="eyebrow">BRIDGE TOOL 02 <span>CONTRACTS</span></p><h1>合同分析</h1><p className="sub">粘贴合同内容，自动合并同条目并查询晨曦市场价格。</p><div className="contract-analyzer"><label htmlFor="contract-text">合同物品清单</label><textarea ref={textInput} id="contract-text" value={text} onChange={event => setText(event.target.value)} placeholder={'品目\t数量\t分类\t类型\t槽位\n"异域"A型无人机伤害增效装置\t1\t无人机伤害单元\t装备\t低能量槽'} rows={7}/><div className="contract-analyzer-actions"><button type="button" onClick={() => void analyze()} disabled={loading}>{loading ? "分析中…" : "合同分析"}</button><button type="button" className="contract-clear-button" onClick={clear}>清空</button></div><small>{message}</small>{inputIssues.length > 0 && <div className="contract-input-errors" role="alert"><ul>{inputIssues.map(issue => <li key={issue.line}>第 {issue.line} 行 · {issue.name || "未填写物品"}：{issue.reason}</li>)}</ul>{inputIssues.length === 100 && <small>最多显示前 100 行错误。</small>}</div>}</div></section>
    {analysis ? <section className="contract-analysis-panel"><div className="contract-analysis-head"><div><p className="eyebrow">ALL OBJECTS · SERENITY</p><h2>合同物品估价</h2></div><div className="contract-head-alerts" onClick={event => { const card = (event.target as HTMLElement).closest(".contract-head-alert"); if (!card) return; const key = card.getAttribute("data-alert"); setActiveAlert(key || null); }}>{rareCount > 0 && <div data-alert="rare" className="contract-head-alert"><strong>警告：可能存在的稀有/高价值物品</strong><span>{rareCount} 项报价不完整</span></div>}{missingQuoteCount > 0 && <div data-alert="missing" className="contract-head-alert"><strong>警告：报价缺失</strong><span>{missingQuoteCount} 项</span></div>}{noHistoryCount > 0 && <div data-alert="history" className="contract-head-alert"><strong>警告：无历史成交价</strong><span>{noHistoryCount} 项</span></div>}{highBuyCount > 0 && <div data-alert="high-buy" className="contract-head-alert contract-head-alert-blue"><strong>警告：收单价过高</strong><span>{highBuyCount} 项</span></div>}{lowBuyCount > 0 && <div data-alert="low-buy" className="contract-head-alert contract-head-alert-blue"><strong>警告：收单价过低</strong><span>{lowBuyCount} 项</span></div>}{highSellCount > 0 && <div data-alert="high-sell" className="contract-head-alert contract-head-alert-blue"><strong>警告：卖单价过高</strong><span>{highSellCount} 项</span></div>}{lowSellCount > 0 && <div data-alert="low-sell" className="contract-head-alert contract-head-alert-blue"><strong>警告：卖单价过低</strong><span>{lowSellCount} 项</span></div>}{anomalyCount > 0 && <div className="contract-head-alert"><strong>警告：价格异常</strong><span>{anomalyCount} 项</span></div>}{analysis.unresolved.length > 0 && <div data-alert="unresolved" className="contract-head-alert"><strong>物品未匹配</strong><span>{analysis.unresolved.length} 项</span></div>}</div></div>
      <div className="contract-total-grid"><div><small>按卖出价总值</small><strong>{baseFormatIsk(analysis.totals.sell)}</strong><em>{magnitudeHint(analysis.totals.sell)}</em></div><div><small>按收购价总值</small><strong>{baseFormatIsk(analysis.totals.buy)}</strong><em>{magnitudeHint(analysis.totals.buy)}</em></div><div><small>30 天加权估价总值</small><strong>{baseFormatIsk(analysis.totals.estimate)}</strong><em>{magnitudeHint(analysis.totals.estimate)}</em></div><div><small>{missingVolumeCount?"已知体积合计":"合同总体积"}</small><strong>{totalVolume.toLocaleString("en-US", { maximumFractionDigits: 2 })} m³</strong><em>{missingVolumeCount?`缺少 ${missingVolumeCount} 项体积，合计不完整`:"按装箱体积计算"}</em></div></div>
{activeAlert && <div className="contract-active-filter">已筛选：{alertLabels[activeAlert] || "未知筛选"}<button type="button" onClick={() => setActiveAlert(null)}>清除筛选</button></div>}{/* 价格列仅保留单价 / 总价，重复的数量列已移除。 */}<div className="contract-table-wrap"><table className="contract-table"><thead><tr><th><button type="button" className="contract-sort-button" onClick={() => setSort("name")}>品目 {sort.key === "name" ? (sort.direction === "asc" ? "↑" : "↓") : "↕"}</button></th><th><button type="button" className="contract-sort-button" onClick={() => setSort("quantity")}>数量 {sort.key === "quantity" ? (sort.direction === "asc" ? "↑" : "↓") : "↕"}</button></th><th><button type="button" className="contract-sort-button" onClick={() => setSort("sell_unit")}>卖单价 {sort.key === "sell_unit" ? (sort.direction === "asc" ? "↑" : "↓") : "↕"}</button><button type="button" className="contract-sort-button" onClick={() => setSort("sell_total")}>卖单总价 {sort.key === "sell_total" ? (sort.direction === "asc" ? "↑" : "↓") : "↕"}</button></th><th><button type="button" className="contract-sort-button" onClick={() => setSort("buy_unit")}>收单价 {sort.key === "buy_unit" ? (sort.direction === "asc" ? "↑" : "↓") : "↕"}</button><button type="button" className="contract-sort-button" onClick={() => setSort("buy_total")}>收单总价 {sort.key === "buy_total" ? (sort.direction === "asc" ? "↑" : "↓") : "↕"}</button></th><th><button type="button" className="contract-sort-button" onClick={() => setSort("history_unit")}>历史单价 {sort.key === "history_unit" ? (sort.direction === "asc" ? "↑" : "↓") : "↕"}</button><button type="button" className="contract-sort-button" onClick={() => setSort("history_total")}>历史总价 {sort.key === "history_total" ? (sort.direction === "asc" ? "↑" : "↓") : "↕"}</button></th><th><button type="button" className="contract-sort-button" onClick={() => setSort("volume_unit")}>单位体积 {sort.key === "volume_unit" ? (sort.direction === "asc" ? "↑" : "↓") : "↕"}</button><button type="button" className="contract-sort-button" onClick={() => setSort("volume_total")}>总体积 {sort.key === "volume_total" ? (sort.direction === "asc" ? "↑" : "↓") : "↕"}</button></th></tr></thead><tbody>{activeAlert === "unresolved" && unresolvedRows.map(item => <tr className="contract-row-warning contract-unresolved-row" key={item.name}><td><strong>{item.name}</strong><small>未匹配到物品 ID</small></td><td>{item.quantity == null ? "—" : item.quantity.toLocaleString("en-US")}</td><td colSpan={4}>未计入估价与体积合计，请核对名称或提供物品 ID。</td></tr>)}{sortedRows.map(row => <tr className={isPriceHigh(row) || isPriceLow(row) ? "contract-row-price-band" : hasPriceAnomaly(row) ? "contract-row-warning" : undefined} key={row.type_id}><td><strong>{row.name_zh}</strong>{row.name_en && <small>{row.name_en}</small>}<em>Type ID {row.type_id}</em></td><td>{quantityFormatter.format(row.quantity)}</td><td><ValueCell unit={row.sell_price} total={row.sell_total}/></td><td><ValueCell unit={row.buy_price} total={row.buy_total}/></td><td><ValueCell unit={row.estimate_price} total={row.estimate_total}/></td><td><VolumeCell row={row}/></td></tr>)}</tbody></table></div>
      {analysis.unresolved.length > 0 && <p className="contract-analysis-note">未匹配物品：{analysis.unresolved.join("、")}</p>}<p className="contract-analysis-note">价格来源：晨曦（Serenity）伏尔戈星域；历史价严格使用近 30 天成交记录，无成交记录时显示缺失提示。</p>
    </section> : <section className="contract-tool-placeholder"><div><span>01</span><b>粘贴合同</b><small>每行品目和数量</small></div><div><span>02</span><b>价格分析</b><small>卖单、收单与 30 天均价</small></div><div><span>03</span><b>合并校验</b><small>重复品目自动汇总</small></div></section>}
    <footer><span>CONTRACT TOOL · SERENITY MARKET</span><span>V2.0.0</span></footer>
  </main>;
}
