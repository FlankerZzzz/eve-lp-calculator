import {renderPosition} from './star-map.mjs';

export const MAP_POINT_SIZES={base:4,compact:3.5,selected:8,route:6,candidate:4.5,landing:5,overlap:6,origin:7,destination:8,waypoint:7,incursion:7};

// Display projection only. Never pass these flattened coordinates to navigation.
export function mapPosition(system,dimension='3d') {
  const [x,y,z]=renderPosition(system);
  return [x,dimension==='2d'?0:y,z];
}
export function jumpStopGuide(origin,waypoints,destination,completed=0) {
  const roles=new Map();
  const add=(id,label,index=null)=>{
    if(!roles.has(id))roles.set(id,{id,labels:[],indices:[],visited:true});
    const entry=roles.get(id);entry.labels.push(label);
    if(index!==null){entry.indices.push(index+1);entry.visited&&=index<completed;}
  };
  add(origin,'A');waypoints.forEach((id,i)=>add(id,`经停 ${i+1}${i<completed?' ✓':''}`,i));add(destination,'B');
  return {ids:[origin,...waypoints,destination],points:[...roles.values()].map(p=>({...p,label:p.labels.join(' / '),waypoint:p.indices.length>0}))};
}
