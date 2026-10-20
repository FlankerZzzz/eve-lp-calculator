import {canEnterHighsec,checkpointProgress,inspectLeg,makePlanLeg,planEndpointIssues,shipParameters} from './jump-planner.mjs';
import {feedIsCurrent} from './star-hover-environment.mjs';
import {distanceLightyears,METRES_PER_LIGHTYEAR,securityBand} from './star-map.mjs';

const INCURSION_MAX_AGE=75*60000;
const incursionError='自动计算需要有效且未过期的入侵名单，请刷新入侵信息后重试。';
const validId=id=>Number.isSafeInteger(id)&&id>0;
const verifiedStations=(stations,id)=>Array.isArray(stations?.[id])&&stations[id].length>0&&stations[id].every(row=>validId(row?.id)&&validId(row?.typeId));
export class AutomaticJumpUnreachableError extends Error{
  constructor(origin,legs){
    super('路径不可达，请自行规划。');
    this.name='AutomaticJumpUnreachableError';this.legs=legs;this.interruptionAt=legs.at(-1)?.to??origin;
  }
}
function currentIncursions(incursions,now){
  return Array.isArray(incursions?.ids)&&incursions.ids.every(validId)&&feedIsCurrent(incursions,INCURSION_MAX_AGE,now);
}

// The shared switch governs ALL visited systems, including gate intermediates.
// The independent NPC landing switch is checked by autoStationIssues.
export function autoRouteIssues(graph,leg,incursions,avoidIncursions=false,now=Date.now()){
  if(!avoidIncursions)return [];
  if(!currentIncursions(incursions,now))return [incursionError];
  const invaded=new Set(incursions.ids),denied=[...new Set(leg.ids)].filter(id=>invaded.has(id));
  return denied.length?[`路线经过入侵星系：${denied.map(id=>graph.systems.get(id)?.nameZh??id).join('、')}`]:[];
}
export function autoStationIssues(graph,leg,stations,npcStationsOnly=false){
  if(!npcStationsOnly||leg.kind!=='jump')return [];
  return verifiedStations(stations,leg.to)?[]:[`旗舰跳落点「${graph.systems.get(leg.to)?.nameZh??leg.to}」没有已核验的 NPC 空间站`];
}

// Each explicitly ordered stop is a segment destination. A highsec stop may
// have a final highsec gate suffix, but incidental highsec transit cannot
// reset that suffix and enable another jump.
export function autoGateIssues(graph,legs,destination,waypoints=[],origin=legs[0]?.from??destination){
  let arrival=false,progress=waypoints[0]===origin?1:0;
  for(const leg of legs){
    for(const [index,id] of leg.ids.slice(1).entries()){
      const target=waypoints[progress]??destination;
      if(leg.kind==='jump'&&arrival)return ['自动路线仅允许末段过门抵达指定高安点，未到达指定点前不能再旗舰跳中转。'];
      if(leg.kind==='gate'){
        if(securityBand(graph.systems.get(target)?.security)!=='high'||securityBand(graph.systems.get(id)?.security)!=='high')return ['自动路线仅允许末段过门抵达指定高安点，其余路段必须旗舰跳。'];
        if(securityBand(graph.systems.get(leg.ids[index])?.security)==='null')return ['自动进入高安须先旗舰跳到低安边界，不允许从零安边界直接过门进入高安。'];
        arrival=true;
      }
      if(progress<waypoints.length&&waypoints[progress]===id){progress++;arrival=false;}
    }
  }
  return [];
}

const compare=(a,b)=>{
  for(let i=0;i<a.length;i++)if(a[i]!==b[i])return a[i]<b[i]?-1:1;
  return 0;
};
class Heap{
  items=[];
  push(value){
    let i=this.items.length;this.items.push(value);
    while(i>0){const p=(i-1)>>1;if(compare(this.items[p].priority,value.priority)<=0)break;this.items[i]=this.items[p];i=p;}this.items[i]=value;
  }
  pop(){
    if(!this.items.length)return null;
    const result=this.items[0],last=this.items.pop();
    if(this.items.length){let i=0;while(i*2+1<this.items.length){let c=i*2+1;if(c+1<this.items.length&&compare(this.items[c+1].priority,this.items[c].priority)<0)c++;if(compare(this.items[c].priority,last.priority)>=0)break;this.items[i]=this.items[c];i=c;}this.items[i]=last;}
    return result;
  }
}

// Admissible gate-count/safety lower bound: relax range and fuel, allowing a free jump
// from any legal origin to any legal low/null destination. A reverse gate search
// plus one virtual teleport expansion computes this in O(V+E) heap operations.
// Gate count takes priority over security preference; never overestimate either.
function optimisticGateCosts(graph,destination,denied){
  const costs=new Map(),queue=new Heap();let teleported=false,serial=0;
  const put=(id,cost)=>{if(denied.has(id)||costs.has(id)&&compare(cost,costs.get(id))>=0)return;costs.set(id,cost);queue.push({id,cost,priority:[...cost,serial++]});};
  put(destination,[0,0]);
  while(queue.items.length){
    const row=queue.pop();if(compare(row.cost,costs.get(row.id))!==0)continue;
    const system=graph.systems.get(row.id),high=securityBand(system.security)==='high';
    for(const previous of graph.adjacent.get(row.id)??[])put(previous,[row.cost[0]+1,0]);
    if(!teleported&&!high&&system.regionId!==10000070){
      teleported=true;for(const origin of graph.systems.values())if(origin.regionId!==10000070)put(origin.id,row.cost);
    }
  }
  return costs;
}

