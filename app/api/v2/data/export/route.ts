import { DatabaseSync } from 'node:sqlite';
import { authorizeSyncControl } from '../../../../../lib/sync-auth';
import { exportFilter, exportLines } from '../../../../../scripts/v2/maintenance.mjs';
// A native attachment POST lets the browser download large exports without a JS Blob in memory.
export async function POST(request:Request) {
  const form=await request.formData().catch(()=>null);if(!form)return Response.json({error:'导出参数无效'},{status:400});
  const headers=new Headers(request.headers);headers.set('x-sync-admin-token',String(form.get('admin_token')??''));
  const denied=authorizeSyncControl(new Request(request.url,{headers}));if(denied)return denied;
  if(!process.env.V2_SQLITE_PATH)return Response.json({error:'V2 数据库尚未配置'},{status:503});
  const db=new DatabaseSync(process.env.V2_SQLITE_PATH,{readOnly:true});
  try {
    db.exec('PRAGMA busy_timeout=15000;BEGIN;');const moduleName=String(form.get('module')??''),filters={type_id:String(form.get('type_id')??''),from:String(form.get('from')??''),to:String(form.get('to')??'')};
    exportFilter(db,moduleName,filters);const lines=exportLines(db,moduleName,filters),encoder=new TextEncoder();let closed=false;
    const close=()=>{if(!closed){closed=true;lines.return?.();db.exec('ROLLBACK');db.close();}};
    const stream=new ReadableStream({pull(controller){try{let buffer='';for(let n=0;n<128;n++){const next=lines.next();if(next.done){if(buffer)controller.enqueue(encoder.encode(buffer));close();controller.close();return;}buffer+=next.value;}controller.enqueue(encoder.encode(buffer));}catch(e){close();controller.error(e);}},cancel(){close();}});
    return new Response(stream,{headers:{'content-type':'application/x-ndjson; charset=utf-8','content-disposition':`attachment; filename="v2-${moduleName}-${new Date().toISOString().slice(0,10)}.jsonl"`,'cache-control':'no-store'}});
  }catch(e){db.close();return Response.json({error:e instanceof Error?e.message:'导出失败'},{status:400});}
}
