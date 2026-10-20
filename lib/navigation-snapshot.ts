import {readNavigationCache} from './navigation-store.mjs';
import {navigationGraph} from './navigation.mjs';
import type {StarMapData} from '../app/navigation/star-map';

let cached:{version:string;body:string;data:StarMapData;graph:ReturnType<typeof navigationGraph>;checked:number}|null=null;
export async function navigationSnapshot() {
  if(cached&&Date.now()-cached.checked<5000)return cached;
  const row=readNavigationCache('map');
  if(!row?.payload||!row.version)throw new Error('星图尚未入库，请运行地理缓存同步');
  const version=String(row.version);
  if(cached?.version===version){cached.checked=Date.now();return cached;}
  const body=String(row.payload),data=JSON.parse(body);
  if(data.schema!==1||!Array.isArray(data.systems)||!data.systems.length||!Array.isArray(data.gates))throw new Error('Invalid map snapshot');
  cached={version,body,data,graph:navigationGraph(data),checked:Date.now()};return cached;
}
