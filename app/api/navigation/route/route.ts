import {navigationSnapshot} from '../../../../lib/navigation-snapshot';
import {calculateNavigation,validateNavigationRequest} from '../../../../lib/navigation.mjs';
import {navigationFeed} from '../../../../lib/navigation-feed';
export async function POST(request:Request) {
  let input;
  try {const body=await request.text();if(body.length>50000)return Response.json({error:'导航请求过大'},{status:413});input=JSON.parse(body);}catch{return Response.json({error:'导航参数不是有效 JSON'},{status:400});}
  let snapshot;
  try{snapshot=await navigationSnapshot();}catch{return Response.json({error:'导航星图数据不可用'},{status:503});}
  try {
    const parameters=validateNavigationRequest(input,snapshot.graph);
    let incursions;
    if(parameters.avoidIncursions){incursions=await navigationFeed.load('incursions');if(incursions.error||incursions.stale||!incursions.rows)return Response.json({error:'当前入侵名单无法可靠获取。请稍后重试，或明确关闭入侵规避后计算。'},{status:503});}
    const started=performance.now();
    const routes=calculateNavigation(snapshot.graph,parameters,incursions?.rows.flatMap((r:{infested_solar_systems:number[]})=>r.infested_solar_systems)||[]);
    const ids=new Set<number>(routes.flatMap((r:{ids:number[]})=>r.ids));
    return Response.json({routes,systems:[...ids].map(id=>snapshot.graph.systems.get(id)),calculatedAt:new Date().toISOString(),elapsedMs:Math.round((performance.now()-started)*100)/100,source:snapshot.data.source,serenityVerified:snapshot.data.serenityVerified,incursionsModified:incursions?.modified??null},{headers:{'cache-control':'no-store'}});
  } catch(error){return Response.json({error:error instanceof Error?error.message:'导航计算失败'},{status:400});}
}
