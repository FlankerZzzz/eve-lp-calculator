import {mapPosition} from './star-map-view.mjs';
const clamp=(v,min,max)=>Math.min(max,Math.max(min,v));
const smooth=(a,b,v)=>{const t=clamp((v-a)/(b-a),0,1);return t*t*(3-2*t);};
export function cameraFlightPose(from,to,progress){
  const t=clamp(progress,0,1),ease=t<.5?4*t*t*t:1-(-2*t+2)**3/2;
  return {target:from.target.map((v,i)=>v+(to.target[i]-v)*ease),distance:Math.exp(Math.log(from.distance)+(Math.log(to.distance)-Math.log(from.distance))*ease)};
}
export function constellationView(system,systems,dimension='3d',aspect=1){
  const target=mapPosition(system,dimension);
  const members=system.constellationId?systems.filter(s=>s.constellationId===system.constellationId):[system];
  const radius=Math.max(1,...members.map(s=>Math.hypot(...mapPosition(s,dimension).map((n,i)=>n-target[i]))));
  return {target,distance:clamp(radius*2.8/Math.min(1,Math.max(.1,aspect)),6,400)};
}
export function jumpReachView(system,range,dimension='3d',aspect=1){
  if(!Number.isFinite(range)||range<=0)throw new Error('跳跃航程无效');
  return {target:mapPosition(system,dimension),distance:clamp(range*3.2/Math.min(1,Math.max(.1,aspect)),6,400)};
}
export function distanceLineView(a,b,dimension='3d',aspect=1){
  const start=mapPosition(a,dimension),end=mapPosition(b,dimension);
  const span=Math.hypot(...start.map((n,i)=>n-end[i]));
  return {target:start.map((n,i)=>(n+end[i])/2),distance:clamp(span*1.6/Math.min(1,Math.max(.1,aspect)),6,400)};
}
// Frame the union of all displayed routes, not just the active analysis tab.
export function routeBounds(systems,routes,dimension='3d'){
  const ids=[...new Set(routes.flatMap(route=>route.ids))];
  if(!ids.length)return null;
  const min=[Infinity,Infinity,Infinity],max=[-Infinity,-Infinity,-Infinity];
  for(const id of ids){
    const system=systems.get(id);if(!system)throw new Error('路线包含未知星系');
    const point=mapPosition(system,dimension);if(!point.every(Number.isFinite))throw new Error('路线星系坐标无效');
    point.forEach((n,i)=>{min[i]=Math.min(min[i],n);max[i]=Math.max(max[i],n);});
  }
  return {target:min.map((n,i)=>(n+max[i])/2||0),radius:Math.max(1,Math.hypot(...min.map((n,i)=>max[i]-n))/2)};
}
export function mapGeography(systems,dimension='3d'){
  const regions=new Map(),constellations=new Map();
  for(const s of systems){
    const p=mapPosition(s,dimension);
    for(const [groups,id,name,kind]of [[regions,s.regionId,s.regionName,'region'],[constellations,s.constellationId,s.constellationName,'constellation']]){
      if(!id||!name)continue;let group=groups.get(id);
      if(!group){group={id,kind,name,position:[0,0,0],count:0};groups.set(id,group);}
      group.count++;p.forEach((v,i)=>group.position[i]+=v);
    }
  }
  return [...regions.values(),...constellations.values()].map(g=>({...g,position:g.position.map(v=>v/g.count)}));
}
export function nameTierWeights(span){
  return {region:smooth(14,35,span)*.85,constellation:smooth(2.5,7,span)*(1-smooth(22,40,span))*.9,system:1-smooth(4,11,span)};
}
/** Screen-space collision filtering, independent of WebGL and DOM. */
export function layoutMapNames(candidates,width,height,blocked=[]){
  const placed=[],boxes=[...blocked],overlap=(a,b)=>a.x<b.x+b.width&&a.x+a.width>b.x&&a.y<b.y+b.height&&a.y+a.height>b.y;
  for(const c of [...candidates].sort((a,b)=>a.priority-b.priority||a.key.localeCompare(b.key))){
    if(c.opacity<.03||c.x<8||c.y<8||c.x+c.width>width-8||c.y+c.height>height-8||boxes.some(b=>overlap(c,b)))continue;
    placed.push(c);boxes.push({x:c.x-5,y:c.y-4,width:c.width+10,height:c.height+8});if(placed.length>=72)break;
  }
  return placed;
}
