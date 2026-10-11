import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { V2Sync } from './sync.mjs';
import { ModuleLog, requestSettings } from './request.mjs';
import { getState,setState } from './database.mjs';
import {enqueueDueTasks,nextQueuedTask,yieldToHigherPriority} from './scheduler.mjs';

const sync=new V2Sync({filename:resolve(process.env.V2_SQLITE_PATH||'docker-data/v2/eve-v2.db'),logRoot:resolve(process.env.V2_LOG_PATH||'docker-data/v2/logs'),base:process.env.ESI_BASE_URL,...requestSettings()});
const owner=crypto.randomUUID();
const lease=getState(sync.db,'worker');if(lease&&Date.now()-lease.heartbeat<30000)throw new Error('Another V2 worker owns the lease');
setState(sync.db,'worker',{owner,heartbeat:Date.now()});
// A crashed process cannot own a running task after its lease has expired.
sync.db.prepare("UPDATE tasks SET status='queued' WHERE status='running'").run();
sync.db.prepare("UPDATE tasks SET status='paused' WHERE status='pause_requested'").run();
let stopping=false,lastCleanup=0;
const stop=()=>{stopping=true;const reason=new Error('后台进程停止，任务保留断点等待恢复');reason.code='WORKER_STOP';for(const controller of sync.controllers.values())controller.abort(reason);};
process.on('SIGTERM',stop);
process.on('SIGINT',stop);
const heartbeat=setInterval(()=>{
  if(stopping)return;
  setState(sync.db,'worker',{owner,heartbeat:Date.now()});
  for(const [module,controller] of sync.controllers){const task=sync.db.prepare('SELECT status FROM tasks WHERE module=?').get(module);if(task.status==='pause_requested')controller.abort();}
  try{enqueueDueTasks(sync.db);yieldToHigherPriority(sync);}catch(error){console.error(`[v2:scheduler] ${error.message}`);}
},1000);
try {
  while(!stopping) {
    if(Date.now()-lastCleanup>3600000){ModuleLog.clean(sync.logRoot);lastCleanup=Date.now();}
    enqueueDueTasks(sync.db);
    const task=nextQueuedTask(sync.db);
    if(task){try{await sync.run(task.module);}catch(error){console.error(`[v2:${task.module}] ${error.message}`);}}
    else await delay(1000);
  }
} finally {clearInterval(heartbeat);setState(sync.db,'worker',null);sync.db.close();}
