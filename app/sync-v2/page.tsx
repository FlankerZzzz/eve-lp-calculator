"use client";
import { useEffect, useState } from 'react';
import Link from 'next/link';
import LpPolicyPanel from './lp-policy-panel';
import LpRulesPanel from './lp-rules-panel';
import ScheduleEditor from './schedule-editor';
import DataMaintenancePanel from './data-maintenance-panel';
import './sync-v2.css';
type Task = { module: string; automatic: number; cron: string | null; status: string; phase: string | null; processed: number; remaining: number; error: string | null; last_success: string | null; next_run: string | null; debug: number; feeds?:{kind:string;modified:string|null;fetched:string|null;error:string|null;records:number|null}[] };
const feedNames:Record<string,string>={system_jumps:'过门统计',system_kills:'击毁统计',incursions:'萨沙入侵',sovereignty:'主权',sovereignty_names:'主权归属名称',industry:'工业系数'};
const labels: Record<string,string> = { items:'物品主表', catalog:'势力 · 军团 · LP', orders:'伏尔戈订单', contracts:'公开合同', history:'历史成交', rankings:'排行榜',geography:'星系地理缓存' };
const descriptions: Record<string,string> = { items:'物品信息与 SDE 查缺补漏', catalog:'势力、军团及 LP 兑换方案', orders:'伏尔戈星域全量市场订单', contracts:'公开合同目录及物品明细', history:'按物品补齐每日成交记录', rankings:'按现有规则重算全局 Top 100',geography:'过门、击毁、主权、入侵与工业系数 · 默认每小时 · 统计保留 72 小时' };
const statuses: Record<string,string> = { idle:'未开始', queued:'已排队', running:'运行中', pause_requested:'暂停中', paused:'已暂停', complete:'已完成', failed:'失败' };
const formatTime = (value: string | null) => value ? new Date(value).toLocaleString('zh-CN') : '尚未完成';
export default function V2SyncPage() {
  const [tasks,setTasks] = useState<Task[]>([]), [error,setError] = useState(''), [database,setDatabase] = useState('v2');
  const [token,setToken] = useState('');
  const [policyRevision,setPolicyRevision] = useState(0);
  async function refresh() { try { const response=await fetch('/api/v2/sync',{cache:'no-store'});const data=await response.json();if(!response.ok)throw new Error(data.error||'状态读取失败');setTasks(data.tasks);setDatabase(data.database); } catch(error) {setError(error instanceof Error?error.message:'读取失败');} }
  useEffect(()=>{setToken(sessionStorage.getItem('v2-admin-token')||'');void refresh();const timer=setInterval(()=>void refresh(),10000);return()=>clearInterval(timer);},[]);
  async function control(module:string,action:string,extra:Record<string,unknown>={}) {
    setError('');sessionStorage.setItem('v2-admin-token',token);
    try {const response=await fetch('/api/v2/sync',{method:'POST',headers:{'content-type':'application/json','x-sync-admin-token':token},body:JSON.stringify({module,action,...extra})});const data=await response.json();if(!response.ok)throw new Error(data.error||'操作失败');await refresh();}catch(error){setError(error instanceof Error?error.message:'操作失败');}
  }
  return <main className="v2-sync-page">
    <header className="v2-sync-header">
      <div><span className="v2-sync-eyebrow">DATA OPERATIONS / V2</span><h1>同步管理</h1><p>集中管理同步任务、自动计划与 LP 方案标记。</p></div>
      <nav aria-label="同步页面导航"><Link href="/">返回 LP 计算器 <span aria-hidden="true">↗</span></Link></nav>
    </header>
    <div className="v2-sync-context"><span className="v2-sync-db"><i aria-hidden="true"/>业务读取 · {tasks.length ? database.toUpperCase() : '连接中'}</span><span>时区 Asia/Shanghai</span><span>正式 V2 数据库与同步器</span></div>
    <section className="v2-sync-auth" aria-labelledby="v2-auth-title">
      <div><h2 id="v2-auth-title">管理口令</h2><p>执行同步操作或维护 LP 标记时使用，只保存在当前浏览器标签页。</p></div>
      <label className="v2-sync-field"><span>同步管理口令</span><input type="password" value={token} onChange={event=>setToken(event.target.value)} autoComplete="off" placeholder="请输入配置的管理口令" aria-describedby="v2-auth-help" /></label>
      <details id="v2-auth-help"><summary>口令在哪里配置？</summary><p>在服务端项目根目录的 <code>.env</code> 中设置 <code>SYNC_ADMIN_TOKEN</code>。配置为空则不要求口令；修改后需重新创建 Web 容器使配置生效。此处仅输入口令，不修改服务端配置。</p></details>
    </section>
    {error&&<p role="alert" className="v2-sync-error">{error}</p>}
    <div className="v2-sync-section-heading"><h2>同步任务 <span>{tasks.length || '—'} 个模块</span></h2><p><i aria-hidden="true"/>状态每 10 秒更新</p></div>
    <div className="v2-sync-grid">{tasks.map((task,index)=>{
      const total=task.processed+task.remaining, progress=task.status==='complete'?100:total>0?Math.min(100,Math.max(0,task.processed/total*100)):0;
      return <section key={task.module} className={`v2-sync-card v2-sync-card--${task.status}`} aria-labelledby={`v2-task-${task.module}`}>
        <header className="v2-sync-card-head"><span className="v2-sync-index">{String(index+1).padStart(2,'0')}</span><div><h3 id={`v2-task-${task.module}`}>{labels[task.module]}</h3><p>{descriptions[task.module]}</p></div><span className={`v2-sync-status v2-sync-status--${task.status}`}>{statuses[task.status]||task.status}</span></header>
        <div className="v2-sync-progress" role="progressbar" aria-label={`${labels[task.module]}同步进度`} aria-valuenow={Math.round(progress)} aria-valuemin={0} aria-valuemax={100}><span style={{width:`${progress}%`}}/></div>
        <div className="v2-sync-counts"><span>已处理 <b>{task.processed.toLocaleString('zh-CN')}</b></span><span>剩余 <b>{task.remaining.toLocaleString('zh-CN')}</b></span></div>
        <dl className="v2-sync-facts"><div><dt>当前阶段</dt><dd>{task.phase||'等待运行'}</dd></div><div><dt>最后成功</dt><dd>{formatTime(task.last_success)}</dd></div><div><dt>下次运行</dt><dd>{task.automatic&&task.next_run?formatTime(task.next_run):'自动关闭'}</dd></div></dl>
        {task.module==='geography'&&<details><summary>缓存明细 · 数据库读取 · 统计保留 72 小时</summary><dl className="v2-sync-facts">{task.feeds?.map(feed=><div key={feed.kind}><dt>{feedNames[feed.kind]||feed.kind}</dt><dd>{feed.records===null?'尚未缓存':`${feed.records.toLocaleString()} 条`}<br/>入库：{formatTime(feed.fetched)}{feed.modified&&<><br/>官方时间：{formatTime(feed.modified)}</>}{feed.error&&<p className="v2-sync-error">{feed.error}（保留上次成功数据）</p>}</dd></div>)}</dl><p>过门与击毁各自保留官方一小时窗口；不是过去 72 小时的累加值。主权、入侵和工业系数保留最新快照。</p></details>}
        <div className="v2-sync-settings"><label className="v2-sync-toggle"><span>自动同步</span><input type="checkbox" checked={Boolean(task.automatic)} onChange={event=>void control(task.module,'configure',{automatic:event.target.checked})}/><i aria-hidden="true"/></label>
          <ScheduleEditor key={task.cron} cron={task.cron} onSave={cron=>control(task.module,'configure',{cron})}/>
          <label className="v2-sync-debug"><input type="checkbox" checked={Boolean(task.debug)} onChange={event=>void control(task.module,'configure',{debug:event.target.checked})}/><span>DEBUG 完整数据日志</span></label>
        </div>
        <div className="v2-sync-actions"><button className="v2-sync-button v2-sync-button--primary" onClick={()=>void control(task.module,'start')}>运行 / 恢复</button><button className="v2-sync-button" onClick={()=>void control(task.module,'pause')}>暂停</button><button className="v2-sync-button v2-sync-button--restart" onClick={()=>void control(task.module,'restart')}>重新同步</button></div>
        {task.error&&<p role="alert" className="v2-sync-error">{task.error}</p>}
      </section>;
    })}</div>
    {!tasks.length&&<p className="v2-sync-empty">正在读取任务状态…</p>}
    <DataMaintenancePanel token={token}/>
    <LpRulesPanel token={token} onChanged={()=>{setPolicyRevision(value=>value+1);void refresh();}}/>
    <LpPolicyPanel key={policyRevision} token={token}/>
  </main>;
}
