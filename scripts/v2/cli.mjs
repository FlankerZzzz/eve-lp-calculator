import { resolve } from 'node:path';
import { openV2 } from './database.mjs';
import { ModuleLog, requestSettings } from './request.mjs';
import { importSde } from './sde.mjs';
import { V2Sync } from './sync.mjs';
import { pruneErroneousUnpublishedItems } from './item-maintenance.mjs';
import { enableV2Business } from './readiness.mjs';

const command=process.argv[2];
const filename=resolve(process.env.V2_SQLITE_PATH||'docker-data/v2/eve-v2.db');
const db=openV2(filename);
const log=new ModuleLog(resolve(process.env.V2_LOG_PATH||'docker-data/v2/logs'),command==='items-cleanup'?'items':command||'cli',new Date().toISOString(),true);
try {
  if(command==='sde') console.log(JSON.stringify(await importSde(db,resolve(process.argv[3]||'docker-data/v2/sde.zip'),log)));
  else if(command==='enable') console.log(JSON.stringify(enableV2Business(db,log)));
  else if(command==='items-cleanup') {
    if(db.prepare("SELECT 1 FROM tasks WHERE status='running' AND module='items'").get())throw new Error('Stop item synchronization before cleanup');
    const backup=`${filename}.before-items-cleanup-${new Date().toISOString().replaceAll(':','-')}.db`;
    db.prepare('VACUUM INTO ?').run(backup);log.info('item_cleanup_backup',{backup});
    console.log(JSON.stringify({backup,...pruneErroneousUnpublishedItems(db,process.argv[3],log)}));
  }
  else if(command==='sync') {
    const sync=new V2Sync({filename,logRoot:resolve(process.env.V2_LOG_PATH||'docker-data/v2/logs'),base:process.env.ESI_BASE_URL,...requestSettings()});
    let stopping=false;
    const stop=()=>{stopping=true;for(const controller of sync.controllers.values())controller.abort(new Error('V2 CLI stopped; checkpoints retained'));};
    process.once('SIGTERM',stop);process.once('SIGINT',stop);
    try {for(const taskModule of (process.argv[3]||'catalog,orders,contracts,history,items').split(',')){if(stopping)break;console.log(`V2 starting ${taskModule}`);await sync.run(taskModule);console.log(`V2 complete ${taskModule}`);}}
    finally {process.removeListener('SIGTERM',stop);process.removeListener('SIGINT',stop);sync.db.close();}
  }
  else if(command==='status') console.log(JSON.stringify({tasks:db.prepare('SELECT * FROM tasks').all(),counts:Object.fromEntries(['items','recipes','recipe_materials','lp_exchange','orders','contracts','history'].map(table=>[table,db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n]))}));
  else throw new Error('Usage: cli.mjs sde [file.zip] | items-cleanup <ISO timestamp> | enable | sync [modules] | status');
} catch(error) {log.info('error',{message:error.message});console.error(error.stack);process.exitCode=1;}
finally {db.close();}
