import { DatabaseSync } from 'node:sqlite';
import { resolve } from 'node:path';
import { authorizeSyncControl } from '../../../../lib/sync-auth';
import { openV2 } from '../../../../scripts/v2/database.mjs';
import { updateLpFlags } from '../../../../scripts/v2/lp-policy.mjs';
import { ModuleLog } from '../../../../scripts/v2/request.mjs';

// Administrative maintenance only; public business connections remain read-only.
export async function GET(request: Request) {
  const denied=authorizeSyncControl(request);if(denied)return denied;
  if(!process.env.V2_SQLITE_PATH)return Response.json({error:'V2 数据库尚未配置'},{status:503});
  const url=new URL(request.url),page=Number(url.searchParams.get('page')??1);
  const blocked=url.searchParams.get('is_blocked')??'',search=url.searchParams.get('q')??'';
  if(!Number.isSafeInteger(page)||page<1||!['','Y','N'].includes(blocked))return Response.json({error:'筛选参数无效'},{status:400});
  const db=new DatabaseSync(process.env.V2_SQLITE_PATH,{readOnly:true});
  try {
    db.exec('PRAGMA busy_timeout=15000');
    const where=['1=1'],values:(string|number)[]=[];
    if(blocked){where.push('o.is_blocked=?');values.push(blocked);}
    if(search){where.push("(CAST(o.corporation_id AS TEXT)=? OR CAST(o.offer_id AS TEXT)=? OR CAST(o.type_id AS TEXT)=? OR o.corporation_name_zh LIKE ? OR o.faction_name_zh LIKE ? OR i.name_zh LIKE ? OR i.name_en LIKE ?)");values.push(search,search,search,...Array(4).fill(`%${search}%`));}
    const query=`FROM lp_exchange o LEFT JOIN items i ON i.type_id=o.type_id WHERE ${where.join(' AND ')}`;
    const total=db.prepare(`SELECT COUNT(*) AS n ${query}`).get(...values)?.n;
    const rows=db.prepare(`SELECT o.corporation_id,o.offer_id,o.type_id,o.faction_name_zh,o.faction_name_en,o.corporation_name_zh,o.corporation_name_en,COALESCE(i.name_zh,i.name_en) AS item_name,o.ak_cost,o.is_high_sec,o.is_blocked,o.manual_blocked,o.is_guard,o.is_invalid ${query} ORDER BY o.corporation_name_zh,o.offer_id LIMIT 50 OFFSET ?`).all(...values,(page-1)*50);
    const counts=db.prepare('SELECT is_high_sec,is_blocked,COUNT(*) AS count FROM lp_exchange GROUP BY is_high_sec,is_blocked').all();
    return Response.json({rows,total,page,page_size:50,counts});
  } catch(error){return Response.json({error:error instanceof Error?error.message:'读取失败'},{status:500});}
  finally{db.close();}
}
export async function POST(request: Request) {
  const denied=authorizeSyncControl(request);if(denied)return denied;
  if(!process.env.V2_SQLITE_PATH)return Response.json({error:'V2 数据库尚未配置'},{status:503});
  const body=await request.json().catch(()=>null);
  if(!body||!body.changes||typeof body.changes!=='object'||Array.isArray(body.changes))return Response.json({error:'请选择兑换方案和 Y/N 标记'},{status:400});
  const db=openV2(process.env.V2_SQLITE_PATH);
  try {
    const result=updateLpFlags(db,body.corporation_id,body.offer_id,body.changes);
    new ModuleLog(resolve(process.env.V2_LOG_PATH||'docker-data/v2/logs'),'lp-policy',new Date().toISOString()).info('manual_flags',result);
    return Response.json({ok:true,...result});
  } catch(error){return Response.json({error:error instanceof Error?error.message:'保存失败'},{status:400});}
  finally{db.close();}
}
