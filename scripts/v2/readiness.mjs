import {getState,setState,transaction} from './database.mjs';
import {rebuildV2Rankings} from './rankings.mjs';

export function enableV2Business(db,log) {
  if(db.prepare('PRAGMA quick_check').get().quick_check!=='ok'||db.prepare('PRAGMA foreign_key_check').all().length)throw new Error('V2 数据完整性检查失败');
  for(const taskModule of ['items','catalog','orders','contracts','history','rankings'])if(!db.prepare('SELECT last_success FROM tasks WHERE module=?').get(taskModule)?.last_success)throw new Error(`正式切换等待 ${taskModule} 首次同步完成`);
  for(const table of ['items','lp_exchange','quote_cache','orders','contracts','history'])if(!db.prepare(`SELECT 1 FROM ${table} LIMIT 1`).get())throw new Error(`正式切换缺少 ${table} 数据`);
  for(const taskModule of ['orders','contracts']){
    const state=getState(db,taskModule),count=state?.generation?db.prepare(`SELECT COUNT(*) n FROM ${taskModule} WHERE generation=?`).get(state.generation).n:0;
    if(!count||count!==(state.order_count??state.count))throw new Error(`正式切换缺少 ${taskModule} 完整快照`);
  }
  const rankings=rebuildV2Rankings(db);
  if(!rankings.history_complete)throw new Error('历史同步未完成');
  return transaction(db,()=>{
    const result={production_ready:true,validated_at:new Date().toISOString(),rankings};
    setState(db,'business_ready',true);setState(db,'business_validation',result);
    db.prepare("DELETE FROM runtime_state WHERE key IN ('business_test_ready','business_test_validation')").run();
    log?.info('business_enabled',result);return result;
  });
}
