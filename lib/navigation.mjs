import {securityBand} from './star-map.mjs';

export const ROUTE_MODES=['secure','shortest','insecure'];
export const MODE_LABELS={secure:'高安优先',shortest:'最近优先',insecure:'低安优先'};

export function navigationGraph(data) {
  const systems=new Map(data.systems.map(s=>[s.id,s]));
  const adjacent=new Map(data.systems.map(s=>[s.id,[]]));
  for(const [a,b] of data.gates) {
    if(!systems.has(a)||!systems.has(b)||a===b)continue;
    adjacent.get(a).push(b);adjacent.get(b).push(a);
  }
  for(const neighbors of adjacent.values())neighbors.sort((a,b)=>a-b);
  return {systems,adjacent};
}

class Heap {
  items=[];
  push(value) {
    let i=this.items.length;this.items.push(value);
    while(i>0){const p=(i-1)>>1;if(this.items[p][0]<=value[0])break;this.items[i]=this.items[p];i=p;}this.items[i]=value;
  }
  pop() {
    if(!this.items.length)return null;
    const result=this.items[0],last=this.items.pop();
    if(this.items.length){let i=0;while(i*2+1<this.items.length){let c=i*2+1;if(c+1<this.items.length&&this.items[c+1][0]<this.items[c][0])c++;if(this.items[c][0]>=last[0])break;this.items[i]=this.items[c];i=c;}this.items[i]=last;}
    return result;
  }
}

// A penalty dominates all possible hops: minimise unwanted-security entries,
// then hops. This is our explicit local preference, not an ESI route replica.
export function findGateRoute(graph,origin,destination,mode,blocked=new Set()) {
  if(!ROUTE_MODES.includes(mode))throw new Error('未知路线偏好');
  if(!graph.systems.has(origin)||!graph.systems.has(destination))throw new Error('星系不存在');
  if(blocked.has(origin)||blocked.has(destination))return null;
  if(origin===destination)return [origin];
  const penalty=graph.systems.size+1,queue=new Heap(),dist=new Map([[origin,0]]),previous=new Map();
  queue.push([0,origin]);
  while(queue.items.length) {
    const [cost,id]=queue.pop();if(dist.get(id)!==cost)continue;
    if(id===destination){const path=[id];while(path.at(-1)!==origin)path.push(previous.get(path.at(-1)));return path.reverse();}
    for(const next of graph.adjacent.get(id)) {
      if(blocked.has(next))continue;
      const high=securityBand(graph.systems.get(next).security)==='high';
      const unwanted=(mode==='secure'&&!high)||(mode==='insecure'&&high);
      const candidate=cost+1+(unwanted?penalty:0);
      if(candidate>=(dist.get(next)??Infinity))continue;
      dist.set(next,candidate);previous.set(next,id);queue.push([candidate,next]);
    }
  }
  return null;
}

export function validateNavigationRequest(input,graph) {
  if(!input||typeof input!=='object'||Array.isArray(input))throw new Error('导航参数格式错误');
  const {points,modes,avoid=[],triglavian=[],edencom=[],avoidTriglavian=false,avoidEdencom=false,avoidIncursions=false}=input;
  if(!Array.isArray(points)||points.length<2||points.length>12||points.some(id=>!Number.isSafeInteger(id)||!graph.systems.has(id)))throw new Error('请选择 2～12 个有效星系点位');
  if(!Array.isArray(modes)||!modes.length||modes.length>3||modes.some(m=>!ROUTE_MODES.includes(m))||new Set(modes).size!==modes.length)throw new Error('请至少勾选一种路线偏好');
  for(const ids of [avoid,triglavian,edencom])if(!Array.isArray(ids)||ids.length>500||ids.some(id=>!Number.isSafeInteger(id)||!graph.systems.has(id)))throw new Error('规避名单包含无效星系或超过 500 个');
  for(const flag of [avoidTriglavian,avoidEdencom,avoidIncursions])if(typeof flag!=='boolean')throw new Error('规避开关格式错误');
  return {points,modes,avoid,triglavian,edencom,avoidTriglavian,avoidEdencom,avoidIncursions};
}

export function calculateNavigation(graph,request,incursionIds=[]) {
  const blocked=new Set(request.avoid);
  if(request.avoidTriglavian){for(const id of request.triglavian)blocked.add(id);for(const s of graph.systems.values())if(s.regionId===10000070)blocked.add(s.id);}
  if(request.avoidEdencom)for(const id of request.edencom)blocked.add(id);
  if(request.avoidIncursions)for(const id of incursionIds)blocked.add(id);
  const conflict=request.points.find(id=>blocked.has(id));
  if(conflict!==undefined)throw new Error(`点位「${graph.systems.get(conflict).nameZh}」已被规避，请修改点位或名单`);
  return request.modes.map(mode=>{
    const ids=[],legs=[];
    for(let i=1;i<request.points.length;i++) {
      const path=findGateRoute(graph,request.points[i-1],request.points[i],mode,blocked);
      if(!path)return {mode,label:MODE_LABELS[mode],ids:[],legs:[],jumps:0,error:`无法从 ${graph.systems.get(request.points[i-1]).nameZh} 到达 ${graph.systems.get(request.points[i]).nameZh}；请检查规避名单和星门连通性`};
      legs.push({from:request.points[i-1],to:request.points[i],jumps:path.length-1});ids.push(...(i===1?path:path.slice(1)));
    }
    const bands={high:0,low:0,null:0};for(const id of ids)bands[securityBand(graph.systems.get(id).security)]++;
    return {mode,label:MODE_LABELS[mode],ids,legs,jumps:ids.length-1,bands,error:null};
  });
}
