import {readNavigationCache} from '../../../../../lib/navigation-store.mjs';
import {indexSystemNames} from '../../../../../lib/system-search-index.mjs';
import {navigationSnapshot} from '../../../../../lib/navigation-snapshot';
import {validateJumpCatalog,validateJumpSupplement} from '../../../../../lib/jump-catalog.mjs';
let cached:{version:string;data:Record<string,unknown>}|null=null;
export async function GET(){
  try{
    const {data}=await navigationSnapshot();
    const row=readNavigationCache('jump');
    if(!row?.payload||!row.version)throw new Error('跳跃资料尚未入库');
    const version=String(row.version);
    if(cached?.version!==version){const extra=validateJumpSupplement(JSON.parse(String(row.payload)));cached={version,data:extra};}
    const body=validateJumpCatalog({...cached!.data,systems:indexSystemNames(data.systems),gates:data.gates,source:data.source,serenityVerified:data.serenityVerified});
    return Response.json(body,{headers:{'cache-control':'public, max-age=300'}});
  }catch(error){
    // Validation messages contain field names/IDs only; never expose fs paths.
    const message=error instanceof Error&&error.message.startsWith('跳跃基础资料校验失败：')?error.message:'跳跃基础快照缺失或校验失败，请重新导出完整舰船及星图资料后重试。';
    return Response.json({error:message},{status:503,headers:{'cache-control':'no-store'}});
  }
}
