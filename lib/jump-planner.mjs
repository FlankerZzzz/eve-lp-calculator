import {distanceLightyears,securityBand} from './star-map.mjs';
import {findGateRoute} from './navigation.mjs';
export function shipParameters(ship,{calibration=5,conservation=5,shipSkill=5}={}) {
  for(const n of [calibration,conservation,shipSkill])if(!Number.isInteger(n)||n<0||n>5)throw new Error('技能等级必须为 0～5');
  if(!ship||!Number.isFinite(ship.baseRange)||ship.baseRange<=0||!Number.isFinite(ship.baseFuel)||ship.baseFuel<=0)throw new Error('舰船基础数据无效');
  const bonus=ship.shipFuelBonus===undefined?0:ship.shipFuelBonus;
  if(!Number.isFinite(bonus)||1+bonus*5/100<=0)throw new Error('舰船耗油加成无效');
  const range=ship.baseRange*(1+.2*calibration),fuelPerLy=ship.baseFuel*(1-.1*conservation)*(1+bonus*shipSkill/100);
  if(!Number.isFinite(range)||range<=0||!Number.isFinite(fuelPerLy)||fuelPerLy<=0)throw new Error('航程或耗油计算结果无效');
  return {range,fuelPerLy};
}
/** @param {{planned?:boolean,dirty?:boolean,endpointIssues?:string[],legs?:{issues:string[]}[],arrived?:boolean}} [input] */
export function routePlanState({planned=false,dirty=false,endpointIssues=[],legs=[],arrived=false}={}) {
  if(!planned)return {kind:'unplanned',issues:[]};
  if(dirty)return {kind:'dirty',issues:['点位已修改，请重新开始；当前展示旧规划。']};
  const issues=[...new Set([...endpointIssues,...legs.flatMap(l=>l.issues)])];
  if(issues.length)return {kind:'invalid',issues};
  return {kind:arrived?'complete':'incomplete',issues:[]};
}
export function canEnterHighsec(ship){return [898,902,4622].includes(ship.groupId)||ship.id===76009;}
export function rangeSystems(graph,origin,range,blocked=new Set()) {
  if(!graph.systems.has(origin)||blocked.has(origin)||!Number.isFinite(range)||range<=0)return [];
  const from=graph.systems.get(origin);
  return [...graph.systems.values()].filter(s=>s.id!==origin&&!blocked.has(s.id)&&securityBand(s.security)!=='high')
    .map(s=>({id:s.id,distance:distanceLightyears(from,s)})).filter(s=>s.distance<=range)
    .sort((a,b)=>a.distance-b.distance||a.id-b.id);
}
export function nearbyLandings(graph,destination,limit=5,blocked=new Set()) {
  if(!graph.systems.has(destination)||blocked.has(destination))return [];
  const hops=new Map([[destination,0]]),queue=[destination];
  for(let i=0;i<queue.length;i++)for(const next of graph.adjacent.get(queue[i])??[])if(!blocked.has(next)&&!hops.has(next)){hops.set(next,hops.get(queue[i])+1);queue.push(next);}
  return [...hops].filter(([id])=>id!==destination&&securityBand(graph.systems.get(id).security)!=='high')
    .map(([id,hops])=>({id,hops})).sort((a,b)=>a.hops-b.hops||a.id-b.id).slice(0,limit);
}
export function planEndpointIssues(graph,ids,ship,blocked=new Set()) {
  if(!ship)return ['请选择舰船'];
  const unknown=ids.filter(id=>!graph.systems.has(id));if(unknown.length)return ['请选择有效星系'];
  const denied=[...new Set(ids)].filter(id=>blocked.has(id));if(denied.length)return [`星系已被规避：${denied.map(id=>graph.systems.get(id).nameZh).join('、')}`];
  if(canEnterHighsec(ship))return [];
  const high=[...new Set(ids)].filter(id=>securityBand(graph.systems.get(id).security)==='high');
  return high.length?[`所选舰船不能进入高安：${high.map(id=>graph.systems.get(id).nameZh).join('、')}`]:[];
}
// Consume checkpoints in the user's order, including systems crossed by gate legs.
// Repeated systems in separate checkpoints require a later visit, not one shared match.
export function checkpointProgress(origin,legs,waypoints=[]) {
  const visited=[origin,...legs.flatMap(leg=>leg.ids.slice(1))];
  let completed=0;
  for(const id of visited)if(completed<waypoints.length&&id===waypoints[completed])completed++;
  return {completed,remaining:waypoints.slice(completed)};
}
export function makePlanLeg(graph,from,to,kind,mode='shortest',ship,skills={},avoid=new Set()) {
  if(!graph.systems.has(from)||!graph.systems.has(to))throw new Error('请选择有效星系');
  if(from===to)throw new Error('当前已在这个星系');
  if(!['jump','gate'].includes(kind))throw new Error('未知路段类型');
  const endpoints=planEndpointIssues(graph,[from,to],ship,avoid);if(endpoints.length)throw new Error(endpoints.join('；'));
  const blocked=new Set([...avoid,...(!canEnterHighsec(ship)?[...graph.systems.values()].filter(s=>securityBand(s.security)==='high').map(s=>s.id):[])]);
  const ids=kind==='jump'?[from,to]:findGateRoute(graph,from,to,mode,blocked);
  if(!ids)throw new Error('没有符合该舰船限制的连通星门路径');
  const leg={from,to,kind,ids},checked=inspectLeg(graph,leg,ship,skills,avoid);
  if(checked.issues.length)throw new Error(checked.issues.join('；'));
  return leg;
}
export function nextPlanActions(graph,from,to,ship,skills,mode='shortest',blocked=new Set()) {
  const check=kind=>{try{return {leg:makePlanLeg(graph,from,to,kind,mode,ship,skills,blocked),error:''};}catch(error){return {leg:null,error:error.message};}};
  return {jump:check('jump'),gate:check('gate')};
}
// A completion suggestion is still a normal, strictly validated jump. It may
// consume a final checkpoint at B, but must never skip earlier checkpoints.
export function directDestinationLeg(graph,plan,legs,ship,skills,{dirty=false,blocked=new Set()}={}) {
  if(!graph||!plan||!ship||dirty||!plan.automatic&&!plan.autoContinuation&&legs.length>=30)return null;
  try{
    if(planEndpointIssues(graph,[plan.origin,...plan.waypoints,plan.destination],ship,blocked).length)return null;
    if(legs.some(l=>inspectLeg(graph,l,ship,skills,blocked).issues.length))return null;
    const current=legs.at(-1)?.to??plan.origin;
    if(current===plan.destination)return null;
    const leg=makePlanLeg(graph,current,plan.destination,'jump','shortest',ship,skills,blocked);
    if(checkpointProgress(plan.origin,[...legs,leg],plan.waypoints).remaining.length)return null;
    return inspectLeg(graph,leg,ship,skills,blocked);
  }catch{return null;}
}
/** @returns {{kind:string,label:string,message:string,color:string,distance:number|null,range:number|null,gap:number|null,leg:null|{from:number,to:number,kind:string,ids:number[],distance:number,fuel:number,gates:number,issues:string[]}}} */
export function destinationJumpStatus(graph,plan,legs,ship,skills,{dirty=false,blocked=new Set()}={}) {
  const base={distance:null,range:null,gap:null,leg:null};
  const result=(kind,label,message,color,values={})=>({...base,kind,label,message,color,...values});
  if(!graph||!plan||!ship)return result('unplanned','尚未规划','请先选择起终点并开始规划。','#9ab4c1');
  try{
    const current=legs.at(-1)?.to??plan.origin,{range}=shipParameters(ship,skills);
    const distance=distanceLightyears(graph.systems.get(current),graph.systems.get(plan.destination));
    const values={distance,range,gap:Math.max(0,distance-range)};
    if(dirty)return result('dirty','点位待重算','当前展示旧规划，请重新开始。','#e5bd89',values);
    const issues=[...planEndpointIssues(graph,[plan.origin,...plan.waypoints,plan.destination],ship,blocked),...legs.flatMap(l=>inspectLeg(graph,l,ship,skills,blocked).issues)];
    if(issues.length)return result('blocked','旧规划需修复',issues.join('；'),'#ff9c82',values);
    const remaining=checkpointProgress(plan.origin,legs,plan.waypoints).remaining;
    if(current===plan.destination)return remaining.length?result('pending','途经点未完成','已到达终点，但仍有途经点尚未按顺序经过。','#e5bd89',values):result('complete','路线已完成','请在下方复制路径。','#8df5cf',values);
    if(securityBand(graph.systems.get(plan.destination).security)==='high')return result('gate-only','终点须过门抵达','终点为高安，不能直接旗舰跳入，请通过星门抵达。','#e5bd89',values);
    if(distance>range)return result('out-of-range','超过跳跃航程','终点不能由当前点直接起跳，请继续选择中转点或经星门移动。','#ff9c82',values);
    if(!plan.automatic&&!plan.autoContinuation&&legs.length>=30)return result('blocked','路段已达上限','Demo 最多保留 30 个手动路段。','#e5bd89',values);
    try{makePlanLeg(graph,current,plan.destination,'jump','shortest',ship,skills,blocked);}catch(error){return result('blocked','不可直接跳跃',error.message,'#ff9c82',values);}
    const leg=directDestinationLeg(graph,plan,legs,ship,skills,{blocked});
    if(!leg)return result('pending','途经点未完成','终点在跳跃范围内，但不能跳过尚未按顺序经过的途经点。','#e5bd89',values);
    return result('direct','可一跳直达','可以从当前点直接跳至终点；确认后才会追加最后一跳。','#8df5cf',{...values,leg});
  }catch{return result('blocked','无法判定','基础数据异常，请重新加载后规划。','#ff9c82');}
}
export function formatJumpRoute(graph,origin,legs) {
  const name=id=>{const s=graph.systems.get(id);if(!s)throw new Error('路线包含未知星系');return s.nameZh;};
  const lines=[`起点：${name(origin)}`];
  for(const [i,leg]of legs.entries())lines.push(`${i+1}. ${leg.kind==='jump'?'旗舰跳':`星门（${leg.ids.length-1} 跳）`}：${leg.ids.map(name).join(' → ')}`);
  lines.push(`终点：${name(legs.at(-1)?.to??origin)}`);
  return lines.join('\n');
}
export function inspectLeg(graph,leg,ship,skills,blocked=new Set()) {
  const {range,fuelPerLy}=shipParameters(ship,skills),issues=[];
  const a=graph.systems.get(leg.from),b=graph.systems.get(leg.to);
  if(!a||!b)throw new Error('路线包含未知星系');
  const distance=distanceLightyears(a,b);
  if(leg.ids.some(id=>blocked.has(id)))issues.push('路段经过已规避星系');
  if(leg.kind==='jump') {
    if(distance>range)issues.push('超过跳跃范围');
    if(securityBand(b.security)==='high')issues.push('旗舰跳落点为高安');
    if(b.regionId===10000070||a.regionId===10000070)issues.push('涉及波赫文，不能作为普通旗舰跳路段');
  }
  if(!canEnterHighsec(ship)&&leg.ids.some(id=>securityBand(graph.systems.get(id).security)==='high'))issues.push('所选舰船不能进入高安');
  const fuel=leg.kind==='jump'?Math.ceil(distance*fuelPerLy):0;
  if(!Number.isFinite(distance)||distance<0||!Number.isSafeInteger(fuel)||fuel<0)throw new Error('距离或燃料计算结果无效');
  return {...leg,distance,fuel,gates:leg.kind==='gate'?leg.ids.length-1:0,issues};
}
