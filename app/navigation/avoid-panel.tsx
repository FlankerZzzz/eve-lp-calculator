"use client";
import {useMemo,useState} from 'react';
import SystemPicker from './system-picker';
import type {LocalAvoid,SystemInfo} from './navigation-types';
import {createSystemSearch} from '../../lib/system-search.mjs';
export default function AvoidPanel({mode,systems,value,onChange,onToggle,error}:{mode:'regular'|'jump';systems:SystemInfo[];value:LocalAvoid;onChange:(value:LocalAvoid)=>void;onToggle:(id:number)=>void;error:string}){
  const [query,setQuery]=useState(''),[addText,setAddText]=useState(''),[addId,setAddId]=useState<number|null>(null);
  const listed=useMemo(()=>{const byId=new Map(systems.map(s=>[s.id,s]));return value.avoid.map(id=>byId.get(id)??{id,nameZh:String(id),nameEn:String(id),regionId:0,regionName:'未知星系',security:0});},[systems,value.avoid]);
  const search=useMemo(()=>createSystemSearch(listed),[listed]),visible:SystemInfo[]=query.trim()?search.find(query,500):listed;
  const title=mode==='regular'?'常规导航屏蔽列表':'旗舰导航屏蔽列表';
  return <section className="nav-avoid-panel" aria-label={title}>
    <div className="nav-avoid-switches"><button type="button" aria-label="规避入侵星系" aria-pressed={value.avoidIncursions} onClick={()=>onChange({...value,avoidIncursions:!value.avoidIncursions})}>规避入侵星系</button><button type="button" aria-label="规避屏蔽列表" aria-pressed={value.avoidList} onClick={()=>onChange({...value,avoidList:!value.avoidList})}>规避屏蔽列表</button></div>
    <details><summary>{title}<small>{value.avoid.length} 个</small></summary><input type="search" aria-label="搜索屏蔽列表" placeholder="搜索列表：中文 / 拼音 / English" value={query} onChange={e=>setQuery(e.target.value)}/>
      <ul className="nav-blocked-list">{visible.map(s=><li key={s.id}><span>{s.nameZh}</span><button type="button" aria-label={`移除 ${s.nameZh}`} onClick={()=>onToggle(s.id)}>×</button></li>)}</ul>{!visible.length&&<p>{value.avoid.length?'没有匹配的屏蔽星系':'暂无屏蔽星系；可右键星图添加。'}</p>}
      <SystemPicker systems={systems} value={addText} label="添加屏蔽星系" onChange={(text,id)=>{setAddText(text);setAddId(id);}}/><button type="button" className="nav-small-button" disabled={addId===null||value.avoid.includes(addId)} onClick={()=>{if(addId!==null){onToggle(addId);setAddText('');setAddId(null);}}}>加入屏蔽列表</button>
      <p>仅保存在当前浏览器。两种导航的名单及开关独立。关闭规避后保留名单与红色标记。</p>
    </details>{error&&<p role="status" className="nav-error">{error}</p>}
  </section>;
}
