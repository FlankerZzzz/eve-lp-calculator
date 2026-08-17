"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";

type SyncKind = "catalog" | "history" | "orders" | "linked" | "rankings";
type Job = {
  kind: SyncKind;
  status: "idle" | "running" | "paused" | "complete" | "error";
  phase: string | null;
  run_started_at: string | null;
  processed: number;
  remaining: number;
  last_endpoint: string | null;
  last_http_status: number | null;
  last_response: string | null;
  error: string | null;
  updated_at: string;
};
type Event = { id: number; kind: SyncKind; phase: string | null; endpoint: string | null; http_status: number | null; response: string | null; created_at: string };
type Counts = { corporation_total: number; corporation_synced: number; item_total: number; item_named: number; invalid_items: number; offers: number; history_rows: number; history_types: number; order_types: number };
type InvalidItem = { type_id: number; name: string; invalid_reason: string | null };

const labels: Record<SyncKind, { title: string; description: string }> = {
  catalog: { title: "基础资料", description: "势力、NPC 军团、中文物品名与 LP 商店兑换方案" },
  history: { title: "历史成交", description: "每 1 秒最多 50 项；市场历史成交均价、最高价、最低价与每日成交量" },
  orders: { title: "当前订单", description: "独立同步器异步并发 100 项；每 0.5 秒批量写入；产出物记录最高收单价和最低卖单价，需求材料使用最低卖单价" },
  linked: { title: "关联同步", description: "同步 LP 产出物及全部关联材料的历史成交与当前订单" },
  rankings: { title: "首页榜单", description: "每天自动计算一次并固定保存；首页只读取快照，不现场计算" },
};

const emptyCounts: Counts = { corporation_total: 0, corporation_synced: 0, item_total: 0, item_named: 0, invalid_items: 0, offers: 0, history_rows: 0, history_types: 0, order_types: 0 };

