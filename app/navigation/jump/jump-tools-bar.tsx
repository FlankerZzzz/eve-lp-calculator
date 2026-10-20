"use client";
import {useEffect,useRef,useState} from 'react';
import {filterJumpReach,formatJumpReachList} from '../../../lib/jump-tools.mjs';
import SystemPicker from '../system-picker';
import type {StarSystem} from '../star-map';
import type {useJumpTools} from './use-jump-tools';

export type JumpTools=ReturnType<typeof useJumpTools>;
type Point={text:string;id:number|null};
export function JumpToolsBar({systems,tools,onCalculate,disabled=false}:{systems:StarSystem[];tools:JumpTools;onCalculate:()=>void;disabled?:boolean}){
  const [reach,setReach]=useState<Point>({text:'',id:null}),[a,setA]=useState<Point>({text:'',id:null}),[b,setB]=useState<Point>({text:'',id:null});
  return <div className="jump-tools-bar" aria-label="星图小工具">
    <span className="jump-tools-caption">小工具：</span>
    <form className="jump-tool-form" aria-label="一跳可达工具" onSubmit={event=>{event.preventDefault();if(reach.id!==null){onCalculate();tools.showReach(reach.id);}}}>
      <span>一跳可达</span><SystemPicker systems={systems} value={reach.text} label="一跳可达星系" placeholder="输入星系" disabled={disabled} onChange={(text,id)=>setReach({text,id})}/>
      <button type="submit" disabled={disabled||reach.id===null}>计算</button>
    </form>
    <span className="jump-tools-divider" aria-hidden="true">|</span>
    <form className="jump-tool-form" aria-label="距离计算工具" onSubmit={event=>{event.preventDefault();if(a.id!==null&&b.id!==null){onCalculate();tools.measure(a.id,b.id);}}}>
      <span>距离计算</span><SystemPicker systems={systems} value={a.text} label="距离计算星系 A" placeholder="星系 A" disabled={disabled} onChange={(text,id)=>setA({text,id})}/>
      <span>到</span><SystemPicker systems={systems} value={b.text} label="距离计算星系 B" placeholder="星系 B" disabled={disabled} onChange={(text,id)=>setB({text,id})}/>
      <button type="submit" disabled={disabled||a.id===null||b.id===null}>计算</button>
    </form>
  </div>;
}

const ly=(n:number)=>n>0&&n<.0001?'<0.0001':n.toLocaleString('zh-CN',{maximumFractionDigits:4});
export function JumpToolsResults({systems,tools,onSelect}:{systems:Map<number,StarSystem>;tools:JumpTools;onSelect:(system:StarSystem)=>void}){
  if(tools.active===null)return null;
  const error=tools.active==='reach'?tools.reachError:tools.distanceError;
  if(error)return <div className="jump-tool-result jump-tool-error" role="alert">{error}<button onClick={tools.cancelEffects} aria-label="关闭工具提示">×</button></div>;
  if(tools.active==='distance'&&tools.distance){
    const {from,to,distance}=tools.distance;
    return <div className="jump-tool-result jump-distance-result" role="status"><span>{systems.get(from)?.nameZh} → {systems.get(to)?.nameZh}<b>{ly(distance)} 光年</b></span></div>;
  }
  if(!tools.reach)return null;
  return <JumpReachResults key={`${tools.reach.origin}:${tools.reachOverlay?.request}`} systems={systems} tools={tools} onSelect={onSelect}/>;
}

function JumpReachResults({systems,tools,onSelect}:{systems:Map<number,StarSystem>;tools:JumpTools;onSelect:(system:StarSystem)=>void}){
  const [query,setQuery]=useState(''),[copied,setCopied]=useState<{text:string;manual:boolean}|null>(null);
  const fallback=useRef<HTMLTextAreaElement>(null);
  const reach=tools.reach;
  const rows:JumpTools['rows']=filterJumpReach({systems},tools.rows,query);
  const copyText=reach?`${systems.get(reach.origin)?.nameZh} · 一跳可达 ${rows.length} 个 · 航程 ${ly(reach.range)} 光年\n${formatJumpReachList({systems},rows,tools.direction)}`:'';
  const feedback=copied?.text===copyText?copied:null;
  useEffect(()=>{if(feedback?.manual){fallback.current?.focus();fallback.current?.select();}},[feedback]);
  async function copy(){
    try{
      if(!navigator.clipboard?.writeText)throw new Error('Clipboard unavailable');
      await navigator.clipboard.writeText(copyText);
      setCopied({text:copyText,manual:false});
    }catch{setCopied({text:copyText,manual:true});}
  }
  if(!reach)return null;
  return <section className="jump-tool-result jump-reach-results" aria-label="一跳可达结果">
    <header><span><b>{systems.get(reach.origin)?.nameZh}</b><small>一跳可达 {tools.rows.length} 个 · 航程 {ly(reach.range)} 光年</small></span></header>
    <div className="jump-reach-actions">
      <input type="search" aria-label="搜索一跳可达星系" placeholder="搜索星系" value={query} onChange={event=>{setQuery(event.target.value);setCopied(null);}}/>
      <button type="button" disabled={!rows.length} onClick={copy} aria-label="复制一跳可达列表">复制</button>
    </div>
    <label>光年排序<select aria-label="一跳可达距离排序" value={tools.direction} onChange={event=>tools.setDirection(event.target.value as 'asc'|'desc')}><option value="asc">从近到远 ↑</option><option value="desc">从远到近 ↓</option></select></label>
    {query.trim()&&<p className="jump-reach-count">匹配 {rows.length} / {tools.rows.length} 个</p>}
    {feedback&&<div className="jump-reach-copy-feedback"><p role="status">{feedback.manual?'无法自动复制，已选中文本，请手动复制。':'已复制当前列表。'}</p>{feedback.manual&&<textarea ref={fallback} readOnly value={copyText} aria-label="手动复制一跳可达列表"/>}</div>}
    <ol>{rows.map(row=>{const system=systems.get(row.id);return <li key={row.id}><button onClick={()=>{if(system)onSelect(system);}}><span>{system?.nameZh}<small>{system?.nameEn}</small></span><em>{ly(row.distance)} 光年</em></button></li>;})}</ol>
    {!rows.length&&<p>{tools.rows.length?'没有匹配的星系。':'当前条件下没有一跳可达星系。'}</p>}
    <footer>点击任意星系仅放大，不清除计算；使用“清除计算”按钮清除结果。</footer>
  </section>;
}
