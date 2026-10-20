import {navigationSnapshot} from '../../../../lib/navigation-snapshot';
import {indexSystemNames} from '../../../../lib/system-search-index.mjs';
import type {SystemInfo} from '../../../navigation/navigation-types';
export async function GET() {
  try {
    const {data}=await navigationSnapshot();
    return Response.json({systems:indexSystemNames(data.systems).map(({id,nameZh,nameEn,regionName,regionId,security,npcStationCount,searchPinyin,searchInitials}:SystemInfo)=>({id,nameZh,nameEn,regionName,regionId,security,npcStationCount,searchPinyin,searchInitials})),source:data.source,serenityVerified:data.serenityVerified},{headers:{'cache-control':'public, max-age=300'}});
  } catch {return Response.json({error:'导航星系数据未准备好，请管理员更新 SDE 星图快照。'},{status:503});}
}
