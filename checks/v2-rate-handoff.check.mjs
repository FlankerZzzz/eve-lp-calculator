import assert from 'node:assert/strict';
import check from 'node:test';
import { remainingModules, isBootstrapCommand, resumeWithRate } from '../scripts/v2/resume-with-rate.mjs';

check('提速交接不得中断未发布合同快照',()=>{
  for(const status of ['idle','running','failed','paused']) {
    assert.throws(()=>remainingModules([{module:'contracts',status}]),/合同尚未完整发布/);
  }
});
check('交接只恢复尚未完成的历史和物品模块',()=>{
  const tasks=[{module:'contracts',status:'complete'},{module:'history',status:'running'},{module:'items',status:'idle'}];
  assert.deepEqual(remainingModules(tasks),['history','items']);
  tasks[1].status='complete';assert.deepEqual(remainingModules(tasks),['items']);
  tasks[2].status='complete';assert.deepEqual(remainingModules(tasks),[]);
});
check('仅允许已识别的 V2 初始化进程，不允许操作旧服务',()=>{
  const argv=['/usr/bin/node','scripts/v2/cli.mjs','sync','catalog,orders,contracts,history,items'];
  assert.equal(isBootstrapCommand(argv),true);
  assert.equal(isBootstrapCommand(['node','scripts/sync-daemon.mjs']),false);
  assert.equal(isBootstrapCommand(['node','scripts/v2/worker.mjs']),false);
  assert.equal(isBootstrapCommand([...argv,'extra']),false);
});
check('提速参数必须明确且不超过本次上限',async()=>{
  await assert.rejects(resumeWithRate(0,10),/PID/);
  for(const rate of [0,11,NaN,Infinity]) await assert.rejects(resumeWithRate(999999,rate),/1～10/);
});
