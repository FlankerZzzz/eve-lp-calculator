import assert from 'node:assert/strict';
import check from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { spawn } from 'node:child_process';
import { V2Sync } from '../scripts/v2/sync.mjs';
import { openV2, getState, setState } from '../scripts/v2/database.mjs';
import { RequestPool } from '../scripts/v2/request.mjs';

const header=id=>({contract_id:id,type:'item_exchange',price:100,start_location_id:1,date_issued:'2026-01-01T00:00:00Z',extra_original_field:'kept'});
const item=id=>({record_id:id,type_id:34,quantity:5,is_included:true,extra_original_field:'kept'});
function fixture(t) {
  const folder=mkdtempSync(join(tmpdir(),'eve-v2-contract-check-')),filename=join(folder,'v2.db'),logRoot=join(folder,'logs');
  const connections=[];
  const create=()=>{const sync=new V2Sync({filename,logRoot});connections.push(sync);return sync;};
  t.after(()=>{for(const sync of connections){try{sync.db.close();}catch{ /* Already closed to simulate a restart. */ }}rmSync(folder,{recursive:true,force:true});});
  return {filename,logRoot,create};
}

check('合同分页和明细落盘；失败不发布；重新打开数据库和排队恢复只请求失败页',async t=>{
  const {create}=fixture(t),first=create(),calls=[];
  first.db.prepare('INSERT INTO contracts VALUES(?,?,?)').run(999,JSON.stringify(header(999)),'old');
  first.db.prepare('INSERT INTO contract_items VALUES(?,?,?,?,?,?)').run(999,999,34,1,5,JSON.stringify(item(999)));
  setState(first.db,'contracts',{generation:'old',count:1});
  first.request=async(path,{page})=>{
    calls.push(`${path}:${page}`);
    if(path==='/contracts/public/10000002/')return {data:page===1?[header(11)]:[header(22),header(33)],pages:2};
    if(path.endsWith('/11/')){if(page===2)throw new Error('Invalid JSON response: empty body');return {data:[item(1)],pages:2};}
    if(path.endsWith('/22/'))return {data:[],pages:1};
    if(path.endsWith('/33/')){const error=new Error('HTTP 404');error.status=404;throw error;}
    throw new Error(`Unexpected request ${path}`);
  };
  await assert.rejects(first.run('contracts'),/1 contract details incomplete/);
  assert.equal(first.db.prepare("SELECT processed FROM tasks WHERE module='contracts'").get().processed,2);
  assert.equal(first.db.prepare('SELECT COUNT(*) AS n FROM contracts').get().n,1);
  assert.equal(getState(first.db,'contracts').generation,'old');
  const runId=first.db.prepare("SELECT run_id FROM tasks WHERE module='contracts'").get().run_id;
  assert.ok(first.checkpoint('contracts',runId,'detail:11:page:1'));
  assert.equal(first.checkpoint('contracts',runId,'detail:11:page:2'),null);
  first.db.close();
  const resumed=create(),retried=[];
  resumed.db.prepare("UPDATE tasks SET status='queued' WHERE module='contracts'").run();
  resumed.request=async(path,{page})=>{retried.push(`${path}:${page}`);assert.equal(path,'/contracts/public/items/11/');assert.equal(page,2);return {data:[item(2)],pages:2};};
  await resumed.run('contracts');
  assert.deepEqual(retried,['/contracts/public/items/11/:2']);
  assert.equal(getState(resumed.db,'contracts').generation,runId);
  assert.deepEqual(resumed.db.prepare('SELECT contract_id FROM contracts ORDER BY contract_id').all().map(row=>row.contract_id),[11]);
  assert.equal(resumed.db.prepare('SELECT COUNT(*) AS n FROM contract_items').get().n,2);
  assert.equal(JSON.parse(resumed.db.prepare('SELECT raw_json FROM contracts WHERE contract_id=11').get().raw_json).extra_original_field,'kept');
  assert.equal(JSON.parse(resumed.db.prepare('SELECT raw_json FROM contract_items WHERE record_id=1').get().raw_json).extra_original_field,'kept');
  assert.equal(resumed.db.prepare("SELECT COUNT(*) AS n FROM checkpoints WHERE module='contracts'").get().n,0);
  assert.deepEqual(resumed.db.prepare('PRAGMA foreign_key_check').all(),[]);
  // A crash after snapshot commit but before task completion must not refetch anything.
  resumed.db.prepare("UPDATE tasks SET status='running' WHERE module='contracts'").run();
  resumed.request=async()=>{throw new Error('Must not refetch an already published run');};
  await resumed.run('contracts');
});

