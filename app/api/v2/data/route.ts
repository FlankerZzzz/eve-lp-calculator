import { DatabaseSync } from 'node:sqlite';
import { dirname, resolve } from 'node:path';
import { authorizeSyncControl } from '../../../../lib/sync-auth';
import { openV2 } from '../../../../scripts/v2/database.mjs';
import { exportFilter, maintenanceModules, MAX_IMPORT_BYTES, previewImport, stageImport, commitImport } from '../../../../scripts/v2/maintenance.mjs';
import { ModuleLog } from '../../../../scripts/v2/request.mjs';
export async function GET(request:Request) {
  const denied=authorizeSyncControl(request);if(denied)return denied;
  if(!process.env.V2_SQLITE_PATH)return Response.json({error:'V2 数据库尚未配置'},{status:503});
  const db=new DatabaseSync(process.env.V2_SQLITE_PATH,{readOnly:true});
  try {db.exec('PRAGMA busy_timeout=15000');const url=new URL(request.url),moduleName=url.searchParams.get('module')??'';
    const selections=exportFilter(db,moduleName,Object.fromEntries(url.searchParams));
    const counts=selections.map((s:{table:string;sql:string;values:unknown[]})=>({table:s.table,count:db.prepare(`SELECT COUNT(*) n FROM (${s.sql})`).get(...s.values as (string|number)[])?.n}));
    return Response.json({module:moduleName,tables:maintenanceModules[moduleName as keyof typeof maintenanceModules],counts,importable:['items','catalog','history'].includes(moduleName)});
  }catch(e){return Response.json({error:e instanceof Error?e.message:'读取失败'},{status:400});}finally{db.close();}
}
export async function POST(request:Request) {
  const denied=authorizeSyncControl(request);if(denied)return denied;
  if(!process.env.V2_SQLITE_PATH)return Response.json({error:'V2 数据库尚未配置'},{status:503});
  let db:ReturnType<typeof openV2>|undefined;
  try {
    const length=Number(request.headers.get('content-length')||0);if(length>MAX_IMPORT_BYTES+65536)throw new Error('上传文件超过 20 MiB');
    const root=resolve(dirname(process.env.V2_SQLITE_PATH),'maintenance');
    if(request.headers.get('content-type')?.startsWith('multipart/form-data')) {
      const form=await request.formData(),file=form.get('file'),moduleName=String(form.get('module')??'');
      if(!(file instanceof File)||file.size>MAX_IMPORT_BYTES)throw new Error('请选择不超过 20 MiB 的 JSONL 修复文件');
      db=openV2(process.env.V2_SQLITE_PATH);const plan=previewImport(db,await file.text(),moduleName),preview_id=stageImport(root,plan);
      new ModuleLog(resolve(process.env.V2_LOG_PATH||'docker-data/v2/logs'),'maintenance',new Date().toISOString()).info('import_preview',{module:moduleName,preview_id,summary:plan.summary});
      return Response.json({preview_id,summary:plan.summary,expires_at:plan.expires_at,examples:plan.records.slice(0,10).map((entry:{table:string;action:string;row:Record<string,unknown>})=>({table:entry.table,action:entry.action,row:entry.row}))});
    }
    const body=await request.json();db=openV2(process.env.V2_SQLITE_PATH);const result=commitImport(db,root,body.preview_id,{protect:body.protect??false});
    new ModuleLog(resolve(process.env.V2_LOG_PATH||'docker-data/v2/logs'),'maintenance',new Date().toISOString()).info('import_committed',result);
    return Response.json({ok:true,...result});
  }catch(e){return Response.json({error:e instanceof Error?e.message:'导入失败'},{status:400});}finally{db?.close();}
}
