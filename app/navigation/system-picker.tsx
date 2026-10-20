"use client";
import {useId,useMemo,useState} from 'react';
import {createSystemSearch} from '../../lib/system-search.mjs';
import type {SystemInfo} from './navigation-types';
export default function SystemPicker({systems,value,onChange,onPick,label,placeholder='中文 / 拼音 / English / ID',disabled=false}:{systems:SystemInfo[];value:string;onChange:(text:string,id:number|null)=>void;onPick?:(system:SystemInfo)=>void;label:string;placeholder?:string;disabled?:boolean}) {
  const [open,setOpen]=useState(false),[active,setActive]=useState(0);const listId=useId();
  const query=value.trim(),search=useMemo(()=>createSystemSearch(systems),[systems]);
  const matches:SystemInfo[]=useMemo(()=>search.find(query),[search,query]);
  function choose(s:SystemInfo){onChange(s.nameZh,s.id);onPick?.(s);setOpen(false);setActive(0);}
  return <div className="nav-picker" onBlur={e=>{if(!e.currentTarget.contains(e.relatedTarget))setOpen(false);}}>
    <input disabled={disabled} aria-label={label} role="combobox" aria-expanded={open&&!!query} aria-controls={listId} aria-autocomplete="list" aria-activedescendant={open&&matches[active]?`${listId}-${active}`:undefined} value={value} placeholder={placeholder} autoComplete="off" onFocus={()=>setOpen(true)} onChange={e=>{const text=e.target.value,s=search.exact(text);onChange(text,s?.id??null);setOpen(true);setActive(0);}} onKeyDown={e=>{if(e.nativeEvent.isComposing)return;if(e.key==='Escape')setOpen(false);if(e.key==='ArrowDown'){e.preventDefault();setOpen(true);setActive(i=>Math.max(0,Math.min(i+1,matches.length-1)));}if(e.key==='ArrowUp'){e.preventDefault();setActive(i=>Math.max(0,i-1));}if(e.key==='Enter'&&open&&matches[active]){e.preventDefault();choose(matches[active]);}}}/>
    {open&&query&&<div id={listId} className="nav-picker-results" role="listbox" aria-label="匹配星系">{matches.map((s,i)=><button type="button" role="option" aria-selected={i===active} id={`${listId}-${i}`} key={s.id} onMouseDown={e=>e.preventDefault()} onClick={()=>choose(s)}><b>{s.nameZh}</b><small>{s.nameEn} · {s.regionName} · {s.security>=.45?'高安':s.security>0?'低安':'00'}</small></button>)}{!matches.length&&<p>未找到星系，请检查名称或 ID</p>}</div>}
  </div>;
}
