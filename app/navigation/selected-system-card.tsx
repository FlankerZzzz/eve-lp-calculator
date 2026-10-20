import type {ReactNode} from 'react';
import type {StarSystem} from './star-map';
import type {MapEnvironment} from './use-map-environment';
import SovereigntyLine from './sovereignty-line';
import {securityTextStyle} from '../../lib/star-map-colors.mjs';
import {starHoverEnvironment,npcStationLabel,RECENT_GEOGRAPHY_TITLE} from '../../lib/star-hover-environment.mjs';

export default function SelectedSystemCard({system,environment,onClose,children,blocked=false}:{system:StarSystem;environment:MapEnvironment|null;onClose:()=>void;children:ReactNode;blocked?:boolean}){
  const view=starHoverEnvironment(system.id,environment),security=Math.max(system.security>0?.1:-1,Math.round(system.security*10)/10).toFixed(1);
  return <section className="nav-system-card nav-selected-system" role="region" aria-label="选中星系信息" data-system-id={system.id} data-invasion={view.invasion===null?'unknown':String(view.invasion)}>
    <header className="nav-selected-heading"><div>{view.invasion===true&&<span className="nav-tooltip-invasion">警告：入侵星系</span>}<h2 className={blocked?'is-blocked':''}>{system.nameZh}</h2><span className="nav-system-security" style={securityTextStyle(system.security)}>{security}</span></div><SovereigntyLine systemId={system.id} environment={environment}/><button aria-label="关闭星系详情" onClick={onClose}>×</button></header>
    <p className="nav-selected-location">{system.regionName}{system.constellationName&&` · ${system.constellationName}`}</p>
    <p className="nav-selected-stations" title="SDE 基线，未与晨曦全量核实；站点数不是一小时活动统计。">NPC空间站：<b>{npcStationLabel(system)}</b></p>
    <p className="nav-selected-invasion">{view.status}</p>
    <h3 title={`过门 ${view.jumpsWindow}；击毁 ${view.killsWindow}（北京时间）`}>{RECENT_GEOGRAPHY_TITLE}</h3>
    <dl className="nav-selected-metrics">{view.metrics.map(metric=><div key={metric.key} data-metric={metric.key}><dt>{metric.label}</dt><dd>{metric.value}{metric.stale?' *':''}</dd></div>)}</dl>
    {view.statisticsStale&&<p className="nav-selected-quality">* 旧数据 / 获取异常</p>}{view.statisticsUnavailable&&<p className="nav-selected-quality">统计暂不可用（— 不代表 0）</p>}
    <div className="nav-card-actions">{children}</div>
  </section>;
}