check('V2 检查点升级保留旧 catalog/history 完成标记，不新增业务表',t=>{
  const {filename}=fixture(t);
  const previous=new DatabaseSync(filename);
  previous.exec("CREATE TABLE checkpoints(module TEXT,run_id TEXT,key TEXT,PRIMARY KEY(module,run_id,key)); INSERT INTO checkpoints VALUES('history','run','34');");previous.close();
  const db=openV2(filename);
  try {
    assert.deepEqual({...db.prepare('SELECT module,run_id,key,payload FROM checkpoints').get()},{module:'history',run_id:'run',key:'34',payload:null});
    db.prepare("INSERT INTO checkpoints(module,run_id,key) VALUES('catalog','run','123')").run();
    assert.equal(db.prepare('PRAGMA synchronous').get().synchronous,2);
  } finally {db.close();}
});

check('目录分页中断后只请求缺失页，拿全目录前不拉取明细',async t=>{
  const {create}=fixture(t),first=create(),calls=[];
  first.request=async(path,{page})=>{
    calls.push(`${path}:${page}`);assert.equal(path,'/contracts/public/10000002/');
    if(page===2)throw new Error('Directory page failed');
    return {data:[header(11)],pages:2};
  };
  await assert.rejects(first.run('contracts'),/Directory page failed/);
  assert.equal(calls.length,2);first.db.close();
  const resumed=create(),retried=[];
  resumed.request=async(path,{page})=>{
    retried.push(`${path}:${page}`);
    if(path==='/contracts/public/10000002/'){assert.equal(page,2);return {data:[header(22)],pages:2};}
    return {data:[],pages:1};
  };
  await resumed.run('contracts');
  assert.equal(retried.filter(path=>path.startsWith('/contracts/public/10000002/')).length,1);
  assert.equal(resumed.db.prepare('SELECT COUNT(*) AS n FROM contracts').get().n,0);
});

check('合同发布失败回滚正式数据，保留全部已获取检查点供再次提交',async t=>{
  const {create}=fixture(t),sync=create();
  sync.request=async path=>({data:path==='/contracts/public/10000002/'?[header(11)]:[item(1)],pages:1});
  const original=sync.buildContractCache;
  sync.buildContractCache=()=>{throw new Error('Simulated publication failure');};
  await assert.rejects(sync.run('contracts'),/publication failure/);
  assert.equal(sync.db.prepare('SELECT COUNT(*) AS n FROM contracts').get().n,0);
  assert.equal(getState(sync.db,'contracts'),null);
  assert.ok(sync.db.prepare("SELECT 1 FROM checkpoints WHERE key='detail:11:done'").get());
  sync.buildContractCache=original;
  sync.request=async()=>{throw new Error('Successful pages must not be fetched again');};
  await sync.run('contracts');
  assert.equal(sync.db.prepare('SELECT COUNT(*) AS n FROM contracts').get().n,1);
});

