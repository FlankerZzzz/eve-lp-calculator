"use client";
import {useRef,useState} from 'react';

export default function JumpRouteCopy({text}:{text:string}){
  const field=useRef<HTMLTextAreaElement>(null),[message,setMessage]=useState('');
  async function copy(){
    try{if(!navigator.clipboard?.writeText)throw new Error('Clipboard unavailable');await navigator.clipboard.writeText(text);setMessage('路径已复制。');}
    catch{field.current?.focus();field.current?.select();setMessage('无法自动复制，已选中路径文本，请手动复制。');}
  }
  return <section id="jump-route-copy" className="jump-route-copy" aria-label="复制完整路径"><header><div><b>完整路径</b><small>已区分旗舰跳与星门；星门段包含全部途经星系。</small></div><button type="button" onClick={()=>void copy()}>复制路径</button></header><textarea aria-label="完整路线文本" ref={field} value={text} readOnly rows={Math.min(10,text.split('\n').length+1)}/><p role="status">{message}</p></section>;
}
