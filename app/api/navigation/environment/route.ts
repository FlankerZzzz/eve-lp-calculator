import {readNavigationCache} from '../../../../lib/navigation-store.mjs';
import {navigationFeed} from '../../../../lib/navigation-feed';
import {activityForSystems} from '../../../../lib/navigation-activity.mjs';
import {navigationSnapshot} from '../../../../lib/navigation-snapshot';

// Persisted snapshots only. Opening a map never starts upstream requests.
export async function GET(){
  try{
    const {data}=await navigationSnapshot();
    const [jumps,kills,incursions,sovereignty,industry]=await Promise.all([navigationFeed.load('system_jumps'),navigationFeed.load('system_kills'),navigationFeed.load('incursions'),navigationFeed.load('sovereignty'),navigationFeed.load('industry')]);
    const names=readNavigationCache('sovereignty_names');
    const meta=(value:typeof jumps)=>({modified:value.modified??null,fetched:value.fetched??null,fresh_until:value.fresh_until??null,stale:!!value.stale,error:value.error??null});
    return Response.json({source:'database',systems:activityForSystems(jumps,kills,data.systems.map(s=>s.id)),jumps:meta(jumps),kills:meta(kills),incursions:{...meta(incursions),ids:incursions.rows?.flatMap((r:{infested_solar_systems:number[]})=>r.infested_solar_systems)??null},sovereignty:{...meta(sovereignty),rows:sovereignty.rows,names:names?.payload?JSON.parse(String(names.payload)):[],namesError:names?.error??(!names?.payload?'主权名称尚未同步':null)},industry:{...meta(industry),rows:industry.rows}},{headers:{'cache-control':'no-store'}});
  }catch{return Response.json({error:'星图环境资料暂不可用'},{status:503,headers:{'cache-control':'no-store'}});}
}
