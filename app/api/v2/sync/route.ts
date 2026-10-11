import { DatabaseSync } from 'node:sqlite';
import { authorizeSyncControl } from '../../../../lib/sync-auth';
import { parseCron, nextCron } from '../../../../scripts/v2/cron.mjs';

function open() {
  if (!process.env.V2_SQLITE_PATH) throw new Error('V2_SQLITE_PATH 尚未配置');
  const db = new DatabaseSync(process.env.V2_SQLITE_PATH);
  db.exec('PRAGMA busy_timeout=15000;');
  return db;
}
export async function GET() {
  const db = open();
  try {
    const tasks = db.prepare('SELECT * FROM tasks').all();
    const worker = db.prepare("SELECT value FROM runtime_state WHERE key='worker'").get();
    return Response.json({ database: 'v2', timezone: 'Asia/Shanghai', worker, tasks: tasks.map(task => ({ ...task, next_run: task.automatic && task.cron ? nextCron(String(task.cron)) : null })) });
  } finally { db.close(); }
}
export async function POST(request: Request) {
  const denied = authorizeSyncControl(request); if (denied) return denied;
  const body = await request.json().catch(() => null) as { module?: string; action?: string; automatic?: boolean; cron?: string; debug?: boolean } | null;
  if (!body?.module) return Response.json({ error: '请选择模块' }, { status: 400 });
  const db = open();
  try {
    const task = db.prepare('SELECT * FROM tasks WHERE module=?').get(body.module);
    if (!task) return Response.json({ error: '模块不存在' }, { status: 404 });
    const now = new Date().toISOString();
    if (body.action === 'configure') {
      if (body.cron) parseCron(body.cron);
      if (body.automatic && !body.cron && !task.cron) throw new Error('开启自动同步前请配置 Cron');
      db.prepare('UPDATE tasks SET automatic=?,cron=?,debug=?,updated_at=? WHERE module=?').run(body.automatic === undefined ? task.automatic : body.automatic ? 1 : 0, body.cron ?? task.cron, body.debug === undefined ? task.debug : body.debug ? 1 : 0, now, body.module);
    } else if (body.action === 'pause') {
      db.prepare("UPDATE tasks SET status=CASE WHEN status='running' THEN 'pause_requested' ELSE 'paused' END,updated_at=? WHERE module=?").run(now, body.module);
    } else if (body.action === 'start' || body.action === 'restart') {
      if (['running','queued','pause_requested'].includes(String(task.status))) return Response.json({ error: '任务正在运行或已排队' }, { status: 409 });
      const resume=body.action==='start'&&['paused','failed'].includes(String(task.status));
      db.prepare("UPDATE tasks SET status='queued',run_id=?,updated_at=? WHERE module=?").run(resume ? task.run_id : null, now, body.module);
    } else return Response.json({ error: '操作无效' }, { status: 400 });
    return Response.json({ ok: true });
  } catch (error) { return Response.json({ error: error instanceof Error ? error.message : '配置失败' }, { status: 400 }); }
  finally { db.close(); }
}
