"use client";
import { useState } from 'react';
type Row={corporation_id:number;offer_id:number;type_id:number;faction_name_zh:string;corporation_name_zh:string;item_name:string;ak_cost:number;is_high_sec:'Y'|'N';is_blocked:'Y'|'N';manual_blocked:'Y'|'N';is_guard:'Y'|'N';is_invalid:'Y'|'N'};
export default function LpPolicyPanel({token}:{token:string}) {
  const [rows,setRows]=useState<Row[]>([]),[page,setPage]=useState(1),[total,setTotal]=useState(0);
  const [search,setSearch]=useState(''),[blocked,setBlocked]=useState(''),[error,setError]=useState(''),[busy,setBusy]=useState(false),[loaded,setLoaded]=useState(false);
  async function load(nextPage=1) {
    setBusy(true);setError('');
    try {
      const params=new URLSearchParams({page:String(nextPage),q:search,is_blocked:blocked});
      const response=await fetch(`/api/v2/lp-policy?${params}`,{headers:{'x-sync-admin-token':token},cache:'no-store'}),data=await response.json();
      if(!response.ok)throw new Error(data.error||'读取失败');
      setRows(data.rows);setTotal(data.total);setPage(nextPage);setLoaded(true);
    }catch(e){setError(e instanceof Error?e.message:'读取失败');}finally{setBusy(false);}
  }
  async function save(row:Row,field:'is_high_sec'|'is_blocked'|'is_guard'|'is_invalid',value:string) {
    if(!confirm(`${row.corporation_name_zh} · ${row.item_name}：将${{is_high_sec:'高安',is_blocked:'人工屏蔽',is_guard:'卫队分类',is_invalid:'无效分类'}[field]}设置为 ${value}？`))return;
    setBusy(true);setError('');
    try {
      const response=await fetch('/api/v2/lp-policy',{method:'POST',headers:{'content-type':'application/json','x-sync-admin-token':token},body:JSON.stringify({corporation_id:row.corporation_id,offer_id:row.offer_id,changes:{[field]:value}})}),data=await response.json();
      if(!response.ok)throw new Error(data.error||'保存失败');
      await load(page);
    }catch(e){setError(e instanceof Error?e.message:'保存失败');}finally{setBusy(false);}
  }
  return <section className="v2-policy-panel" aria-labelledby="v2-policy-title">
    <header className="v2-policy-head"><div><span className="v2-sync-eyebrow">MANUAL MAINTENANCE</span><h2 id="v2-policy-title">LP 方案标记维护</h2></div><span className="v2-policy-note">人工标记 · 同步时保留</span></header>
    <p className="v2-policy-description">高安 Y/N 用于榜单按钮；人工屏蔽与上方规则、分类开关叠加，最终屏蔽用于 LP 展示和计算。人工屏蔽设为 N 不会解除其他规则。分类修改只覆盖此军团的此方案，不影响同物品的其他来源。修改会保留到后续同步，并排队重算榜单。</p>
    <form onSubmit={e=>{e.preventDefault();void load();}} className="v2-policy-filters"><label className="v2-sync-field v2-policy-search"><span>名称 / ID</span><input value={search} onChange={e=>setSearch(e.target.value)} placeholder="搜索势力、军团、物品名称或 ID" /></label><label className="v2-sync-field"><span>屏蔽状态</span><select value={blocked} onChange={e=>setBlocked(e.target.value)}><option value="">全部方案</option><option value="Y">Y · 已屏蔽</option><option value="N">N · 未屏蔽</option></select></label><button className="v2-sync-button v2-sync-button--primary" disabled={busy}>{busy?'正在查询…':'查询 / 刷新'}</button></form>
    {error&&<p role="alert" className="v2-sync-error">{error}</p>}
    {!loaded&&!error&&<div className="v2-policy-empty"><span aria-hidden="true">⌕</span><p>输入管理口令后，查询需要维护的兑换方案。</p><small>查询不会修改数据；更改标记时仍需确认。</small></div>}
    {loaded&&<><div className="v2-policy-result"><span>共 <b>{total.toLocaleString('zh-CN')}</b> 个方案</span><span>第 {page} 页</span></div><div className="v2-policy-table-wrap"><table className="v2-policy-table"><thead><tr>{['势力','军团','物品 / ID','方案 ID','AK','高安','人工屏蔽','卫队','无效','最终屏蔽'].map(title=><th key={title}>{title}</th>)}</tr></thead><tbody>{rows.map(row=><tr key={`${row.corporation_id}:${row.offer_id}`} className={row.is_blocked==='Y'?'v2-policy-row--blocked':undefined}><td>{row.faction_name_zh||'无势力'}</td><td>{row.corporation_name_zh}<small>{row.corporation_id}</small></td><td>{row.item_name}<small>{row.type_id}</small></td><td className="v2-policy-number">{row.offer_id}</td><td className="v2-policy-number">{row.ak_cost}</td>{(['is_high_sec','is_blocked','is_guard','is_invalid'] as const).map(field=><td key={field}><select disabled={busy} aria-label={`${row.offer_id} ${{is_high_sec:'高安',is_blocked:'人工屏蔽',is_guard:'卫队',is_invalid:'无效'}[field]}`} value={field==='is_blocked'?row.manual_blocked:row[field]} onChange={e=>void save(row,field,e.target.value)}><option value="Y">Y</option><option value="N">N</option></select></td>)}<td>{row.is_blocked==='Y'?'Y · 屏蔽':'N · 可见'}</td></tr>)}</tbody></table></div>{!rows.length&&<p className="v2-policy-empty">没有匹配的兑换方案。</p>}<div className="v2-policy-pagination"><span>每页 50 条</span><button className="v2-sync-button" disabled={busy||page<=1} onClick={()=>void load(page-1)}>上一页</button><button className="v2-sync-button" disabled={busy||page*50>=total} onClick={()=>void load(page+1)}>下一页</button></div></>}
  </section>;
}
