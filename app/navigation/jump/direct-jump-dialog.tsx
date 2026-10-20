"use client";
import {useEffect,useId,useRef} from 'react';

export default function DirectJumpDialog({from,to,distance,range,fuel,fuelName,onAccept,onDecline}:{from:string;to:string;distance:number;range:number;fuel:number;fuelName:string;onAccept:()=>void;onDecline:()=>void}){
  const dialog=useRef<HTMLDialogElement>(null),cancel=useRef<HTMLButtonElement>(null),title=useId(),description=useId();
  useEffect(()=>{const element=dialog.current!;element.showModal();cancel.current?.focus();return()=>element.close();},[]);
  return <dialog className="jump-direct-dialog" ref={dialog} aria-labelledby={title} aria-describedby={description} onCancel={e=>{e.preventDefault();onDecline();}}>
    <span className="nav-eyebrow">DESTINATION IN RANGE</span><h2 id={title}>可以直达目的地</h2>
    <p id={description}>终点 <b>{to}</b> 已位于当前路径点 <b>{from}</b> 的可跳跃范围内，是否完成该跳跃线路？</p>
    <dl><div><dt>本次跳距 / 航程</dt><dd>{distance.toLocaleString('zh-CN',{maximumFractionDigits:4})} / {range.toLocaleString('zh-CN',{maximumFractionDigits:2})} 光年</dd></div><div><dt>预计燃料</dt><dd>{fuel.toLocaleString('zh-CN')} {fuelName}</dd></div></dl>
    <small>同意后会把这一跳追加到规划，不执行游戏内操作。诱导、权限及停靠条件仍需自行核对。</small>
    <footer><button type="button" ref={cancel} onClick={onDecline}>放弃</button><button type="button" onClick={onAccept}>同意完成</button></footer>
  </dialog>;
}
