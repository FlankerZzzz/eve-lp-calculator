"use client";
import {useEffect,useLayoutEffect,useMemo,useRef,useState} from 'react';
import {createPortal} from 'react-dom';
import type {PointerEvent as ReactPointerEvent} from 'react';
import {moveWaypoint,waypointSlot} from '../../lib/waypoint-order.mjs';
import type {SystemInfo} from './navigation-types';
import SystemPicker from './system-picker';

export type Waypoint={key:number;text:string;id:number|null};
type VisualDrag={key:number;source:number;target:number;left:number;top:number;width:number;height:number;settling:boolean};
type DragSession=VisualDrag&{pointer:number;startX:number;grabY:number;y:number;x:number;scrollY:number;keys:number[];slots:{top:number;height:number}[]};
type Props={points:Waypoint[];systems:SystemInfo[];onEdit:(key:number,text:string,id:number|null)=>void;onMove:(key:number,target:number)=>void;onRemove:(key:number)=>void;inputLabel?:(index:number,total:number)=>string};

export default function WaypointList({points,systems,onEdit,onMove,onRemove,inputLabel}:Props) {
  const list=useRef<HTMLDivElement>(null),floating=useRef<HTMLDivElement>(null),session=useRef<DragSession|null>(null),frame=useRef<number|null>(null),settle=useRef<Animation|null>(null);
  const offsets=useRef(new Map<number,number>()),animations=useRef(new Map<number,Animation>());
  const [drag,setDrag]=useState<VisualDrag|null>(null),[announcement,setAnnouncement]=useState('');
  const callbacks=useRef({points,onMove});
  useLayoutEffect(()=>{callbacks.current={points,onMove};},[points,onMove]);
  const displayed=useMemo<Waypoint[]>(()=>drag?moveWaypoint(points,drag.key,points[drag.target]?.key):points,[points,drag]);
  const order=displayed.map(p=>p.key).join(',');
  useLayoutEffect(()=>{
    const next=new Map<number,number>(),reduced=window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    list.current?.querySelectorAll<HTMLDivElement>('[data-point-key]').forEach(row=>{
      const key=Number(row.dataset.pointKey),top=row.offsetTop,previous=offsets.current.get(key);next.set(key,top);
      animations.current.get(key)?.cancel();
      if(previous!==undefined&&previous!==top&&key!==drag?.key&&!reduced){const a=row.animate([{transform:`translateY(${previous-top}px)`},{transform:'translateY(0)'}],{duration:210,easing:'cubic-bezier(.2,.8,.2,1)'});animations.current.set(key,a);}
    });for(const [key,a]of animations.current)if(!next.has(key)){a.cancel();animations.current.delete(key);}offsets.current=next;
  },[order,drag?.key]);
  function stop(commit:boolean) {
    const current=session.current;if(!current)return;
    session.current=null;if(frame.current!==null){cancelAnimationFrame(frame.current);frame.current=null;}
    settle.current?.cancel();settle.current=null;
    if(list.current?.hasPointerCapture(current.pointer))list.current.releasePointerCapture(current.pointer);
    document.body.classList.remove('nav-point-sorting');setDrag(null);
    if(commit){const latest=callbacks.current.points;if(latest.map(p=>p.key).join(',')===current.keys.join(',')){callbacks.current.onMove(current.key,current.keys[current.target]);setAnnouncement(`已移动到第 ${current.target+1} 个点位`);}}
    else setAnnouncement('已取消拖动，原顺序保留');
  }
  function preview(current:DragSession) {
    const scroll=window.scrollY-current.scrollY;
    current.target=waypointSlot(current.y-current.grabY+current.height/2,current.slots.map(r=>({top:r.top-scroll,height:r.height})));
    current.top=current.y-current.grabY;
    setDrag({key:current.key,source:current.source,target:current.target,left:current.left+Math.max(-12,Math.min(12,current.x-current.startX))*.35,top:current.top,width:current.width,height:current.height,settling:false});
  }
  function tick() {
    const current=session.current;if(!current||current.settling)return;
    const margin=65,speed=current.y<margin?-Math.ceil((margin-current.y)/5):current.y>window.innerHeight-margin?Math.ceil((current.y-window.innerHeight+margin)/5):0;
    if(speed){const before=window.scrollY;window.scrollBy(0,Math.max(-14,Math.min(14,speed)));if(window.scrollY!==before)preview(current);}
    frame.current=requestAnimationFrame(tick);
  }
  function start(event:ReactPointerEvent<HTMLButtonElement>,point:Waypoint,index:number) {
    if(event.button!==0||session.current||!list.current)return;
    event.preventDefault();(document.activeElement as HTMLElement|null)?.blur();
    const row=event.currentTarget.closest<HTMLElement>('[data-point-key]')!,rect=row.getBoundingClientRect();
    const slots=[...list.current.querySelectorAll<HTMLElement>('[data-point-key]')].map(el=>{const r=el.getBoundingClientRect();return {top:r.top,height:r.height};});
    const current:DragSession={key:point.key,source:index,target:index,left:rect.left,top:rect.top,width:rect.width,height:rect.height,settling:false,pointer:event.pointerId,startX:event.clientX,grabY:event.clientY-rect.top,y:event.clientY,x:event.clientX,scrollY:window.scrollY,keys:points.map(p=>p.key),slots};
    session.current=current;list.current.setPointerCapture(event.pointerId);document.body.classList.add('nav-point-sorting');setAnnouncement(`正在拖动 ${point.text||`点位 ${String.fromCharCode(65+index)}`}，按 Escape 取消`);preview(current);frame.current=requestAnimationFrame(tick);
  }
  function release(event:ReactPointerEvent<HTMLDivElement>) {
    const current=session.current;if(!current||event.pointerId!==current.pointer||current.settling)return;
    current.settling=true;if(frame.current!==null){cancelAnimationFrame(frame.current);frame.current=null;}
    if(list.current?.hasPointerCapture(current.pointer))list.current.releasePointerCapture(current.pointer);
    setDrag(v=>v?{...v,settling:true}:v);
    const target=list.current?.querySelector<HTMLElement>(`[data-point-key="${current.key}"]`),ghost=floating.current;
    if(!target||!ghost||window.matchMedia('(prefers-reduced-motion: reduce)').matches){stop(true);return;}
    const from=ghost.getBoundingClientRect(),to=target.getBoundingClientRect();
    const animation=ghost.animate([{transform:'translate(0,0) scale(1.02)'},{transform:`translate(${to.left-from.left}px,${to.top-from.top}px) scale(1)`}],{duration:170,easing:'cubic-bezier(.2,.8,.2,1)',fill:'forwards'});settle.current=animation;
    animation.finished.then(()=>{if(session.current===current)stop(true);}).catch(()=>{});
  }
  useEffect(()=>{
    const rowAnimations=animations.current;
    const cancel=()=>{if(!session.current)return;session.current=null;if(frame.current!==null)cancelAnimationFrame(frame.current);frame.current=null;settle.current?.cancel();settle.current=null;document.body.classList.remove('nav-point-sorting');setDrag(null);setAnnouncement('已取消拖动，原顺序保留');};
    const key=(e:KeyboardEvent)=>{if(e.key==='Escape')cancel();};
    window.addEventListener('keydown',key);window.addEventListener('blur',cancel);window.addEventListener('resize',cancel);
    return()=>{session.current=null;if(frame.current!==null)cancelAnimationFrame(frame.current);settle.current?.cancel();for(const a of rowAnimations.values())a.cancel();document.body.classList.remove('nav-point-sorting');window.removeEventListener('keydown',key);window.removeEventListener('blur',cancel);window.removeEventListener('resize',cancel);};
  },[]);
  const keys=points.map(p=>p.key).join(',');
  useEffect(()=>{if(session.current&&session.current.keys.join(',')!==keys){session.current=null;if(frame.current!==null)cancelAnimationFrame(frame.current);frame.current=null;settle.current?.cancel();settle.current=null;document.body.classList.remove('nav-point-sorting');setDrag(null);}},[keys]);
  const dragged=drag?points.find(p=>p.key===drag.key):null;
  return <><div ref={list} className={`nav-points ${drag?'is-sorting':''}`} onPointerMove={e=>{const current=session.current;if(!current||current.settling||e.pointerId!==current.pointer)return;current.x=e.clientX;current.y=e.clientY;preview(current);}} onPointerUp={release} onPointerCancel={()=>stop(false)} onLostPointerCapture={()=>{if(session.current&&!session.current.settling)stop(false);}}>
    {displayed.map((point,i)=><div className={`nav-point ${drag?.key===point.key?'is-placeholder':''}`} data-point-key={point.key} key={point.key}>
      <button className="nav-drag" aria-label={`拖动点位 ${String.fromCharCode(65+i)}`} title="按住拖动调整顺序" onPointerDown={e=>start(e,point,points.findIndex(p=>p.key===point.key))} disabled={!!drag}>⠿</button>
      <div className="nav-point-body"><label><span>{String.fromCharCode(65+i)}</span>{i===0?'起点':i===points.length-1?'终点':`途经点 ${i}`}</label><SystemPicker systems={systems} label={inputLabel?.(i,points.length)??`点位 ${String.fromCharCode(65+i)}`} value={point.text} onChange={(text,id)=>onEdit(point.key,text,id)} disabled={!!drag}/></div>
      <div className="nav-point-actions"><button disabled={i===0||!!drag} aria-label={`上移点位 ${String.fromCharCode(65+i)}`} onClick={()=>onMove(point.key,points[i-1].key)}>↑</button><button disabled={i===points.length-1||!!drag} aria-label={`下移点位 ${String.fromCharCode(65+i)}`} onClick={()=>onMove(point.key,points[i+1].key)}>↓</button>{points.length>2&&<button disabled={!!drag} aria-label={`删除点位 ${String.fromCharCode(65+i)}`} onClick={()=>onRemove(point.key)}>×</button>}</div>
    </div>)}
  </div><span className="nav-sort-status" role="status" aria-live="polite">{announcement}</span>
    {drag&&dragged&&createPortal(<div ref={floating} className={`nav-drag-preview ${drag.settling?'settling':''}`} style={{left:drag.left,top:drag.top,width:drag.width,height:drag.height}} aria-hidden="true"><span className="nav-drag">⠿</span><div className="nav-point-body"><label><span>{String.fromCharCode(65+drag.source)}</span>移动点位</label><div className="nav-drag-value">{dragged.text||'尚未选择星系'}</div></div><span className="nav-drag-lift">↕</span></div>,document.body)}
  </>;
}
