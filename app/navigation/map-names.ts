import {Vector3} from 'three';
import type {Camera} from 'three';
import type {StarSystem} from './star-map';
import {mapPosition} from '../../lib/star-map-view.mjs';
import {layoutMapNames,mapGeography,nameTierWeights} from '../../lib/star-map-presentation.mjs';
type Name={key:string;kind:string;name:string;position:number[];systemId?:number};
type Visible={node:HTMLSpanElement;opacity:number;goal:number};
export function createMapNames(host:HTMLElement,systems:StarSystem[],dimension:'2d'|'3d'){
  const root=document.createElement('div');root.className='nav-geography-labels';root.setAttribute('aria-hidden','true');host.appendChild(root);
  const names:Name[]=[...mapGeography(systems,dimension).map(g=>({...g,key:`${g.kind}:${g.id}`})),...systems.map(s=>({key:`system:${s.id}`,kind:'system',name:s.nameZh,position:mapPosition(s,dimension),systemId:s.id}))];
  const visible=new Map<string,Visible>(),v=new Vector3();let selected:number|null=null,lastTime=performance.now();
  return {select(id:number|null){selected=id;},update(camera:Camera,distance:number,hidden:boolean,excluded:Set<number>,blockedIds:number[]=[]){
    const width=host.clientWidth,height=host.clientHeight,weights=nameTierWeights(distance*2*Math.tan(24*Math.PI/180));
    const rect=host.getBoundingClientRect(),stage=host.closest('.nav-map-stage');
    const blocked=[...(stage?.querySelectorAll<HTMLElement>('.nav-map-heading,.nav-map-compass,.nav-system-card,.nav-focus-summary,.jump-map-legend')??[])].map(el=>{const r=el.getBoundingClientRect();return {x:r.left-rect.left,y:r.top-rect.top,width:r.width,height:r.height};});
    const candidates=[];
    if(!hidden)for(const n of names){
      if(n.systemId&&excluded.has(n.systemId))continue;
      const picked=n.systemId===selected,opacity=picked?.98:weights[n.kind as keyof typeof weights];if(opacity<.03)continue;
      v.fromArray(n.position).project(camera);if(v.z< -1||v.z>1)continue;
      const px=(v.x+1)*width/2,py=(1-v.y)*height/2;if(px<0||px>width||py<0||py>height)continue;
      const size=n.kind==='region'?16:n.kind==='constellation'?13:11;
      const textWidth=[...n.name].reduce((w,c)=>w+(c.charCodeAt(0)>255?1:.6)*size,0)+12;
      candidates.push({...n,opacity,width:textWidth,height:size+10,x:n.kind==='system'?px+10:px-textWidth/2,y:n.kind==='system'?py-12:py-(size+10)/2,priority:picked?-10:(n.kind==='region'?0:n.kind==='constellation'?1:2)+Math.hypot(px-width/2,py-height/2)/Math.max(width,height)});
    }
    for(const entry of visible.values())entry.goal=0;
    const placed=layoutMapNames(candidates,width,height,blocked);
    for(const n of placed){
      let entry=visible.get(n.key);
      if(!entry){const node=document.createElement('span');node.className=`nav-geography-name nav-geography-${n.kind}`;node.dataset.nameKind=n.kind;node.dataset.nameKey=n.key;node.textContent=n.name;node.style.opacity='0';root.appendChild(node);entry={node,opacity:0,goal:0};visible.set(n.key,entry);}
      entry.node.classList.toggle('is-blocked',!!n.systemId&&blockedIds.includes(n.systemId));entry.goal=n.opacity;entry.node.style.transform=`translate(${n.x.toFixed(1)}px,${n.y.toFixed(1)}px)`;entry.node.style.width=`${n.width}px`;
    }
    host.dataset.nameLevel=weights.system>.55?'system':weights.constellation>.3?'constellation':'region';
    host.dataset.mapNameCount=String(placed.length);
  },tick(now:number,reduced:boolean){
    const step=reduced?1:Math.min(1,(now-lastTime)/220);lastTime=now;let fading=false;
    for(const [key,entry]of visible){
      const difference=entry.goal-entry.opacity;
      if(Math.abs(difference)>.008){entry.opacity+=Math.sign(difference)*Math.min(Math.abs(difference),step);fading=true;entry.node.style.opacity=String(entry.opacity);}else if(entry.opacity!==entry.goal){entry.opacity=entry.goal;entry.node.style.opacity=String(entry.opacity);}
      if(!entry.goal&&entry.opacity<.008){entry.node.remove();visible.delete(key);}
    }
    return fading;
  },dispose(){visible.clear();root.remove();}};
}
