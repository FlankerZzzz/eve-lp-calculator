"use client";
import {useEffect,useId,useRef} from 'react';

export default function JumpValidationDialog({message,onConfirm}:{message:string;onConfirm:()=>void}){
  const dialog=useRef<HTMLDialogElement>(null),confirm=useRef<HTMLButtonElement>(null),title=useId(),description=useId();
  useEffect(()=>{const element=dialog.current!;element.showModal();confirm.current?.focus();return()=>element.close();},[]);
  return <dialog className="jump-direct-dialog jump-validation-dialog" ref={dialog} role="alertdialog" aria-labelledby={title} aria-describedby={description} onCancel={event=>event.preventDefault()}>
    <h2 id={title}>无法执行此操作</h2>
    <p id={description}>{message}</p>
    <footer><button type="button" ref={confirm} onClick={onConfirm}>确认</button></footer>
  </dialog>;
}
