import {Vector3,Quaternion} from 'three';
// Display convention, not a claim of an official celestial north:
// SDE +X east, +Z north (render Z is inverted), +Y above the map plane.
export const MAP_DIRECTIONS=[
  {name:'东',axis:[1,0,0],color:'#f4bc83'},
  {name:'西',axis:[-1,0,0],color:'#f4bc83'},
  {name:'北',axis:[0,0,-1],color:'#83dfc8'},
  {name:'南',axis:[0,0,1],color:'#83dfc8'},
  {name:'上',axis:[0,1,0],color:'#96baff'},
  {name:'下',axis:[0,-1,0],color:'#96baff'},
];
export const MAP_VIEWS={
  top:{offset:[0,1,.0001],name:'回正'},
};
export function compassDirections(quaternion) {
  const inverse=new Quaternion(...quaternion).invert();
  return MAP_DIRECTIONS.map(d=>{
    const v=new Vector3(...d.axis).applyQuaternion(inverse);
    return {...d,x:v.x,y:-v.y,depth:v.z};
  }).sort((a,b)=>a.depth-b.depth);
}
export function mapViewLabel(offset) {
  const v=new Vector3(...offset).normalize();
  if(v.y>.94)return '上方俯视';
  if(v.y<-.94)return '下方仰视';
  if(Math.abs(v.z)>=Math.abs(v.x))return v.z>=0?'南侧 · 正面':'北侧 · 背面';
  return v.x>0?'东侧视角':'西侧视角';
}
