"use client";
import { useState } from 'react';
const modules:Record<string,string>={items:'物品、蓝图及制造材料',catalog:'LP 兑换方案及需求材料',history:'历史成交',orders:'订单（仅导出）',contracts:'合同及明细（仅导出）',rankings:'排行榜缓存（仅导出）',geography:'星系地理缓存（仅导出）'};
type Preview={preview_id:string;summary:{insert:number;update:number;unchanged:number;protected:number};examples:{table:string;action:string;row:Record<string,unknown>}[]};
export default function DataMaintenancePanel({token}:{token:string}) {
  const [module,setModule]=useState('items'),[typeId,setTypeId]=useState(''),[from,setFrom]=useState(''),[to,setTo]=useState(''),[file,setFile]=useState<File|null>(null),[preview,setPreview]=useState<Preview|null>(null),[protect,setProtect]=useState(false),[busy,setBusy]=useState(false),[error,setError]=useState(''),[notice,setNotice]=useState('');
  async function unpack(response:Response){const data=await response.json();if(!response.ok)throw new Error(data.error||'操作失败');return data;}
  async function download() {
    setBusy(true);setError('');
    try {
      const params={module,type_id:module==='geography'?'':typeId,from:module==='history'?from:'',to:module==='history'?to:''};
      const data=await unpack(await fetch(`/api/v2/data?${new URLSearchParams(params)}`,{headers:{'x-sync-admin-token':token},cache:'no-store'}));
      const form=document.createElement('form');form.method='POST';form.action='/api/v2/data/export';form.target='_blank';form.rel='noopener';
      for(const [name,value] of Object.entries({...params,admin_token:token})){const input=document.createElement('input');input.type='hidden';input.name=name;input.value=value;form.appendChild(input);}document.body.appendChild(form);form.submit();form.remove();
      setNotice(`已开始下载 ${data.counts.reduce((n:number,row:{count:number})=>n+row.count,0).toLocaleString()} 条记录。JSONL 首行为格式说明；后续每行一条记录。`);
    }catch(e){setError(e instanceof Error?e.message:'导出失败');}finally{setBusy(false);}
  }
  async function upload() {
    if(!file){setError('请先选择修复文件');return;}if(file.size>20*1024*1024){setError('文件超过 20 MiB，请按物品或日期分批修复');return;}
    setBusy(true);setError('');setPreview(null);try{const body=new FormData();body.set('module',module);body.set('file',file);setPreview(await unpack(await fetch('/api/v2/data',{method:'POST',headers:{'x-sync-admin-token':token},body})));setNotice('校验完成，尚未修改在线数据。请核对预览后提交。');}catch(e){setError(e instanceof Error?e.message:'校验失败');}finally{setBusy(false);}
  }
  async function commit() {
    if(!preview||!confirm(`确认导入：新增 ${preview.summary.insert}，更新 ${preview.summary.update}，保护跳过 ${preview.summary.protected}？提交前会备份原记录。`))return;
    setBusy(true);setError('');try{const data=await unpack(await fetch('/api/v2/data',{method:'POST',headers:{'x-sync-admin-token':token,'content-type':'application/json'},body:JSON.stringify({preview_id:preview.preview_id,protect})}));setPreview(null);setNotice(`导入完成；备份保存在服务端 maintenance/${data.backup}。未出现在文件中的记录不会删除。`);}catch(e){setError(e instanceof Error?e.message:'提交失败');}finally{setBusy(false);}
  }
  const importable=['items','catalog','history'].includes(module);
  return <section className="v2-policy-panel" aria-labelledby="data-maintenance-title"><header className="v2-policy-head"><div><span className="v2-sync-eyebrow">EXPORT / REPAIR IMPORT</span><h2 id="data-maintenance-title">数据导出与修复导入</h2></div><span className="v2-policy-note">人工修复 · 同步保护</span></header>
    <p className="v2-policy-description">导出完整原始字段，支持全量或按物品 ID 筛选；历史可按日期筛选。修复导入先校验、预览、备份，再按主键合并；不会因文件少了记录就删除数据。订单、合同和派生排行榜禁止导入。</p>
    <div className="v2-policy-filters"><label className="v2-sync-field v2-data-module"><span>数据模块</span><select value={module} onChange={e=>{setModule(e.target.value);setPreview(null);setFile(null);setNotice('');}}>{Object.entries(modules).map(([key,label])=><option value={key} key={key}>{label}</option>)}</select></label><label className="v2-sync-field"><span>导出物品 ID（留空为全部）</span><input type="number" min="1" value={typeId} onChange={e=>setTypeId(e.target.value)}/></label>{module==='history'&&<><label className="v2-sync-field"><span>起始日期</span><input type="date" value={from} onChange={e=>setFrom(e.target.value)}/></label><label className="v2-sync-field"><span>结束日期</span><input type="date" value={to} onChange={e=>setTo(e.target.value)}/></label></>}<button className="v2-sync-button" disabled={busy} onClick={()=>void download()}>导出 JSONL</button></div>
    {importable&&<div className="v2-data-import"><label className="v2-sync-field"><span>选择修改后的 JSONL 修复包</span><input key={module} type="file" accept=".jsonl,.ndjson" onChange={e=>{setFile(e.target.files?.[0]??null);setPreview(null);}}/></label><button className="v2-sync-button" disabled={busy} onClick={()=>void upload()}>上传并校验</button><label className="v2-sync-debug"><input type="checkbox" checked={protect} onChange={e=>setProtect(e.target.checked)}/><span>为本次增改记录设置同步保护</span></label><p className="v2-rule-help">每批最多 20 MiB / 10,000 条。全部同步任务空闲时可提交；预览 30 分钟有效。已有保护记录始终跳过。关联材料继承方案/蓝图保护。JSONL 是本系统修复格式，不是 CCP SDE ZIP；SDE 原版导入仍使用现有专用导入流程。</p></div>}
    {error&&<p className="v2-sync-error" role="alert">{error}</p>}{notice&&<p className="v2-maintenance-notice" role="status">{notice}</p>}
    {preview&&<div className="v2-maintenance-preview"><p>新增 <b>{preview.summary.insert}</b> · 更新 <b>{preview.summary.update}</b> · 不变 <b>{preview.summary.unchanged}</b> · 保护跳过 <b>{preview.summary.protected}</b></p><details><summary>查看前 10 条记录</summary>{preview.examples.map((entry,i)=><pre key={i}>{entry.table} · {entry.action}{'\n'}{JSON.stringify(entry.row,null,2)}</pre>)}</details><button className="v2-sync-button v2-sync-button--primary" disabled={busy} onClick={()=>void commit()}>确认提交导入</button></div>}
  </section>;
}
