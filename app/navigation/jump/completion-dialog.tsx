"use client";
import {useEffect,useId,useRef} from 'react';

export default function JumpCompletionDialog({onDismiss,onViewRoute}:{onDismiss:()=>void;onViewRoute:()=>void}){
  const dialog=useRef<HTMLDialogElement>(null),close=useRef<HTMLButtonElement>(null),title=useId(),description=useId();
  useEffect(()=>{const element=dialog.current!;element.showModal();close.current?.focus();return()=>element.close();},[]);
  return <dialog className="jump-direct-dialog jump-completion-dialog" ref={dialog} aria-labelledby={title} aria-describedby={description} onCancel={e=>{e.preventDefault();onDismiss();}}>
    <span className="nav-eyebrow">ROUTE COMPLETE</span><h2 id={title}>路线已完成</h2>
    <p id={description}>路线已完成，请在下方复制路径。</p>
    <small>这是一份导航规划，不会执行游戏内跳跃。</small>
    <footer><button type="button" ref={close} onClick={onDismiss}>关闭</button><button type="button" onClick={onViewRoute}>前往复制路径</button></footer>
  </dialog>;
}
