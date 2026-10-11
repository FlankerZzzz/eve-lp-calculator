import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync,rmSync,existsSync,readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import ts from 'typescript';
import { openV2 } from '../scripts/v2/database.mjs';
import { getLpPolicy,saveLpPolicy,updateLpFlags,lpFlagsForOffer } from '../scripts/v2/lp-policy.mjs';
import { exportLines,previewImport,stageImport,commitImport,MAINTENANCE_FORMAT } from '../scripts/v2/maintenance.mjs';
import { V2Sync } from '../scripts/v2/sync.mjs';
const fixture=t=>{
  const dir=mkdtempSync(join(tmpdir(),'eve-maintenance-')),file=join(dir,'v2.db'),db=openV2(file),root=join(dir,'maintenance');
  t.after(()=>{db.close();rmSync(dir,{recursive:true,force:true});});
  for(const id of [1,2,3])db.prepare("INSERT INTO items(type_id,name_zh,source,published,updated_at) VALUES(?,?,'SDE',1,'fixture')").run(id,`物品${id}`);
  const offer=(corporation_id,offer_id,faction_id=500001,type_id=1,ak_cost=0)=>{
    const flags=lpFlagsForOffer(db,{corporation_id,offer_id,faction_id,type_id,ak_cost});
    db.prepare('INSERT INTO lp_exchange(corporation_id,offer_id,faction_id,corporation_name_zh,type_id,quantity,lp_cost,isk_cost,ak_cost,updated_at,is_high_sec,manual_blocked,is_guard,is_invalid,is_blocked) VALUES(?,?,?,?,?,1,10,0,?,?,?,?,?,?,?)').run(corporation_id,offer_id,faction_id,`军团${corporation_id}`,type_id,ak_cost,'fixture',flags.is_high_sec,flags.manual_blocked,flags.is_guard,flags.is_invalid,flags.is_blocked);
  };
  return {dir,file,db,root,offer};
};
const packet=(module,entries)=>[JSON.stringify({format:MAINTENANCE_FORMAT,version:1,module}),...entries.map(entry=>JSON.stringify(entry))].join('\n');
const idle=db=>db.exec("UPDATE tasks SET status='idle'");

