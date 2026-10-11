import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mkdtempSync,rmSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {spawn} from 'node:child_process';
import ts from 'typescript';
import {V2Sync} from '../scripts/v2/sync.mjs';
import {getState,setState} from '../scripts/v2/database.mjs';
import {enqueueDueTasks,nextQueuedTask,yieldToHigherPriority} from '../scripts/v2/scheduler.mjs';
import {resolveContractName,contractPayment} from '../lib/contract-analysis.ts';

function fixture(t) {
  const dir=mkdtempSync(join(tmpdir(),'v2-sync-hardening-')),file=join(dir,'test.db');
  const sync=new V2Sync({filename:file,logRoot:join(dir,'logs')}),events=[];
  const log={info:(event,data)=>events.push({event,...data}),payload:()=>{}};
  const item=(id,{volume=null,packaged=null,protectedFlag='N',published=1}={})=>sync.db.prepare("INSERT INTO items(type_id,name_zh,name_en,source,published,volume,packaged_volume,sync_protected,updated_at) VALUES(?,?,?,'SDE',?,?,?,?,?)").run(id,'物品'+id,'Item '+id,published,volume,packaged,protectedFlag,'old');
  sync.db.exec('UPDATE tasks SET automatic=0');
  t.after(()=>{sync.db.close();rmSync(dir,{recursive:true,force:true});});return {sync,dir,file,events,log,item};
}
const order=id=>({order_id:id,type_id:34,location_id:60003760,system_id:30000142,is_buy_order:false,price:9,volume_remain:10,volume_total:10,min_volume:1,range:'region',issued:'2026-10-10T00:00:00Z',duration:90,extra_original_field:'kept'});