check('进程被 SIGKILL 后，已提交合同页仍可由新进程恢复',async t=>{
  const {filename,logRoot,create}=fixture(t);
  const moduleUrl=new URL('../scripts/v2/sync.mjs',import.meta.url).href;
  const source=`
    import {V2Sync} from ${JSON.stringify(moduleUrl)};
    const sync=new V2Sync({filename:process.env.CHECK_DB,logRoot:process.env.CHECK_LOG});
    sync.request=async(path,{page})=>{
      if(path==='/contracts/public/10000002/') return {data:[${JSON.stringify(header(11))}],pages:1};
      if(page===1) return {data:[${JSON.stringify(item(1))}],pages:2};
      process.stdout.write('checkpoint-ready\\n');
      return new Promise(()=>{setInterval(()=>{},1000);});
    };
    await sync.run('contracts');
  `;
  const child=spawn(process.execPath,['--input-type=module','-e',source],{env:{...process.env,CHECK_DB:filename,CHECK_LOG:logRoot},stdio:['ignore','pipe','pipe']});
  let output='',errors='';child.stderr.on('data',chunk=>{errors+=chunk;});
  const exited=new Promise((resolve,reject)=>{child.once('error',reject);child.once('exit',(code,signal)=>resolve({code,signal}));});
  t.after(()=>{if(child.exitCode===null&&!child.signalCode)child.kill('SIGKILL');});
  await new Promise((resolve,reject)=>{
    const timeout=setTimeout(()=>reject(new Error(`Child did not save a checkpoint: ${errors}`)),10000);
    child.stdout.on('data',chunk=>{output+=chunk;if(output.includes('checkpoint-ready')){clearTimeout(timeout);resolve();}});
    child.once('error',error=>{clearTimeout(timeout);reject(error);});
    child.once('exit',()=>{if(!output.includes('checkpoint-ready')){clearTimeout(timeout);reject(new Error(errors));}});
  });
  child.kill('SIGKILL');assert.equal((await exited).signal,'SIGKILL');
  const resumed=create();let requested=0;
  resumed.request=async(path,{page})=>{requested++;assert.equal(path,'/contracts/public/items/11/');assert.equal(page,2);return {data:[item(2)],pages:2};};
  await resumed.run('contracts');
  assert.equal(requested,1);assert.equal(resumed.db.prepare('SELECT COUNT(*) AS n FROM contract_items').get().n,2);
});

check('HTTP 200 空正文不是合法空数组，错误带接口和正文长度',async()=>{
  const pool=new RequestPool({fetchImpl:async()=>new Response('',{status:200})}),records=[];
  await assert.rejects(pool.request('https://example.test/contracts/11/',{retrySafe:false,log:{info:(event,data)=>records.push({event,...data})}}),error=>error.code==='INVALID_JSON_RESPONSE'&&error.httpStatus===200&&error.responseBytes===0&&error.emptyResponse===true&&error.status===undefined&&/HTTP 200, 0 bytes/.test(error.message));
  assert.ok(records.some(row=>row.event==='invalid_json'&&row.empty&&row.path==='/contracts/11/'));
});