test('LP categories are stored per offer; switches do not erase manual or overlapping blocks',t=>{
  const {db,offer}=fixture(t);offer(1000179,1);offer(1,2,500017);offer(2,3);offer(3,4,500001,1,1);
  assert.equal(db.prepare('SELECT is_guard FROM lp_exchange WHERE offer_id=1').get().is_guard,'Y');
  assert.equal(db.prepare('SELECT is_blocked FROM lp_exchange WHERE offer_id=1').get().is_blocked,'N');
  updateLpFlags(db,2,3,{is_blocked:'Y'});let config=getLpPolicy(db);saveLpPolicy(db,{...config,block_guard:true,block_invalid:false},config.version);
  assert.deepEqual(db.prepare('SELECT is_blocked FROM lp_exchange ORDER BY offer_id').all().map(r=>r.is_blocked),['Y','N','Y','N']);
  config=getLpPolicy(db);config.rules.push({scope:'item',target_id:1,field:'is_blocked',value:'Y',reason:'批量'});saveLpPolicy(db,config,config.version);
  config=getLpPolicy(db);saveLpPolicy(db,{...config,block_guard:false},config.version);assert.ok(db.prepare('SELECT is_blocked FROM lp_exchange').all().every(r=>r.is_blocked==='Y'));
  config=getLpPolicy(db);config.rules=config.rules.filter(r=>r.field!=='is_blocked');saveLpPolicy(db,config,config.version);
  assert.equal(db.prepare('SELECT is_blocked FROM lp_exchange WHERE offer_id=3').get().is_blocked,'Y');
  assert.throws(()=>saveLpPolicy(db,config,config.version),/修改/);
});
test('LP classifications override broadly to narrowly and catalog applies persistent rules to new offers',async t=>{
  const {db,offer,file,dir}=fixture(t);offer(1,1);offer(2,2);let config=getLpPolicy(db);
  config.rules.push({scope:'faction',target_id:500001,field:'is_invalid',value:'Y',reason:'测试分类'},{scope:'corporation',target_id:1,field:'is_invalid',value:'N',reason:'例外'});saveLpPolicy(db,config,config.version);
  assert.deepEqual(db.prepare('SELECT is_invalid FROM lp_exchange ORDER BY offer_id').all().map(r=>r.is_invalid),['N','Y']);
  updateLpFlags(db,1,1,{is_invalid:'Y'});assert.equal(db.prepare('SELECT is_invalid FROM lp_exchange WHERE offer_id=1').get().is_invalid,'Y');
  config=getLpPolicy(db);config.rules.push({scope:'corporation',target_id:1,field:'is_blocked',value:'Y',reason:'所有当前和将来兑换'});saveLpPolicy(db,config,config.version);
  const sync=new V2Sync({filename:file,logRoot:join(dir,'logs')});
  sync.request=async path=>({data:path==='/universe/factions/'?[{faction_id:500001,name:'势力'}]:path==='/corporations/npccorps/'?[1]:path==='/corporations/1/'?{name:'军团',faction_id:500001}:path==='/universe/names/'?[{name:'军团'}]:[{offer_id:1,type_id:1,quantity:1,lp_cost:10,isk_cost:0},{offer_id:9,type_id:2,quantity:1,lp_cost:10,isk_cost:0}]});
  try{await sync.run('catalog');}finally{sync.db.close();}
  assert.ok(db.prepare('SELECT is_blocked FROM lp_exchange WHERE corporation_id=1').all().every(row=>row.is_blocked==='Y'));
  assert.equal(db.prepare('SELECT is_invalid FROM lp_exchange WHERE offer_id=1').get().is_invalid,'Y');
});
test('legacy exclusion flags split without changing effective visibility; reopening does not reset settings',t=>{
  const {db,offer,file}=fixture(t);offer(1,1);offer(2,2,500017);offer(1000179,3);updateLpFlags(db,1,1,{is_blocked:'Y'});
  const before=db.prepare('SELECT is_blocked FROM lp_exchange ORDER BY offer_id').all();
  db.prepare("DELETE FROM runtime_state WHERE key='lp_policy_config'").run();const opened=openV2(file);opened.close();
  assert.deepEqual(db.prepare('SELECT is_blocked FROM lp_exchange ORDER BY offer_id').all(),before);
  assert.equal(db.prepare('SELECT manual_blocked FROM lp_exchange WHERE offer_id=1').get().manual_blocked,'Y');
  assert.equal(db.prepare('SELECT manual_blocked FROM lp_exchange WHERE offer_id=2').get().manual_blocked,'N');
  const config=getLpPolicy(db);saveLpPolicy(db,{...config,block_invalid:false},config.version);const again=openV2(file);again.close();assert.equal(getLpPolicy(db).block_invalid,false);
});
test('repair imports are previewed, atomic, backed up, protected and stale-safe',t=>{
  const {db,root}=fixture(t);const row=db.prepare('SELECT * FROM items WHERE type_id=1').get();
  const text=packet('items',[{table:'items',row:{...row,name_zh:'已修复'}}]);
  const plan=previewImport(db,text,'items');assert.equal(plan.summary.update,1);assert.equal(db.prepare('SELECT name_zh FROM items WHERE type_id=1').get().name_zh,'物品1');
  const id=stageImport(root,plan),result=commitImport(db,root,id,{protect:true});assert.ok(existsSync(join(root,result.backup)));assert.equal(db.prepare('SELECT name_zh,sync_protected FROM items WHERE type_id=1').get().sync_protected,'Y');
  assert.equal(db.prepare('SELECT COUNT(*) n FROM items').get().n,3);assert.throws(()=>commitImport(db,root,id),/ENOENT/);
  idle(db);assert.equal(previewImport(db,text,'items').summary.protected,1);
  const second=db.prepare('SELECT * FROM items WHERE type_id=2').get(),next=previewImport(db,packet('items',[{table:'items',row:{...second,name_zh:'新名'}}]),'items'),nextId=stageImport(root,next);
  db.exec("UPDATE items SET name_zh='其他人编辑' WHERE type_id=2");assert.throws(()=>commitImport(db,root,nextId),/已变化/);assert.equal(db.prepare('SELECT name_zh FROM items WHERE type_id=2').get().name_zh,'其他人编辑');
});
test('repair imports reject unauthorized module, duplicate keys, missing references, bad values and running tasks',t=>{
  const {db}=fixture(t),row=db.prepare('SELECT * FROM items WHERE type_id=1').get(),entry={table:'items',row};
  assert.throws(()=>previewImport(db,packet('orders',[]),'orders'),/不允许/);
  assert.throws(()=>previewImport(db,packet('items',[entry,entry]),'items'),/重复/);
  assert.throws(()=>previewImport(db,packet('items',[{...entry,row:{...row,volume:-1}}]),'items'),/非负/);
  assert.throws(()=>previewImport(db,packet('items',[{...entry,row:{...row,extra:'SQL'}}]),'items'),/未知/);
  assert.throws(()=>previewImport(db,packet('items',[{table:'recipe_materials',row:{blueprint_id:999,material_type_id:1,quantity:1}}]),'items'),/不存在/);
  db.exec("UPDATE tasks SET status='running' WHERE module='orders'");assert.throws(()=>previewImport(db,packet('items',[entry]),'items'),/空闲/);
});
test('export streaming retains original fields and includes full contract basket; history supports date and item filters',t=>{
  const {db}=fixture(t);
  for(const date of ['2026-10-09','2026-10-10'])db.prepare('INSERT INTO history VALUES(?,?,?,?,?,?,?,?)').run(1,date,10,12,9,300,1,'N');
  const lines=[...exportLines(db,'history',{type_id:'1',from:'2026-10-10'})].map(JSON.parse);assert.equal(lines.length,2);assert.equal(lines[1].row.order_count,1);
  db.prepare('INSERT INTO contracts VALUES(?,?,?)').run(100,JSON.stringify({price:20,title:'原始字段'}),'generation');
  for(const [id,type] of [[1,1],[2,2]])db.prepare('INSERT INTO contract_items VALUES(?,?,?,?,?,?)').run(100,id,type,1,2,JSON.stringify({type_id:type,quantity:2,is_included:true}));
  const contracts=[...exportLines(db,'contracts',{type_id:1})].map(JSON.parse);assert.equal(contracts.length,4);assert.equal(JSON.parse(contracts[1].row.raw_json).title,'原始字段');
  assert.throws(()=>[...exportLines(db,'history',{from:'2026-02-30'})],/日期/);
});
test('LP package imports retain manual blocks, derive visibility and protect requirements with their offer',t=>{
  const {db,root,offer}=fixture(t);offer(1,1);db.prepare('INSERT INTO lp_requirements VALUES(?,?,?,?)').run(1,1,2,2);
  const rows=[...exportLines(db,'catalog')].map(JSON.parse),offerRow=rows.find(row=>row.table==='lp_exchange').row;offerRow.manual_blocked='Y';offerRow.is_blocked='N';
  const text=rows.map(JSON.stringify).join('\n'),plan=previewImport(db,text,'catalog'),id=stageImport(root,plan);commitImport(db,root,id,{protect:true});
  assert.equal(db.prepare('SELECT is_blocked FROM lp_exchange').get().is_blocked,'Y');
  idle(db);const req=db.prepare('SELECT * FROM lp_requirements').get();const protectedPlan=previewImport(db,packet('catalog',[{table:'lp_requirements',row:{...req,quantity:9}}]),'catalog');assert.equal(protectedPlan.summary.protected,1);
});
test('visual schedules share Cron, preserve custom schedules and validate ranges',()=>{
  const code=ts.transpileModule(readFileSync(new URL('../lib/sync-schedule.ts',import.meta.url),'utf8'),{compilerOptions:{module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2022}}).outputText;
  return import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}`).then(({cronToSchedule,scheduleToCron,defaultSchedule})=>{
    for(const expression of ['*/15 * * * *','10 */2 * * *','30 0 * * *','0 9 * * 1'])assert.equal(scheduleToCron(cronToSchedule(expression)),expression);
    assert.equal(cronToSchedule('0 9,15,18,21 * * *'),null);assert.throws(()=>scheduleToCron({...defaultSchedule,kind:'minutes',interval:60}),/1–59/);
    assert.throws(()=>scheduleToCron({...defaultSchedule,time:'24:00'}),/时间/);
  });
});

test('actual maintenance APIs enforce admin auth, preview before writes, native streaming and version checks',async t=>{
  const {db,file,dir,offer}=fixture(t);offer(1,1);offer(2,2,500017);
  const previous=Object.fromEntries(['V2_SQLITE_PATH','V2_LOG_PATH','SYNC_ADMIN_TOKEN'].map(key=>[key,process.env[key]]));
  Object.assign(process.env,{V2_SQLITE_PATH:file,V2_LOG_PATH:join(dir,'logs'),SYNC_ADMIN_TOKEN:'maintenance-test-only'});
  t.after(()=>{for(const [key,value] of Object.entries(previous))if(value===undefined)delete process.env[key];else process.env[key]=value;});
  const load=async path=>{
    const url=new URL(`../${path}`,import.meta.url),output=ts.transpileModule(readFileSync(url,'utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ESNext}}).outputText;
    const wired=output.replace(/from (["'])(\.\.?\/[^"']+)\1/g,(_,quote,spec)=>`from ${JSON.stringify(new URL(spec.endsWith('.mjs')?spec:`${spec}.ts`,url).href)}`);
    return import(`data:text/javascript;base64,${Buffer.from(wired).toString('base64')}`);
  };
  const api=await load('app/api/v2/data/route.ts'),rules=await load('app/api/v2/lp-rules/route.ts'),exports=await load('app/api/v2/data/export/route.ts');
  const headers={'x-sync-admin-token':'maintenance-test-only'},jsonHeaders={...headers,'content-type':'application/json'};
  const request=(path,init)=>new Request(`http://localhost${path}`,init);
  assert.equal((await api.GET(request('/api/v2/data?module=items'))).status,403);
  assert.equal((await rules.POST(request('/api/v2/lp-rules',{method:'POST',body:'{}'}))).status,403);
  const lookup=await (await rules.GET(request('/api/v2/lp-rules?scope=corporation&q=1',{headers}))).json();assert.ok(lookup.rows.some(row=>row.id===1));
  const form=new FormData();form.set('module','items');form.set('admin_token','maintenance-test-only');
  const response=await exports.POST(request('/api/v2/data/export',{method:'POST',body:form}));assert.equal(response.status,200);assert.match(response.headers.get('content-disposition'),/attachment/);
  const lines=(await response.text()).trim().split('\n').map(JSON.parse);assert.equal(lines.length,4);assert.ok(!JSON.stringify(lines).includes('maintenance-test-only'));
  lines[1].row.name_zh='接口修复';const upload=new FormData();upload.set('module','items');upload.set('file',new File([lines.map(JSON.stringify).join('\n')],'repair.jsonl'));
  const checked=await api.POST(request('/api/v2/data',{method:'POST',headers,body:upload}));assert.equal(checked.status,200);const preview=await checked.json();assert.equal(preview.summary.update,1);
  assert.equal(db.prepare('SELECT name_zh FROM items WHERE type_id=1').get().name_zh,'物品1');
  const saved=await api.POST(request('/api/v2/data',{method:'POST',headers:jsonHeaders,body:JSON.stringify({preview_id:preview.preview_id})}));assert.equal(saved.status,200);assert.equal(db.prepare('SELECT name_zh FROM items WHERE type_id=1').get().name_zh,'接口修复');
  const config=getLpPolicy(db),next={...config,block_guard:true};
  const forecast=await rules.POST(request('/api/v2/lp-rules',{method:'POST',headers:jsonHeaders,body:JSON.stringify({config:next,expected_version:config.version,preview:true})}));assert.equal(forecast.status,200);assert.equal(getLpPolicy(db).block_guard,false);
  const applied=await rules.POST(request('/api/v2/lp-rules',{method:'POST',headers:jsonHeaders,body:JSON.stringify({config:next,expected_version:config.version})}));assert.equal(applied.status,200);assert.equal(getLpPolicy(db).block_guard,true);
  const stale=await rules.POST(request('/api/v2/lp-rules',{method:'POST',headers:jsonHeaders,body:JSON.stringify({config:next,expected_version:config.version})}));assert.equal(stale.status,400);
  idle(db);const denied=new FormData();denied.set('module','orders');denied.set('file',new File([packet('orders',[{table:'orders',row:{}}])],'bad.jsonl'));
  assert.equal((await api.POST(request('/api/v2/data',{method:'POST',headers,body:denied}))).status,400);
});