export default function SyncPage() {
  const [jobs, setJobs] = useState<Job[]>([]);
  const [events, setEvents] = useState<Event[]>([]);
  const [counts, setCounts] = useState<Counts>(emptyCounts);
  const [message, setMessage] = useState("正在读取同步状态…");
  const [pendingKind, setPendingKind] = useState<SyncKind | null>(null);
  const [showInvalid, setShowInvalid] = useState(false);
  const [invalidItems, setInvalidItems] = useState<InvalidItem[]>([]);

  const refreshStatus = useCallback(async () => {
    const response = await fetch(`/api/sync/status${showInvalid ? "?show_invalid=1" : ""}`, { cache: "no-store" });
    if (!response.ok) throw new Error("无法读取同步状态");
    const data = await response.json() as { jobs: Job[]; events: Event[]; counts: Counts; invalidItems: InvalidItem[] };
    setJobs(data.jobs);
    setEvents(data.events);
    setCounts(data.counts || emptyCounts);
    setInvalidItems(data.invalidItems || []);
  }, [showInvalid]);

  useEffect(() => {
    refreshStatus().then(() => setMessage("同步控制台已就绪")).catch(error => setMessage(error instanceof Error ? error.message : "状态读取失败"));
    const timer = setInterval(() => refreshStatus().catch(() => undefined), 1000);
    return () => clearInterval(timer);
  }, [refreshStatus]);

  async function control(kind: SyncKind, action: "start" | "pause" | "restart") {
    setPendingKind(kind);
    setMessage(action === "pause" ? `正在暂停${labels[kind].title}` : action === "restart" ? `正在重新同步${labels[kind].title}` : `正在恢复${labels[kind].title}后台同步`);
    try {
      const response = await fetch("/api/sync/control", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ kind, action }),
      });
      const result = await response.json() as { error?: string };
      if (!response.ok) throw new Error(result.error || `HTTP ${response.status}`);
      setMessage(action === "pause" ? `${labels[kind].title}已暂停，进度已保存` : action === "restart" ? `${labels[kind].title}已开始新一轮同步，进度已清零` : `${labels[kind].title}已恢复，关闭网页不受影响`);
      await refreshStatus();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "同步控制失败");
    } finally {
      setPendingKind(null);
    }
  }

  const jobMap = useMemo(() => new Map(jobs.map(job => [job.kind, job])), [jobs]);
  const activeKinds = jobs.filter(job => job.status === "running").map(job => job.kind);
  const currentJob = jobs.find(job => job.status === "running") || jobs.find(job => job.status === "error") || jobs.find(job => job.status === "paused") || null;

  return <main className="sync-page">
    <nav className="topbar">
      <div className="brand"><span className="mark">✦</span><span>LP<span className="accent">/</span>同步控制台</span><small>晨曦 · SQLite/D1</small></div>
      <span className="database-state">{message}</span>
      <Link className="nav-action" href="/">返回收益分析 →</Link>
    </nav>

    <header className="sync-header"><div><p className="eyebrow">/SYNC</p><h1>数据同步状态</h1><p>同步循环运行在本地服务端。刷新或关闭网页不会中断作业；只有关闭 3000 端口服务才会停止。每次仅执行一个保守的小批次。</p></div><button className={`invalid-toggle ${showInvalid ? "active" : ""}`} onClick={() => setShowInvalid(value => !value)}>{showInvalid ? "隐藏无效数据" : `显示无效数据（${counts.invalid_items}）`}</button></header>

    <section className="metric-grid">
      <div><span>军团</span><strong>{counts.corporation_synced}<small> / {counts.corporation_total}</small></strong></div>
      <div><span>中文物品名</span><strong>{counts.item_named}<small> / {counts.item_total}</small></strong></div>
      <div><span>LP 兑换方案</span><strong>{counts.offers.toLocaleString()}</strong></div>
      <div><span>历史日线</span><strong>{counts.history_rows.toLocaleString()}<small> 行</small></strong></div>
      <div><span>历史物品</span><strong>{counts.history_types.toLocaleString()}</strong></div>
      <div><span>订单物品</span><strong>{counts.order_types.toLocaleString()}</strong></div>
    </section>

    <section className="job-grid">
      {(["catalog", "history", "orders", "linked", "rankings"] as SyncKind[]).map((kind, index) => {
        const job = jobMap.get(kind);
        const total = (job?.processed || 0) + (job?.remaining || 0);
        const percent = total ? (job?.processed || 0) / total * 100 : job?.status === "complete" ? 100 : 0;
        const percentText = percent.toFixed(1);
        const isRunning = job?.status === "running";
        const stateLabel = isRunning ? "运行中" : job?.status === "complete" ? "已完成" : job?.status === "error" ? "发生错误" : job?.status === "paused" ? "已暂停" : "未运行";
        return <article className={`job-card ${job?.status || "idle"}`} key={kind}>
          <div className="job-title"><i>0{index + 1}</i><div><h2>{labels[kind].title}</h2><p>{labels[kind].description}</p></div><span>{stateLabel}</span></div>
          <div className="progress-track"><b style={{ width: `${percent}%` }} /></div>
          <div className="job-numbers"><span>进度 {percentText}%</span><span>已处理 {job?.processed || 0}</span><span>剩余 {job?.remaining || 0}</span></div>
          {kind === "orders" && <div className="job-numbers"><span>全部订单物品 {counts.order_types || 0}</span><span>本轮同步总数 {(job?.processed || 0) + (job?.remaining || 0)}</span></div>}
          <dl><div><dt>当前阶段</dt><dd>{job?.phase || "—"}</dd></div><div><dt>最后接口</dt><dd>{job?.last_endpoint || "—"}</dd></div><div><dt>HTTP</dt><dd>{job?.last_http_status || "—"}</dd></div><div><dt>更新时间</dt><dd>{job?.updated_at ? new Date(job.updated_at).toLocaleString("zh-CN") : "—"}</dd></div></dl>
          {job?.error && <p className="job-error">{job.error}</p>}
          <div className="job-buttons"><button className="run-button" disabled={pendingKind === kind || (!isRunning && activeKinds.length > 0 && !((kind === "linked" && activeKinds.every(active => active === "catalog")) || (kind === "catalog" && activeKinds.every(active => active === "linked"))))} onClick={() => control(kind, isRunning ? "pause" : "start")}>{pendingKind === kind ? "处理中…" : isRunning ? "暂停" : "恢复"}</button><button className="restart-button" disabled={pendingKind === kind || activeKinds.length > 0} onClick={() => control(kind, "restart")}>{kind === "rankings" ? "手动重算" : "重新同步"}</button></div>
        </article>;
      })}
    </section>

    {showInvalid && <section className="invalid-panel"><div className="panel-title"><h2>无效市场物品</h2><span>仅供查看 · 永久跳过市场查询</span></div>{invalidItems.length ? <div className="invalid-items">{invalidItems.map(item => <div key={item.type_id}><code>{item.type_id}</code><b>{item.name}</b><span>{item.invalid_reason || "市场不可交易或物品不存在"}</span></div>)}</div> : <p className="no-events">目前没有已标记的无效物品</p>}</section>}

    <section className="sync-detail-grid">
      <article className="response-panel"><div className="panel-title"><h2>当前作业与接口返回</h2><span>{currentJob ? labels[currentJob.kind].title : "无活动作业"}</span></div><dl><div><dt>阶段</dt><dd>{currentJob?.phase || "—"}</dd></div><div><dt>接口</dt><dd>{currentJob?.last_endpoint || "—"}</dd></div><div><dt>状态码</dt><dd>{currentJob?.last_http_status || "—"}</dd></div></dl><pre>{currentJob?.last_response || currentJob?.error || "尚未产生接口返回"}</pre></article>
      <article className="event-panel"><div className="panel-title"><h2>最近同步记录</h2><span>最近 40 条</span></div><div className="event-list">{events.length ? events.map(event => <div key={event.id}><time>{new Date(event.created_at).toLocaleTimeString("zh-CN")}</time><b>{labels[event.kind]?.title || event.kind}</b><span>{event.phase || "—"}</span><code>{event.http_status || "—"}</code><p>{event.endpoint || event.response || "—"}</p></div>) : <p className="no-events">暂无同步记录</p>}</div></article>
    </section>
  </main>;
}
