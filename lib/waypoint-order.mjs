// Manual reordering only. Preserve point objects and never infer a route order.
export function assignNavigationPoint(points,point,role) {
  if(points.length<2)return points;
  if(role==='waypoint')return points.length>=12?points:[...points.slice(0,-1),point,points.at(-1)];
  if(role!=='origin'&&role!=='destination')return points;
  const index=role==='origin'?0:points.length-1;
  return points.map((row,i)=>i===index?{...row,id:point.id,text:point.text}:row);
}
export function moveWaypoint(points,key,targetKey) {
  const from=points.findIndex(p=>p.key===key),to=points.findIndex(p=>p.key===targetKey);
  if(from<0||to<0||from===to)return points;
  const ordered=[...points],point=ordered.splice(from,1)[0];ordered.splice(to,0,point);return ordered;
}
export function waypointSlot(centerY,slots) {
  let target=0,best=Infinity;
  for(let i=0;i<slots.length;i++){const distance=Math.abs(centerY-(slots[i].top+slots[i].height/2));if(distance<best){best=distance;target=i;}}
  return target;
}