const emptyResponse=()=>Object.assign(new Error('Invalid JSON response: HTTP 200, 0 bytes'),{code:'INVALID_JSON_RESPONSE',httpStatus:200,responseBytes:0,emptyResponse:true});
check('HTTP 200 空明细只在刷新完整目录确认已消失后跳过，保留其他合同',async t=>{
  const {create,logRoot}=fixture(t),sync=create();let directoryCalls=0;
  sync.request=async(path,{page})=>{
    if(path==='/contracts/public/10000002/'){
      directoryCalls++;return {data:directoryCalls===1?[header(11),header(22)]:page===1?[header(11)]:[header(33)],pages:directoryCalls===1?1:2};
    }
    if(path.endsWith('/22/'))throw emptyResponse();
    return {data:[item(1)],pages:1};
  };
  await sync.run('contracts');assert.equal(directoryCalls,3);
  assert.deepEqual(sync.db.prepare('SELECT contract_id FROM contracts').all().map(row=>row.contract_id),[11]);
  assert.equal(sync.db.prepare('SELECT COUNT(*) n FROM contract_items').get().n,1);
  assert.equal(sync.db.prepare("SELECT status FROM tasks WHERE module='contracts'").get().status,'complete');
  const {readFileSync,readdirSync}=await import('node:fs');
  const log=readFileSync(join(logRoot,'contracts',readdirSync(join(logRoot,'contracts')).find(name=>name.endsWith('.jsonl'))),'utf8').split('\n').filter(Boolean).map(line=>JSON.parse(line));
  assert.ok(log.some(row=>row.event==='contract_disappeared_after_empty_response'&&row.contract_id===22&&row.directory_count===2));
});
check('空响应合同仍在刷新目录中时保持失败，不凭空编造空明细',async t=>{
  const {create}=fixture(t),sync=create();let directoryCalls=0;
  sync.request=async path=>{if(path==='/contracts/public/10000002/'){directoryCalls++;return {data:[header(11)],pages:1};}throw emptyResponse();};
  await assert.rejects(sync.run('contracts'),/1 contract details incomplete/);
  assert.equal(directoryCalls,2);assert.equal(sync.db.prepare('SELECT COUNT(*) n FROM contracts').get().n,0);
  const runId=sync.db.prepare("SELECT run_id FROM tasks WHERE module='contracts'").get().run_id;
  assert.equal(sync.checkpoint('contracts',runId,'detail:11:done'),null);
});
check('复查目录有失败页、页数变化或重复 ID 时不得丢弃空响应合同',async t=>{
  for(const fault of ['failure','changed','duplicate']){
    const {create}=fixture(t),sync=create();let directoryCalls=0;
    sync.request=async(path,{page})=>{
      if(path!=='/contracts/public/10000002/')throw emptyResponse();
      directoryCalls++;if(directoryCalls===1)return {data:[header(11)],pages:1};
      if(page===1)return {data:[header(22)],pages:2};
      if(fault==='failure')throw new Error('Recheck page failed');
      return {data:[header(fault==='duplicate'?22:33)],pages:fault==='changed'?3:2};
    };
    await assert.rejects(sync.run('contracts'),/Recheck page failed|Page count changed|Duplicate contract in refreshed directory/);
    assert.equal(sync.db.prepare('SELECT COUNT(*) n FROM contracts').get().n,0);
    const runId=sync.db.prepare("SELECT run_id FROM tasks WHERE module='contracts'").get().run_id;
    assert.equal(sync.checkpoint('contracts',runId,'detail:11:done'),null);
  }
});
check('损坏但非空 JSON 和确认空数组略过，不冒充消失或阻塞整轮同步',async t=>{
  const {create}=fixture(t),sync=create();let directoryCalls=0;
  sync.request=async path=>{
    if(path==='/contracts/public/10000002/'){directoryCalls++;return {data:[header(11),header(22)],pages:1};}
    if(path.endsWith('/11/'))return {data:[],pages:1};
    throw Object.assign(new Error('Damaged JSON'),{code:'INVALID_JSON_RESPONSE',httpStatus:200,responseBytes:1,emptyResponse:false});
  };
  await sync.run('contracts');assert.equal(directoryCalls,1);
  assert.equal(sync.db.prepare('SELECT COUNT(*) n FROM contracts').get().n,0);
  assert.equal(sync.db.prepare("SELECT status FROM tasks WHERE module='contracts'").get().status,'complete');
});

check('错误明细整体跳过不保留部分物品，其他有效合同正常发布并清理旧错误合同',async t=>{
  const {create}=fixture(t),sync=create();
  sync.db.prepare('INSERT INTO contracts VALUES(?,?,?)').run(999,JSON.stringify(header(999)),'old');
  sync.request=async path=>({data:path==='/contracts/public/10000002/'?[header(11),header(22),header(33)]:path.endsWith('/11/')?[item(1)]:path.endsWith('/22/')?[item(2),null]:{error:'invalid shape'},pages:1});
  await sync.run('contracts');
  assert.deepEqual(sync.db.prepare('SELECT contract_id FROM contracts').all().map(r=>r.contract_id),[11]);
  assert.equal(sync.db.prepare('SELECT COUNT(*) n FROM contract_items').get().n,1);
});
check('网络或 503 不按错误合同忽略，保留上一轮和成功明细断点',async t=>{
  const {create}=fixture(t),sync=create();setState(sync.db,'contracts',{generation:'old',count:1});
  sync.db.prepare('INSERT INTO contracts VALUES(?,?,?)').run(999,JSON.stringify(header(999)),'old');
  sync.request=async path=>{if(path==='/contracts/public/10000002/')return {data:[header(11),header(22)],pages:1};if(path.endsWith('/22/'))throw Object.assign(new Error('upstream unavailable'),{status:503});return {data:[item(1)],pages:1};};
  await assert.rejects(sync.run('contracts'),/incomplete/);
  assert.equal(getState(sync.db,'contracts').generation,'old');
  assert.deepEqual(sync.db.prepare('SELECT contract_id FROM contracts').all().map(r=>r.contract_id),[999]);
  const run=sync.db.prepare("SELECT run_id FROM tasks WHERE module='contracts'").get().run_id;
  assert.equal(sync.checkpoint('contracts',run,'detail:11:done').status,'ready');
  assert.equal(sync.checkpoint('contracts',run,'detail:22:done'),null);
});
