import {navigationFeed} from '../../../../lib/navigation-feed';
import {activityForSystems} from '../../../../lib/navigation-activity.mjs';
import {navigationSnapshot} from '../../../../lib/navigation-snapshot';
export async function POST(request:Request) {
  let ids:number[];
  try{const text=await request.text();if(text.length>50000)throw new Error();const body=JSON.parse(text);ids=body.ids;if(!Array.isArray(ids)||ids.length>2000||ids.some(id=>!Number.isSafeInteger(id)))throw new Error();}catch{return Response.json({error:'请提供有效的星系 ID 列表（最多 2000 个）'},{status:400});}
  try{const {graph}=await navigationSnapshot();if(ids.some(id=>!graph.systems.has(id)))return Response.json({error:'统计请求包含未知星系'},{status:400});}catch{return Response.json({error:'星图数据不可用'},{status:503});}
  const [jumps,kills]=await Promise.all([navigationFeed.load('system_jumps'),navigationFeed.load('system_kills')]);
  const meta=(value:typeof jumps)=>({modified:value.modified??null,fetched:value.fetched??null,fresh_until:value.fresh_until??null,stale:!!value.stale,error:value.error??null});
  return Response.json({systems:activityForSystems(jumps,kills,[...new Set(ids)]),jumps:meta(jumps),kills:meta(kills)},{headers:{'cache-control':'no-store'}});
}
