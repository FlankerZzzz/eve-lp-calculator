import { DatabaseSync } from 'node:sqlite';
import { resolve } from 'node:path';
import { authorizeSyncControl } from '../../../../lib/sync-auth';
import { openV2 } from '../../../../scripts/v2/database.mjs';
import { getLpPolicy, validateLpPolicy, lpFlagsForOffer, saveLpPolicy } from '../../../../scripts/v2/lp-policy.mjs';
import { ModuleLog } from '../../../../scripts/v2/request.mjs';

export async function GET(request:Request) {
  const denied=authorizeSyncControl(request);if(denied)return denied;
  if(!process.env.V2_SQLITE_PATH)return Response.json({error:'V2 数据库尚未配置'},{status:503});
  const db=new DatabaseSync(process.env.V2_SQLITE_PATH,{readOnly:true});
  try {
    db.exec('PRAGMA busy_timeout=15000');const url=new URL(request.url),scope=url.searchParams.get('scope'),q=url.searchParams.get('q')??'';
    if(scope) {
      if(!['faction','corporation','item'].includes(scope))return Response.json({error:'查询范围无效'},{status:400});
      const id={faction:'faction_id',corporation:'corporation_id',item:'type_id'}[scope as 'faction'|'corporation'|'item'];
      const name=scope==='item'?"COALESCE(i.name_zh,i.name_en,'物品 '||o.type_id)":`MAX(o.${scope}_name_zh)`;
      const rows=db.prepare(`SELECT o.${id} AS id,${name} AS name,COUNT(*) AS offers FROM lp_exchange o LEFT JOIN items i ON i.type_id=o.type_id WHERE o.${id} IS NOT NULL GROUP BY o.${id} HAVING CAST(o.${id} AS TEXT)=? OR ${name} LIKE ? ORDER BY name LIMIT 100`).all(q,`%${q}%`);
      return Response.json({rows});
    }
    const counts=db.prepare("SELECT COUNT(*) AS total,SUM(is_guard='Y') AS guards,SUM(is_invalid='Y') AS invalid,SUM(is_blocked='Y') AS blocked FROM lp_exchange").get();
    const config=getLpPolicy(db),names=new Map<string,string>();
    const lookups={faction:db.prepare('SELECT faction_name_zh AS name FROM lp_exchange WHERE faction_id=? LIMIT 1'),corporation:db.prepare('SELECT corporation_name_zh AS name FROM lp_exchange WHERE corporation_id=? LIMIT 1'),item:db.prepare('SELECT COALESCE(name_zh,name_en) AS name FROM items WHERE type_id=?'),offer:db.prepare('SELECT corporation_name_zh AS name FROM lp_exchange WHERE corporation_id=? AND offer_id=?')};
    const rules=config.rules.map((rule:{scope:'faction'|'corporation'|'item'|'offer';target_id:number|string;target_name?:string})=>{
      const key=`${rule.scope}:${rule.target_id}`;
      if(!names.has(key)){const ids=rule.scope==='offer'?String(rule.target_id).split(':').map(Number):[Number(rule.target_id)];const row=lookups[rule.scope].get(...ids);names.set(key,String(row?.name??rule.target_name??'未匹配到名称'));}
      return {...rule,target_name:names.get(key)};
    });
    return Response.json({config:{...config,rules},counts});
  } catch(e){return Response.json({error:e instanceof Error?e.message:'读取失败'},{status:500});}finally{db.close();}
}
export async function POST(request:Request) {
  const denied=authorizeSyncControl(request);if(denied)return denied;
  if(!process.env.V2_SQLITE_PATH)return Response.json({error:'V2 数据库尚未配置'},{status:503});
  const body=await request.json().catch(()=>null),db=openV2(process.env.V2_SQLITE_PATH);
  try {
    validateLpPolicy(body?.config);
    if(body.preview===true) {
      const before=getLpPolicy(db);if(body.expected_version!==before.version)throw new Error('配置已变化，请刷新');
      let changed=0,blocked=0;const examples=[];
      for(const row of db.prepare('SELECT * FROM lp_exchange').all()) {
        const flags=lpFlagsForOffer(db,row,row,body.config);if(flags.is_blocked==='Y')blocked++;
        if((['is_blocked','is_guard','is_invalid'] as const).some(key=>row[key]!==flags[key])){changed++;if(examples.length<10)examples.push({corporation_id:row.corporation_id,corporation:row.corporation_name_zh,offer_id:row.offer_id,type_id:row.type_id,before:row.is_blocked,after:flags.is_blocked});}
      }
      return Response.json({changed,blocked,examples,version:before.version});
    }
    const result=saveLpPolicy(db,body.config,body.expected_version);
    new ModuleLog(resolve(process.env.V2_LOG_PATH||'docker-data/v2/logs'),'lp-policy',new Date().toISOString()).info('rules_changed',result);
    return Response.json({ok:true,changed:result.changed,config:result.after});
  }catch(e){return Response.json({error:e instanceof Error?e.message:'保存失败'},{status:400});}finally{db.close();}
}
