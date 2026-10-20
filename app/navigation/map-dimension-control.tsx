"use client";

export default function MapDimensionControl({value,onChange}:{value:'2d'|'3d';onChange:(value:'2d'|'3d')=>void}){
  return <label className="nav-map-mode-control"><span>星图模式</span><select aria-label="星图显示模式" value={value} onChange={event=>onChange(event.target.value as '2d'|'3d')}><option value="3d">三维</option><option value="2d">纯二维</option></select></label>;
}