/**
 * Only jump until the final highsec gate-arrival suffix. Minimize gates, then
 * jump count and fuel. Solve every explicitly ordered stop as an independent
 * two-point search, sharing the geometry/jump cache. Gates can only form the
 * arrival suffix of a highsec stop, never an unspecified transit shortcut.
 * No route-length cap; each search has a time limit and finite work budget.
 * @param {object} graph
 * @param {{origin:number,destination:number,waypoints?:number[],ship:object,skills?:object,incursions?:{ids:number[]|null,modified?:string|null,fresh_until?:string|null,stale?:boolean,error?:string|null}|null,avoidIncursions?:boolean,npcStationsOnly?:boolean,stations?:Record<number,{id:number,typeId:number}[]>,blocked?:Set<number>,now?:number}} options
 * @returns {{from:number,to:number,kind:string,ids:number[]}[]}
 */
export function automaticJumpPlan(graph,{origin,destination,waypoints=[],ship,skills={},incursions=null,avoidIncursions=false,npcStationsOnly=false,stations={},blocked=new Set(),now=Date.now()}){
  const budgetError='自动计算搜索范围过大，请减少途经点或分段规划';
  if(!graph?.systems?.size||!graph.adjacent)throw new Error('自动计算基础星图不可用');
  if(!Array.isArray(waypoints)||waypoints.length>10||![origin,...waypoints,destination].every(validId))throw new Error('请选择有效的起点、终点及最多 10 个途经点');
  if(typeof avoidIncursions!=='boolean')throw new Error('入侵规避开关格式错误');
  if(typeof npcStationsOnly!=='boolean')throw new Error('NPC 站落点开关格式错误');
  if(npcStationsOnly&&(!stations||typeof stations!=='object'||Array.isArray(stations)))throw new Error('NPC 空间站资料不可用');
  if(avoidIncursions&&!currentIncursions(incursions,now))throw new Error(incursionError);
  const denied=new Set([...blocked,...(avoidIncursions?incursions.ids:[])]);
  const issues=planEndpointIssues(graph,[origin,...waypoints,destination],ship,denied);
  if(issues.length)throw new Error(issues.join('；'));
  const {range,fuelPerLy}=shipParameters(ship,skills),highsec=canEnterHighsec(ship);
  const positions=new Map(),indices=new Map(),buckets=new Map();
  for(const system of graph.systems.values()){
    if(!highsec&&securityBand(system.security)==='high')denied.add(system.id);
    const p=[system.x/METRES_PER_LIGHTYEAR,system.y/METRES_PER_LIGHTYEAR,system.z/METRES_PER_LIGHTYEAR];
    if(!p.every(Number.isFinite))throw new Error('自动计算星系坐标无效');
    indices.set(system.id,positions.size);positions.set(system.id,p);
    if(denied.has(system.id)||securityBand(system.security)==='high'||system.regionId===10000070||npcStationsOnly&&!verifiedStations(stations,system.id))continue;
    const key=p.map(n=>Math.floor(n/range)).join(':');
    if(!buckets.has(key))buckets.set(key,[]);
    buckets.get(key).push(system.id);
  }
  const jumpCache=new Map();
  function jumpsFrom(id){
    if(jumpCache.has(id))return jumpCache.get(id);
    const result=[],system=graph.systems.get(id),p=positions.get(id),cell=p.map(n=>Math.floor(n/range));
    if(system.regionId!==10000070)for(let x=-1;x<=1;x++)for(let y=-1;y<=1;y++)for(let z=-1;z<=1;z++){
      for(const target of buckets.get(`${cell[0]+x}:${cell[1]+y}:${cell[2]+z}`)??[]){
        if(target===id)continue;
        const distance=distanceLightyears(system,graph.systems.get(target));
        if(distance<=range){const fuel=Math.ceil(distance*fuelPerLy);if(!Number.isSafeInteger(fuel))throw new Error('距离或燃料计算结果无效');result.push({id:target,fuel});}
      }
    }
    result.sort((a,b)=>a.id-b.id);jumpCache.set(id,result);return result;
  }
  function searchSegment(origin,destination,targets){
    const started=performance.now(),highDestination=securityBand(graph.systems.get(destination).security)==='high';
    // Without a route-length budget, only the best cost for each system/checkpoint
    // state is needed. Positive gate or jump costs prevent unproductive cycles.
    const lowerBounds=optimisticGateCosts(graph,destination,denied),queue=new Heap(),labels=new Map();let sequence=0,insertions=0,expansions=0;
    const advance=(id,index)=>index<targets.length&&targets[index]===id?index+1:index;
    function enqueue(id,progress,cost,previous,edge,arrival=false){
      const key=(indices.get(id)*(targets.length+1)+progress)*2+Number(arrival),existing=labels.get(key);
      if(existing&&compare(existing.cost,cost)<=0)return;
      // Unreachable-to-B states are still explored to produce a legal prefix for
      // manual continuation. A zero bound remains admissible for these states.
      const bound=lowerBounds.get(id)??[0,0];
      const row={id,progress,key,cost,previous,edge,arrival,priority:[cost[0]+bound[0],0,cost[2],cost[3],sequence++]};
      labels.set(key,row);queue.push(row);
      // Explicit finite work budget also protects API requests with adversarial
      // checkpoint combinations; never return a partial route on exhaustion.
      if(++insertions>100000)throw new Error(budgetError);
    }
    // The caller already consumed the initial visit. A repeated checkpoint at
    // this origin must require a real departure and return, not a zero-leg match.
    enqueue(origin,0,[0,0,0,0],null,null);
    let end=null,frontier=null,frontierScore=null;
    while(queue.items.length){
      if((expansions++&255)===0&&performance.now()-started>2000)throw new Error(budgetError);
      const current=queue.pop();if(labels.get(current.key)!==current)continue;
      const target=targets[current.progress]??destination,score=[-current.progress,distanceLightyears(graph.systems.get(current.id),graph.systems.get(target)),...current.cost];
      if(!frontierScore||compare(score,frontierScore)<0){frontier=current;frontierScore=score;}
      if(current.progress===targets.length&&current.id===destination){end=current;break;}
      const gateDeparture=securityBand(graph.systems.get(current.id).security)!=='null';
      for(const next of highDestination&&gateDeparture?graph.adjacent.get(current.id)??[]:[]){
        if(denied.has(next))continue;
        const high=securityBand(graph.systems.get(next).security)==='high';
        if(!high)continue;
        const progress=advance(next,current.progress);
        enqueue(next,progress,[current.cost[0]+1,0,current.cost[2],current.cost[3]],current,{from:current.id,to:next,kind:'gate'},true);
      }
      for(const next of current.arrival?[]:jumpsFrom(current.id)){
        const progress=advance(next.id,current.progress);
        enqueue(next.id,progress,[current.cost[0],current.cost[1],current.cost[2]+1,current.cost[3]+next.fuel],current,{from:current.id,to:next.id,kind:'jump'});
      }
    }
    const steps=[];
    for(let row=end??frontier;row?.previous;row=row.previous)steps.push({...row.edge,checkpoint:row.progress!==row.previous.progress});
    steps.reverse();
    const legs=[];let gateIds=[];
    // Preserve searched gate IDs: re-running the manual safety-first gate planner
    // here could silently insert extra gates and undo the automatic priority.
    const flushGate=()=>{if(gateIds.length>1)legs.push({from:gateIds[0],to:gateIds.at(-1),kind:'gate',ids:gateIds});gateIds=[];};
    for(const step of steps){
      if(step.kind==='jump'){flushGate();legs.push(makePlanLeg(graph,step.from,step.to,'jump','shortest',ship,skills,denied));}
      else{
        // Only an actual return to a gate leg's origin needs a split. Split just
        // before its final edge so each materialized leg has different endpoints.
        if(gateIds[0]===step.to)flushGate();
        if(!gateIds.length)gateIds.push(step.from);gateIds.push(step.to);if(step.checkpoint)flushGate();
      }
    }
    flushGate();
    const gateIssues=autoGateIssues(graph,legs,destination);
    if(gateIssues.length)throw new Error(gateIssues.join('；'));
    for(const leg of legs){
      const problems=[...inspectLeg(graph,leg,ship,skills,denied).issues,...autoRouteIssues(graph,leg,incursions,avoidIncursions,now),...autoStationIssues(graph,leg,stations,npcStationsOnly)];
      if(problems.length)throw new Error(problems.join('；'));
    }
    if(!end)throw new AutomaticJumpUnreachableError(origin,legs);
    return legs;
  }

  const legs=[];
  let completed=checkpointProgress(origin,legs,waypoints).completed;
  while(true){
    const current=legs.at(-1)?.to??origin,remaining=waypoints.slice(completed);
    const split=remaining.length>0;
    const target=split?remaining[0]:destination,targets=split?[target]:remaining;
    try{legs.push(...searchSegment(current,target,targets));}
    catch(error){
      if(error instanceof AutomaticJumpUnreachableError)throw new AutomaticJumpUnreachableError(origin,[...legs,...error.legs]);
      throw error;
    }
    completed=checkpointProgress(origin,legs,waypoints).completed;
    if(!split)break;
  }
  const gateIssues=autoGateIssues(graph,legs,destination,waypoints,origin);
  if(gateIssues.length)throw new Error(gateIssues.join('；'));
  if(checkpointProgress(origin,legs,waypoints).remaining.length||(legs.at(-1)?.to??origin)!==destination)throw new Error('自动计算路线未能完整经过所有点位，请分段规划');
  return legs;
}
