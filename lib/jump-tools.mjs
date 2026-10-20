import {distanceLightyears} from './star-map.mjs';
import {inspectLeg,planEndpointIssues,shipParameters} from './jump-planner.mjs';
import {autoRouteIssues,autoStationIssues} from './jump-auto-planner.mjs';
import {normalizeSystemQuery,systemSearchKeys} from './system-search.mjs';

function systemAt(graph,id){
  const system=graph?.systems?.get(id);
  if(!system)throw new Error('请选择有效星系');
  if(![system.x,system.y,system.z].every(Number.isFinite))throw new Error('星系坐标无效');
  return system;
}

// Measurement is geometry only: highsec, Pochven and avoidance do not change it.
export function measureSystemDistance(graph,from,to){
  const distance=distanceLightyears(systemAt(graph,from),systemAt(graph,to));
  if(!Number.isFinite(distance))throw new Error('星系距离计算结果无效');
  return {from,to,distance};
}

// Exploration retention is purely geometric, not membership in legal landings.
export function isWithinJumpReach(graph,query,id){
  if(!query||!Number.isFinite(query.range)||query.range<=0)return false;
  try{return measureSystemDistance(graph,query.origin,id).distance<=query.range;}
  catch{return false;}
}

// Never sort a cached result in place. Distance ties always use stable IDs.
export function sortJumpReach(rows,direction='asc'){
  if(!['asc','desc'].includes(direction))throw new Error('未知距离排序方式');
  return [...rows].sort((a,b)=>(direction==='asc'?a.distance-b.distance:b.distance-a.distance)||a.id-b.id);
}

// Filter the displayed list only; retain its distance ordering and all matches.
export function filterJumpReach(graph,rows,query=''){
  const key=normalizeSystemQuery(query);
  return rows.filter(row=>!key||systemSearchKeys(systemAt(graph,row.id)).some(name=>name.includes(key)));
}

export function formatJumpReachList(graph,rows,direction='asc'){
  return sortJumpReach(rows,direction).map((row,index)=>{
    const system=systemAt(graph,row.id);
    const distance=row.distance>0&&row.distance<.0001?'<0.0001':row.distance.toLocaleString('zh-CN',{maximumFractionDigits:4});
    return `${index+1}. ${system.nameZh} / ${system.nameEn} · ${distance} 光年`;
  }).join('\n');
}

/**
 * One legal jump, not gate reachability or a new route plan. All coordinates are
 * real 3D metres, even when the display projects them onto a 2D map.
 * @param {*} graph
 * @param {number} origin
 * @param {*} ship
 * @param {*} [skills]
 * @param {{blocked?:Set<number>,incursions?:any,avoidIncursions?:boolean,npcStationsOnly?:boolean,stations?:any,now?:number}} [options]
 */
export function oneJumpReach(graph,origin,ship,skills={},options={}){
  const {blocked=new Set(),incursions=null,avoidIncursions=false,npcStationsOnly=false,stations={},now=Date.now()}=options;
  const from=systemAt(graph,origin),parameters=shipParameters(ship,skills);
  const originIssues=[...planEndpointIssues(graph,[origin],ship,blocked),...autoRouteIssues(graph,{ids:[origin]},incursions,avoidIncursions,now)];
  if(from.regionId===10000070)originIssues.push('波赫文星系不能作为普通旗舰跳起点');
  if(originIssues.length)throw new Error(originIssues.join('；'));
  const denied=new Set(blocked);
  if(avoidIncursions)for(const id of incursions.ids)denied.add(id);
  const rows=[];
  for(const to of graph.systems.values()){
    if(to.id===origin||denied.has(to.id))continue;
    const {distance}=measureSystemDistance(graph,origin,to.id);
    if(distance>parameters.range)continue;
    const leg={from:origin,to:to.id,kind:'jump',ids:[origin,to.id]};
    const checked=inspectLeg(graph,leg,ship,skills,denied);
    if(checked.issues.length||autoStationIssues(graph,leg,stations,npcStationsOnly).length)continue;
    rows.push({id:to.id,distance:checked.distance,fuel:checked.fuel});
  }
  return {origin,...parameters,rows:sortJumpReach(rows)};
}
