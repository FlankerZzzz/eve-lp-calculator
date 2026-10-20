import type {Camera} from 'three';
import {compassDirections,mapViewLabel,MAP_VIEWS} from '../../lib/star-map-orientation.mjs';

// One small SVG, updated with the existing dirty-frame render. No extra WebGL
// context or React state update on every camera movement.
export function createMapCompass(onView:(view:keyof typeof MAP_VIEWS)=>void,dimension:'2d'|'3d',onClearCalculation?:()=>void){
  const root=document.createElement('div');root.className='nav-map-compass';
  root.setAttribute('role','group');root.setAttribute('aria-label','星图方向与视角');
  root.title='星图方向约定：SDE +X 为东，+Z 为北，+Y 为上。方向标随相机旋转；回正恢复俯视、正北朝上及默认全图视野，聚焦分析时适配完整路线。';
  const svg=document.createElementNS('http://www.w3.org/2000/svg','svg');svg.setAttribute('viewBox','0 0 120 116');svg.setAttribute('aria-hidden','true');
  const label=document.createElement('span');label.className='nav-compass-view';
  const buttons=document.createElement('div');buttons.className='nav-compass-buttons';
  for(const [key,view] of Object.entries(MAP_VIEWS)){
    const button=document.createElement('button');button.type='button';button.textContent=view.name;
    button.title='恢复俯视、正北朝上及默认缩放；聚焦分析时适配完整路线';
    button.setAttribute('aria-label',`星图${view.name}`);button.onclick=()=>onView(key as keyof typeof MAP_VIEWS);buttons.appendChild(button);
  }
  const clear=onClearCalculation?document.createElement('button'):null;
  if(clear){
    clear.type='button';clear.textContent='清除计算';clear.disabled=true;
    clear.title='清空起点、途经点、终点、路线及小工具计算，不改变当前视角';
    clear.onclick=()=>onClearCalculation?.();buttons.appendChild(clear);
  }
  root.append(svg,label,buttons);
  const nodes=new Map<string,{group:SVGGElement;line:SVGLineElement;text:SVGTextElement}>();
  return {element:root,setCalculation(active:boolean,label='清除计算'){if(clear){clear.disabled=!active;clear.textContent=label;}},update(camera:Camera,offset:number[]){
    for(const d of compassDirections(camera.quaternion.toArray())){
      if(dimension==='2d'&&(d.name==='上'||d.name==='下'))continue;
      let node=nodes.get(d.name);
      if(!node){
        const group=document.createElementNS(svg.namespaceURI,'g') as SVGGElement;
        const line=document.createElementNS(svg.namespaceURI,'line') as SVGLineElement;
        const text=document.createElementNS(svg.namespaceURI,'text') as SVGTextElement;
        line.setAttribute('x1','60');line.setAttribute('y1','58');line.setAttribute('stroke',d.color);
        text.textContent=d.name;text.setAttribute('fill',d.color);text.setAttribute('text-anchor','middle');text.setAttribute('dominant-baseline','central');
        group.append(line,text);node={group,line,text};nodes.set(d.name,node);
      }
      // Face-on opposite axes project onto the same center; separate their
      // labels so top/bottom or north/south remain readable in preset views.
      const axial=Math.hypot(d.x,d.y)<.22;
      const x=axial?(d.depth>0?48:72):60+d.x*43,y=axial?58:58+d.y*43;
      node.line.setAttribute('x2',String(60+d.x*31));node.line.setAttribute('y2',String(58+d.y*31));
      node.text.setAttribute('x',String(x));node.text.setAttribute('y',String(y));
      node.group.setAttribute('opacity',String(d.depth<-.05?.4:1));
      node.group.dataset.direction=d.name;node.group.dataset.depth=d.depth.toFixed(3);
      svg.appendChild(node.group);
    }
    label.textContent=dimension==='2d'?'二维 · 正北朝上':mapViewLabel(offset);
  },dispose(){root.remove();}};
}
