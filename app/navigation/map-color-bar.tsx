"use client";
import {STAR_COLOR_MODES,starColorLegend,starColorNotice,normalizeStarColorMode} from '../../lib/star-map-colors.mjs';
import type {MapEnvironment} from './use-map-environment';

export default function MapColorBar({mode,onChange,environment}:{mode:string;onChange:(mode:string)=>void;environment:MapEnvironment|null}){
  const normalized=normalizeStarColorMode(mode),legend=starColorLegend(normalized),notice=starColorNotice(normalized,environment);
  return <section className="nav-map-colorbar" aria-label="星系配色">
    <label>星系配色<select aria-label="星系配色方式" value={normalizeStarColorMode(mode)} onChange={e=>onChange(normalizeStarColorMode(e.target.value))}>{STAR_COLOR_MODES.map(item=><option key={item.id} value={item.id}>{item.label}</option>)}</select></label>
    <ul className={normalized==='security'?'nav-security-scale':'nav-mode-scale'} aria-label={normalized==='security'?'安全等级颜色图例':'入侵星系颜色图例'}>{legend.map(item=><li key={item.id}><i style={{backgroundColor:item.color}} aria-hidden="true"/>{item.label}</li>)}</ul>
    {notice&&<small role="status">{notice}</small>}
  </section>;
}
