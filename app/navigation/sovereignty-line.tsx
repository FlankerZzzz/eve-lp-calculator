/* eslint-disable @next/next/no-img-element -- same-origin cached entity icons include SVG fallbacks. */
import type {MapEnvironment} from './use-map-environment';
import {sovereigntyForSystem,sovereigntySummary,SOVEREIGNTY_ICON_FALLBACK} from '../../lib/navigation-sovereignty.mjs';
export default function SovereigntyLine({systemId,environment}:{systemId:number;environment:MapEnvironment|null}){
  const owner=sovereigntyForSystem(systemId,environment);
  const summary=sovereigntySummary(owner);
  return <div className="nav-sovereignty" data-owner-kind={owner.kind} title={summary.title}><span>{summary.text}</span>{owner.icon&&<img key={owner.icon} src={owner.icon} width={44} height={44} alt={`${owner.name}徽标`} loading="eager" decoding="async" style={{backgroundImage:`url("${SOVEREIGNTY_ICON_FALLBACK}")`}} onLoad={event=>{event.currentTarget.style.backgroundImage='none';}} onError={event=>{if(event.currentTarget.src!==SOVEREIGNTY_ICON_FALLBACK)event.currentTarget.src=SOVEREIGNTY_ICON_FALLBACK;}}/>}</div>;
}
