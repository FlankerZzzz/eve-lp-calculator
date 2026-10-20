import {navigationSnapshot} from '../../../../lib/navigation-snapshot';
export async function GET() {
  try {
    const snapshot=await navigationSnapshot();
    return new Response(snapshot.body,{headers:{'content-type':'application/json; charset=utf-8','cache-control':'public, max-age=300'}});
  } catch(error) {
    console.error('[star-map] Snapshot unavailable',error instanceof Error?error.message:'Unknown error');
    return Response.json({error:'星图数据尚未准备好，请管理员从 SDE 生成地图快照。'},{status:503});
  }
}
