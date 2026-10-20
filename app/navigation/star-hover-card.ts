import type {StarSystem} from './star-map';
import {starMapColor} from '../../lib/star-map-colors.mjs';
import {hoverCardPosition} from '../../lib/star-map-hover.mjs';
import {starHoverEnvironment,npcStationLabel,RECENT_GEOGRAPHY_TITLE} from '../../lib/star-hover-environment.mjs';
import type {MapEnvironment} from './use-map-environment';
import {sovereigntyForSystem,sovereigntySummary,SOVEREIGNTY_ICON_FALLBACK} from '../../lib/navigation-sovereignty.mjs';

export function createStarHoverCard(container:HTMLElement){
  const card=document.createElement('div');card.className='nav-star-tooltip';card.setAttribute('role','tooltip');card.setAttribute('aria-label','星系悬停信息');card.hidden=true;
  const header=document.createElement('header'),title=document.createElement('div'),warning=document.createElement('span'),name=document.createElement('strong'),security=document.createElement('span');warning.className='nav-tooltip-invasion';warning.textContent='警告：入侵星系';warning.hidden=true;security.className='nav-system-security';title.append(warning,name,security);header.append(title);
  const region=document.createElement('p'),stations=document.createElement('p'),status=document.createElement('div'),metrics=document.createElement('dl'),quality=document.createElement('p'),extra=document.createElement('div');
  stations.className='nav-tooltip-stations';stations.title='SDE 基线，未与晨曦全量核实；站点数不是一小时活动统计。';
  const ownerLine=document.createElement('div'),ownerText=document.createElement('span'),ownerIcon=document.createElement('img');ownerLine.className='nav-sovereignty';ownerIcon.width=32;ownerIcon.height=32;ownerIcon.decoding='async';ownerLine.append(ownerText,ownerIcon);header.append(ownerLine);
  ownerIcon.loading='eager';ownerIcon.onload=()=>{ownerIcon.style.backgroundImage='none';};ownerIcon.onerror=()=>{if(ownerIcon.src!==SOVEREIGNTY_ICON_FALLBACK)ownerIcon.src=SOVEREIGNTY_ICON_FALLBACK;};
  region.className='nav-tooltip-location';status.className='nav-tooltip-status';metrics.className='nav-tooltip-metrics';quality.className='nav-tooltip-quality';extra.className='nav-tooltip-extra';
  card.append(header,region,stations,status,metrics,quality,extra);container.appendChild(card);
  return {
    element:card,
    render(system:StarSystem,details:string[],context:boolean,environment:MapEnvironment|null=null,blocked=false){
      card.dataset.systemId=String(system.id);name.textContent=system.nameZh;
      name.classList.toggle('is-blocked',blocked);
      const owner=sovereigntyForSystem(system.id,environment),summary=sovereigntySummary(owner);ownerLine.dataset.ownerKind=owner.kind;ownerText.textContent=summary.text;ownerLine.title=summary.title;ownerIcon.hidden=!owner.icon;if(owner.icon&&ownerIcon.getAttribute('src')!==owner.icon){ownerIcon.style.backgroundImage=`url("${SOVEREIGNTY_ICON_FALLBACK}")`;ownerIcon.src=owner.icon;}if(!owner.icon)ownerIcon.removeAttribute('src');ownerIcon.alt=owner.name?`${owner.name}徽标`:'';
      const view=starHoverEnvironment(system.id,environment);warning.hidden=view.invasion!==true;card.dataset.invasion=view.invasion===null?'unknown':String(view.invasion);
      security.textContent=Math.max(system.security>0?.1:-1,Math.round(system.security*10)/10).toFixed(1);security.style.color=starMapColor(system);
      region.textContent=`${system.regionName}${system.constellationName?` · ${system.constellationName}`:''}`;
      stations.textContent=`NPC空间站：${npcStationLabel(system)}`;
      const invasion=document.createElement('span'),period=document.createElement('span');invasion.textContent=view.status;period.textContent=RECENT_GEOGRAPHY_TITLE;period.title=`过门 ${view.jumpsWindow}；击毁 ${view.killsWindow}（北京时间）`;status.replaceChildren(invasion,period);
      metrics.replaceChildren(...view.metrics.map(metric=>{const cell=document.createElement('div'),label=document.createElement('dt'),value=document.createElement('dd');label.textContent=metric.label;value.textContent=metric.value+(metric.stale?' *':'');cell.dataset.metric=metric.key;cell.append(label,value);return cell;}));
      quality.hidden=!view.statisticsStale&&!view.statisticsUnavailable;quality.textContent=view.statisticsStale?'* 旧数据 / 获取异常':view.statisticsUnavailable?'统计暂不可用（— 不代表 0）':'';
      extra.replaceChildren(...details.map(text=>{const row=document.createElement('p');row.textContent=text;return row;}));
      card.setAttribute('aria-description',context?'点击选定，右键规划':'点击选定查看操作');
    },
    move(x:number,y:number){
      const rect=container.getBoundingClientRect();
      const bounds={left:Math.max(0,rect.left),top:Math.max(0,rect.top),right:Math.min(window.innerWidth,rect.right),bottom:Math.min(window.innerHeight,rect.bottom)};
      card.style.maxWidth=`${Math.max(0,bounds.right-bounds.left-20)}px`;card.style.maxHeight=`${Math.max(0,bounds.bottom-bounds.top-20)}px`;
      const size=card.getBoundingClientRect(),position=hoverCardPosition({x,y},bounds,size);
      card.style.left=`${position.x-rect.left}px`;card.style.top=`${position.y-rect.top}px`;
    },
    hide(){card.hidden=true;},
    dispose(){card.remove();},
  };
}
