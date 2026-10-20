import {navigationSnapshot} from '../../../../../lib/navigation-snapshot';
import {readNavigationCache} from '../../../../../lib/navigation-store.mjs';
import {validateJumpSupplement} from '../../../../../lib/jump-catalog.mjs';
export async function GET(request:Request){
  const id=Number(new URL(request.url).searchParams.get('system_id'));
  try{const {graph}=await navigationSnapshot();if(!Number.isSafeInteger(id)||!graph.systems.has(id))return Response.json({error:'未知星系'},{status:400});}catch{return Response.json({error:'星图不可用'},{status:503});}
  try{
    const row=readNavigationCache('jump');if(!row?.payload)throw new Error('站点基线未入库');
    const supplement=validateJumpSupplement(JSON.parse(String(row.payload)));
    const stations=(supplement.stations[id]??[]).map((s:{id:number;typeId:number})=>({...s,name:`NPC 空间站 ${s.id}`}));
    return Response.json({systemId:id,stations,source:'SDE',fetchedAt:row.fetched},{headers:{'cache-control':'no-store'}});
  }catch{return Response.json({error:'数据库站点基线暂不可用，请检查地理缓存同步；查询失败不代表没有空间站。'},{status:503,headers:{'cache-control':'no-store'}});}
}
