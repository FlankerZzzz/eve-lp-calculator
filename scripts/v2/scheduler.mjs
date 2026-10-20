import {getState,setState,transaction} from './database.mjs';
import {matchesCron} from './cron.mjs';

export const taskPriority=module=>({orders:0,contracts:1,rankings:2,geography:2,items:3,catalog:4,history:5}[module]??6);
export function nextQueuedTask(db) {
  return db.prepare("SELECT module FROM tasks WHERE status='queued'").all().sort((a,b)=>taskPriority(a.module)-taskPriority(b.module)).at(0);
}
// Independent of task execution. A restart also catches up at most the last day, once per module.
export function enqueueDueTasks(db,now=new Date()) {
  const end=Math.floor(now.getTime()/60000)*60000,minute=new Date(end).toISOString().slice(0,16);
  const prior=getState(db,'scheduler_cursor'),previous=prior?Date.parse(`${prior}:00.000Z`):NaN;
  if(previous===end)return;
  const start=Number.isFinite(previous)&&previous<end?Math.max(previous+60000,end-86400000):end;
  transaction(db,()=>{
    for(const task of db.prepare('SELECT * FROM tasks WHERE automatic=1 AND cron IS NOT NULL').all()) {
      let due;
      for(let t=start;t<=end;t+=60000)if(matchesCron(task.cron,new Date(t)))due=new Date(t).toISOString().slice(0,16);
      if(!due||getState(db,`cron:${task.module}`)===due)continue;
      setState(db,`cron:${task.module}`,due);
      if(['running','queued','pause_requested'].includes(task.status))continue;
      db.prepare("UPDATE tasks SET run_id=CASE WHEN status IN ('failed','paused') THEN run_id ELSE NULL END,status='queued',error=NULL,updated_at=? WHERE module=?").run(now.toISOString(),task.module);
    }
    setState(db,'scheduler_cursor',minute);
  });
}
export function yieldToHigherPriority(sync) {
  const queued=nextQueuedTask(sync.db);if(!queued)return;
  for(const [module,controller] of sync.controllers) {
    if(['items','catalog','history'].includes(module)&&taskPriority(queued.module)<taskPriority(module)&&!controller.signal.aborted) {
      const reason=new Error(`让出执行权给 ${queued.module}，保留 ${module} 断点`);reason.code='SYNC_YIELD';controller.abort(reason);
    }
  }
}
