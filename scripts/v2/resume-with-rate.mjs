// One-off V2 bootstrap handoff. Never restart an unpublished contract snapshot.
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readlinkSync } from 'node:fs';
import { resolve, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';

export function remainingModules(tasks) {
  const status=new Map(tasks.map(task=>[task.module,task.status]));
  if(status.get('contracts')!=='complete') throw new Error('合同尚未完整发布，禁止交接');
  return ['history','items'].filter(module=>status.get(module)!=='complete');
}

export function isBootstrapCommand(argv) {
  return /^node(?:js)?$/.test(basename(argv[0]||'')) &&
    argv[1]==='scripts/v2/cli.mjs' && argv[2]==='sync' &&
    argv[3]==='catalog,orders,contracts,history,items' && argv.length===4;
}

export async function resumeWithRate(pid,rate=10) {
  if(!Number.isSafeInteger(pid)||pid<2) throw new Error('必须提供明确的 V2 初始化进程 PID');
  if(!Number.isFinite(rate)||rate<1||rate>10) throw new Error('本次提速限定为每秒 1～10 次请求');
  const root=resolve(fileURLToPath(new URL('../../',import.meta.url)));
  const filename=resolve(process.env.V2_SQLITE_PATH||`${root}/docker-data/v2/eve-v2.db`);
  const db=new DatabaseSync(filename,{readOnly:true});db.exec('PRAGMA busy_timeout=15000;');
  const alive=()=>{
    try {
      const argv=readFileSync(`/proc/${pid}/cmdline`,'utf8').split('\0').filter(Boolean);
      if(!argv.length) return false; // Exited zombie awaiting its parent's reap.
      if(!isBootstrapCommand(argv)||readlinkSync(`/proc/${pid}/cwd`)!==root) throw new Error('目标进程身份不符，停止交接');
      return true;
    } catch(error) {if(error.code==='ENOENT'||error.code==='ESRCH')return false;throw error;}
  };
  const tasks=()=>db.prepare('SELECT module,status,processed,remaining FROM tasks').all();
  try {
    if(!alive()) throw new Error('原 V2 初始化进程已退出，未进行重启');
    console.log(`等待本轮合同完整发布；后续 V2 请求速率 ${rate}/秒，并发上限保持 8。`);
    const deadline=Date.now()+60*60*1000;
    while(tasks().find(task=>task.module==='contracts')?.status!=='complete') {
      const contract=tasks().find(task=>task.module==='contracts');
      if(contract?.status==='failed'||contract?.status==='paused') throw new Error(`合同状态 ${contract.status}，未进行交接`);
      if(!alive()) throw new Error('原初始化进程在合同发布前退出，未进行交接');
      if(Date.now()>deadline) throw new Error('等待合同发布超过一小时，未进行交接');
      await delay(1000);
    }
    // History commits per-item checkpoints; item completion is committed per ID.
    // Re-check process identity immediately before sending a signal.
    if(alive()) {
      process.kill(pid,'SIGTERM');
      const stopDeadline=Date.now()+15000;
      while(alive()) {if(Date.now()>stopDeadline)throw new Error('原进程未退出，不启动重复任务');await delay(200);}
    }
    const modules=remainingModules(tasks());
    if(!modules.length) {console.log('剩余模块已完成，无需重启。');return;}
    console.log(`合同已完整发布，断点继续：${modules.join(',')}；速率 ${rate}/秒。`);
    const child=spawn(process.execPath,['scripts/v2/cli.mjs','sync',modules.join(',')],{
      cwd:root,env:{...process.env,V2_SQLITE_PATH:filename,V2_REQUEST_RATE:String(rate)},stdio:'inherit',
    });
    await new Promise((resolve,reject)=>{
      child.once('error',reject);
      child.once('exit',(code,signal)=>code===0?resolve():reject(new Error(`V2 同步退出：${signal||code}`)));
    });
  } finally {db.close();}
}

if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  resumeWithRate(Number(process.argv[2]),Number(process.argv[3]||10)).catch(error=>{console.error(error.message);process.exitCode=1;});
}