test('全量物品同步补已有 SDE 的空体积，保留零、非空值、来源和保护标记',async t=>{
  const {sync,item,log}=fixture(t);item(1);item(2,{volume:99});item(3,{volume:0,packaged:0});item(4,{protectedFlag:'Y'});item(5,{published:0});
  sync.sdeTypes=async()=>new Map([[1,true],[2,true],[3,true],[4,true],[5,false]]);const calls=[];
  sync.request=async(path)=>{calls.push(path);if(path==='/universe/types/')return {data:[1,2,3,4,5],pages:1};return {data:{type_id:Number(path.split('/').at(-2)),volume:0,packaged_volume:7}};};
  await sync.items('run',log);
  assert.deepEqual(calls,['/universe/types/','/universe/types/1/','/universe/types/2/']);
  assert.deepEqual({...sync.db.prepare('SELECT volume,packaged_volume,source FROM items WHERE type_id=1').get()},{volume:0,packaged_volume:7,source:'SDE'});
  assert.equal(sync.db.prepare('SELECT volume FROM items WHERE type_id=2').get().volume,99);
  assert.equal(sync.db.prepare('SELECT volume FROM items WHERE type_id=4').get().volume,null);
  assert.equal(getState(sync.db,'universe').volume_fill.filled,2);
});
test('ESI 缺字段/404 仍记未知，成功断点复用，新轮次重查；无效字段报错',async t=>{
  const {sync,item,log}=fixture(t);item(1);item(2);let calls=0;
  sync.request=async path=>{calls++;if(path.endsWith('/2/'))throw Object.assign(new Error('not found'),{status:404});return {data:{type_id:1}};};
  assert.equal((await sync.fillMissingVolumes('run',log)).unresolved,2);
  assert.equal((await sync.fillMissingVolumes('run',log)).reused,2);assert.equal(calls,2);
  await sync.fillMissingVolumes('new',log);assert.equal(calls,4);
  sync.request=async()=>({data:{type_id:1,volume:-1}});
  await assert.rejects(sync.fillMissingVolumes('bad',log),/Invalid volume/);
  sync.request=async()=>({data:null});
  await assert.rejects(sync.fillMissingVolumes('null-response',log),/Invalid volume type response/);
  assert.equal(sync.db.prepare('SELECT volume FROM items WHERE type_id=1').get().volume,null);
});
test('查询期间设置保护，不覆盖；中断后已完成的体积数据无需重复查询',async t=>{
  const {sync,item,log}=fixture(t);item(1);item(2);let fail=true;const calls=[];
  sync.pool.limit=1;
  sync.request=async path=>{calls.push(path);if(path.endsWith('/2/')&&fail)throw new Error('network');return {data:{type_id:Number(path.split('/').at(-2)),volume:5,packaged_volume:5}};};
  await assert.rejects(sync.fillMissingVolumes('run',log),/network/);fail=false;
  sync.request=async path=>{calls.push(path);sync.db.exec("UPDATE items SET sync_protected='Y' WHERE type_id=2");return {data:{type_id:2,volume:7,packaged_volume:7}};};
  await sync.fillMissingVolumes('run',log);
  assert.equal(calls.filter(p=>p.endsWith('/1/')).length,1);
  assert.equal(sync.db.prepare('SELECT volume FROM items WHERE type_id=2').get().volume,null);
});
test('重复订单与页数变动触发整轮重采，成功后原始字段及缓存原子发布',async t=>{
  for(const scenario of ['duplicate','pages']){
    const {sync,log}=fixture(t);let round=0;
    sync.request=async(_path,{page})=>{if(page===1)round++;return {data:[order(round===1&&scenario==='duplicate'?1:page)],pages:round===1&&scenario==='pages'&&page===2?3:2};};
    await sync.orders('run',log);assert.equal(round,2);
    assert.equal(sync.db.prepare('SELECT COUNT(*) n FROM orders').get().n,2);
    assert.equal(getState(sync.db,'orders').generation,'run');
    assert.equal(JSON.parse(sync.db.prepare('SELECT raw_json FROM orders LIMIT 1').get().raw_json).extra_original_field,'kept');
  }
});
test('持续不稳定最多三轮，失败不替换旧快照，也不发布漏页结果',async t=>{
  const {sync,log}=fixture(t);setState(sync.db,'orders',{generation:'old'});let rounds=0;
  sync.db.prepare('INSERT INTO quote_cache VALUES(34,8,9,10,10,?)').run('old');
  sync.request=async(_p,{page})=>{if(page===1)rounds++;return {data:[order(page)],pages:page===1?2:3};};
  await assert.rejects(sync.orders('bad',log),/page count changed/);assert.equal(rounds,3);
  assert.equal(getState(sync.db,'orders').generation,'old');assert.equal(sync.db.prepare('SELECT sell_price FROM quote_cache').get().sell_price,9);
  assert.equal(sync.db.prepare('SELECT COUNT(*) n FROM orders WHERE generation=?').get('bad').n,0);
});
test('调度不依赖任务结束，跨分钟/重启补排一次，优先订单合同，历史不重复入队',t=>{
  const {sync}=fixture(t);const db=sync.db;
  db.exec("UPDATE tasks SET automatic=1,status='complete' WHERE module IN ('orders','contracts','history'); UPDATE tasks SET status='running',run_id='history-run' WHERE module='history'");
  enqueueDueTasks(db,new Date('2026-10-10T16:30:00Z'));
  assert.equal(nextQueuedTask(db).module,'orders');assert.equal(db.prepare("SELECT status FROM tasks WHERE module='contracts'").get().status,'queued');
  assert.equal(db.prepare("SELECT run_id FROM tasks WHERE module='history'").get().run_id,'history-run');
  db.exec("UPDATE tasks SET status='complete' WHERE module IN ('orders','contracts')");
  enqueueDueTasks(db,new Date('2026-10-10T16:30:50Z'));assert.equal(nextQueuedTask(db),undefined);
  enqueueDueTasks(db,new Date('2026-10-10T17:01:00Z'));
  assert.equal(nextQueuedTask(db).module,'orders');
  assert.equal(db.prepare("SELECT status FROM tasks WHERE module='contracts'").get().status,'queued');
});
test('长任务让出执行权后排队恢复，断点和 run_id 保留，速率恢复；成功回收旧断点',async t=>{
  const {sync}=fixture(t);sync.db.prepare("INSERT INTO checkpoints(module,run_id,key) VALUES('history','old','1')").run();
  sync.history=async runId=>{sync.saveCheckpoint('history',runId,'34',{done:true});await delay(10000,undefined,{signal:sync.context.signal});};
  const running=sync.run('history');sync.db.exec("UPDATE tasks SET status='queued' WHERE module='orders'");yieldToHigherPriority(sync);await running;
  const task=sync.db.prepare("SELECT * FROM tasks WHERE module='history'").get();assert.equal(task.status,'queued');assert.equal(task.error,null);
  assert.ok(sync.checkpoint('history',task.run_id,'34'));assert.equal(nextQueuedTask(sync.db).module,'orders');
  sync.history=async runId=>assert.equal(runId,task.run_id);await sync.run('history');
  assert.equal(sync.db.prepare("SELECT COUNT(*) n FROM checkpoints WHERE module='history' AND run_id='old'").get().n,0);
});
test('真实后台进程恢复遗留 running，正常退出重新排队但保留断点',async t=>{
  const {sync,file,dir}=fixture(t);
  sync.db.exec("UPDATE tasks SET status='running',run_id='persisted' WHERE module='history'");
  sync.saveCheckpoint('history','persisted','34',{done:true});
  const source=`import {V2Sync} from ${JSON.stringify(new URL('../scripts/v2/sync.mjs',import.meta.url).href)};
    V2Sync.prototype.history=async function(runId){console.log(JSON.stringify({runId,checkpoint:this.checkpoint('history',runId,'34')}));process.kill(process.pid,'SIGTERM');await new Promise((resolve,reject)=>{this.context.signal.addEventListener('abort',()=>reject(this.context.signal.reason),{once:true});});};
    await import(${JSON.stringify(new URL('../scripts/v2/worker.mjs',import.meta.url).href)});`;
  const child=spawn(process.execPath,['--input-type=module','-e',source],{env:{...process.env,V2_SQLITE_PATH:file,V2_LOG_PATH:join(dir,'child-logs')},stdio:['ignore','pipe','pipe']});
  let output='',errors='';child.stdout.on('data',x=>output+=x);child.stderr.on('data',x=>errors+=x);
  const timeout=setTimeout(()=>child.kill('SIGKILL'),10000);
  try{const code=await new Promise((resolve,reject)=>{child.on('error',reject);child.on('close',resolve);});assert.equal(code,0,errors);assert.deepEqual(JSON.parse(output.trim()),{runId:'persisted',checkpoint:{done:true}});}
  finally{clearTimeout(timeout);}
  const task=sync.db.prepare("SELECT status,run_id FROM tasks WHERE module='history'").get();assert.equal(task.status,'queued');assert.equal(task.run_id,'persisted');assert.equal(getState(sync.db,'worker'),null);
});
test('同名物品必须明确选择 ID 或唯一英文名；PLEX 不当作免费 ISK',()=>{
  const rows=[{type_id:84236,name_zh:'中型粒子流强化器 I',name_en:'Medium Exotic Particle Flow Booster I'},{type_id:84237,name_zh:'中型粒子流强化器 I',name_en:'Unused Rig'}];
  assert.equal(resolveContractName('中型粒子流强化器 I',rows).ambiguous,true);
  assert.equal(resolveContractName('84236',rows).item.type_id,84236);
  assert.equal(resolveContractName('Unused Rig',rows).item.type_id,84237);
  assert.deepEqual(contractPayment({payment_type:'PLEX',unit_price:null,plex_quantity:500,set_count:2}),{currency:'PLEX',value:250});
  assert.deepEqual(contractPayment({payment_type:'ISK',unit_price:100}),{currency:'ISK',value:100});
  assert.equal(contractPayment({payment_type:'ISK',unit_price:null}).value,null);
});
test('实际询价接口分离支付物品、拒绝同名歧义、支持 ID；手动运行完成任务开始新轮次',async t=>{
  const {sync,item,file}=fixture(t),db=sync.db,slot='hardening-'+crypto.randomUUID();item(1,{volume:0,packaged:0});item(2,{volume:1,packaged:1});
  db.exec("UPDATE items SET name_zh='同名' WHERE type_id IN (1,2)");
  db.prepare('INSERT INTO contracts VALUES(?,?,?)').run(10,JSON.stringify({contract_id:10,type:'item_exchange',price:0}),'old');
  const insert=db.prepare('INSERT INTO contract_items VALUES(?,?,?,?,?,?)');
  for(const row of [{record_id:1,type_id:1,is_included:true,quantity:2},{record_id:2,type_id:2,is_included:false,quantity:7}])insert.run(10,row.record_id,row.type_id,row.is_included?1:0,row.quantity,JSON.stringify(row));
  globalThis[slot]={prepare:sql=>{let values=[];const s={bind:(...v)=>{values=v;return s;},first:async()=>db.prepare(sql).get(...values)??null,all:async()=>({results:db.prepare(sql).all(...values)})};return s;}};
  t.after(()=>delete globalThis[slot]);
  const dataModule=s=>`data:text/javascript;base64,${Buffer.from(s).toString('base64')}`;
  const load=async path=>{const url=new URL('../'+path,import.meta.url),output=ts.transpileModule(readFileSync(url,'utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ESNext}}).outputText;return import(dataModule(output.replace(/from (["'])(\.\.?\/[^"']+)\1/g,(_,q,spec)=>`from ${JSON.stringify(spec.endsWith('/db/business')?dataModule(`export const ensureBusinessSchema=async()=>globalThis[${JSON.stringify(slot)}]`):spec.endsWith('/lib/esi-server')?dataModule('export const MARKET_REGION_ID=10000002; export const esiPost=async()=>({inventory_types:[]})'):new URL(spec.endsWith('.mjs')?spec:spec+'.ts',url).href)}`)));};
  const api=await load('app/api/data/contract-analysis/route.ts');
  for(const input of [null,[],{}, {text:123}]) {
    const response=await api.POST(new Request('http://localhost/api/data/contract-analysis',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(input)}));
    assert.equal(response.status,400);assert.ok((await response.json()).error);
  }
  const large=await api.POST(new Request('http://localhost/api/data/contract-analysis',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({text:'a'.repeat(1024*1024+1)})}));assert.equal(large.status,413);
  const tooMany=await api.POST(new Request('http://localhost/api/data/contract-analysis',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({text:Array.from({length:501},(_,i)=>`${i+1}\t1`).join('\n')})}));assert.equal(tooMany.status,422);
  const originalAdapter=globalThis[slot];
  for(const payload of ['null','{}','[null]','[{"type_id":1}]','not json','[]']) {
    globalThis[slot]={prepare:()=>({bind(){return this;},first:async()=>({payload,status:'ready'})})};
    const r=await api.GET(new Request('http://localhost/api/data/contract-analysis?contract_id=10'));assert.equal(r.status,422);assert.ok((await r.json()).error);
  }
  globalThis[slot]=originalAdapter;
  const request=(path,body)=>new Request('http://localhost'+path,body?{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)}:undefined);
  const received=await (await api.GET(request('/api/data/contract-analysis?contract_id=10'))).json();assert.deepEqual(received.rows.map(r=>r.type_id),[1]);assert.equal(received.payment_items[0].quantity,7);
  db.exec('UPDATE contract_items SET is_included=0,raw_json=json_set(raw_json,\'$.is_included\',json(\'false\'))');
  assert.equal((await api.GET(request('/api/data/contract-analysis?contract_id=10'))).status,422);
  assert.equal((await api.POST(request('/api/data/contract-analysis',{text:'同名\t1'}))).status,409);
  const selected=await (await api.POST(request('/api/data/contract-analysis',{text:'1\t3'}))).json();assert.equal(selected.rows[0].type_id,1);assert.equal(selected.rows[0].quantity,3);
  const mixed=await (await api.POST(request('/api/data/contract-analysis',{text:'1\t3\n未匹配测试\t2\n未匹配测试\t4'}))).json();
  assert.deepEqual(mixed.unresolved,['未匹配测试']);assert.deepEqual(mixed.unresolved_items,[{name:'未匹配测试',quantity:6}]);assert.equal(mixed.rows.length,1);assert.equal(mixed.rows[0].quantity,3);
  const unmatched=await api.POST(request('/api/data/contract-analysis',{text:'未匹配测试\t2'}));assert.equal(unmatched.status,422);
  const unmatchedData=await unmatched.json();assert.equal(unmatchedData.code,'UNRESOLVED_ITEMS');assert.deepEqual(unmatchedData.unresolved_items,[{name:'未匹配测试',quantity:2}]);
  const prior={V2_SQLITE_PATH:process.env.V2_SQLITE_PATH,SYNC_ADMIN_TOKEN:process.env.SYNC_ADMIN_TOKEN};Object.assign(process.env,{V2_SQLITE_PATH:file,SYNC_ADMIN_TOKEN:'hardening-test'});
  try{
    const control=await load('app/api/v2/sync/route.ts');db.exec("UPDATE tasks SET status='complete',run_id='old' WHERE module='items'");
    const r=await control.POST(new Request('http://localhost/api/v2/sync',{method:'POST',headers:{'x-sync-admin-token':'hardening-test','content-type':'application/json'},body:JSON.stringify({module:'items',action:'start'})}));assert.equal(r.status,200);assert.equal(db.prepare("SELECT run_id FROM tasks WHERE module='items'").get().run_id,null);
  }finally{for(const [k,v] of Object.entries(prior))if(v===undefined)delete process.env[k];else process.env[k]=v;}
});
