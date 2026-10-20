import {navigationFeed} from '../../../../../lib/navigation-feed';
export async function GET(){
  const value=await navigationFeed.load('incursions');
  return Response.json({ids:value.rows?.flatMap((r:{infested_solar_systems:number[]})=>r.infested_solar_systems)??null,
    modified:value.modified??null,fetched:value.fetched??null,fresh_until:value.fresh_until??null,stale:!!value.stale,error:value.error??null},{headers:{'cache-control':'no-store'}});
}
