import assert from 'node:assert/strict';
import check from 'node:test';
import { mkdtempSync,rmSync,readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import ts from 'typescript';
import { openV2,getState } from '../scripts/v2/database.mjs';
import { migrateLpFlags,updateLpFlags,lpFlagMap,filterLpRankingRows,visibleImplantSetsSql,contractImplantSetsSql,getLpPolicy,saveLpPolicy } from '../scripts/v2/lp-policy.mjs';
import { initialLpFlags,businessLpVisibility,HIDDEN_FACTIONS,HIDDEN_CORPORATIONS } from '../lib/data-policy.ts';
import { V2Sync } from '../scripts/v2/sync.mjs';
import { rebuildV2Rankings } from '../scripts/v2/rankings.mjs';

function fixture(t) {
  const dir=mkdtempSync(join(tmpdir(),'eve-v2-lp-policy-')),file=join(dir,'v2.db'),db=openV2(file);
  t.after(()=>{db.close();rmSync(dir,{recursive:true,force:true});});
  const item=db.prepare("INSERT OR IGNORE INTO items(type_id,name_zh,name_en,source,published,updated_at) VALUES(?,?,?,'SDE',1,'fixture')");
  for(let id=1;id<=20;id++)item.run(id,`物品${id}`,`Item ${id}`);
  const insert=db.prepare('INSERT INTO lp_exchange(corporation_id,offer_id,faction_id,corporation_name_zh,type_id,quantity,lp_cost,isk_cost,ak_cost,updated_at,is_high_sec,is_blocked) VALUES(?,?,?,?,?,1,10,0,?,?,?,?)');
  const offer=(corp,id,faction=500001,ak=0,type=1)=>{const flags=initialLpFlags(corp,faction,ak);insert.run(corp,id,faction,`军团${corp}`,type,ak,'fixture',flags.is_high_sec,flags.is_blocked);};
  return {dir,file,db,offer};
}
check('V2 高安与屏蔽初始值逐项沿用旧规则，非高安不等于屏蔽',()=>{
  for(const entity of HIDDEN_FACTIONS)assert.equal(initialLpFlags(100001,entity.id,0).is_blocked,'Y');
  for(const entity of HIDDEN_CORPORATIONS)assert.equal(initialLpFlags(entity.id,500001,0).is_blocked,'Y');
  assert.deepEqual(initialLpFlags(100001,500001,0),{is_high_sec:'Y',is_blocked:'N'});
  assert.deepEqual(initialLpFlags(1000179,500001,0),{is_high_sec:'N',is_blocked:'N'});
  assert.deepEqual(initialLpFlags(100001,500010,0),{is_high_sec:'N',is_blocked:'N'});
  assert.equal(initialLpFlags(100001,500001,1).is_blocked,'Y');
});
check('V2 已有目录标记一次性迁移，重开数据库不覆盖人工维护',t=>{
  const {db,offer,file}=fixture(t);
  offer(1,1);offer(1000283,2);offer(2,3,500017);offer(3,4,500001,5);
  db.exec('DROP VIEW lp_offers; DROP TRIGGER lp_flags_changed; ALTER TABLE lp_exchange DROP COLUMN is_high_sec; ALTER TABLE lp_exchange DROP COLUMN is_blocked;');
  db.prepare("DELETE FROM runtime_state WHERE key='lp_flags_seeded'").run();migrateLpFlags(db);
  assert.deepEqual(db.prepare('SELECT is_blocked FROM lp_exchange ORDER BY offer_id').all().map(r=>r.is_blocked),['N','Y','Y','Y']);
  updateLpFlags(db,1,1,{is_high_sec:'N',is_blocked:'Y'});
  const reopened=openV2(file);
  try{assert.equal(reopened.prepare('SELECT is_high_sec,is_blocked FROM lp_offers WHERE offer_id=1').get().is_high_sec,'N');assert.equal(reopened.prepare('SELECT is_blocked FROM lp_offers WHERE offer_id=1').get().is_blocked,'Y');}finally{reopened.close();}
  assert.equal(db.prepare('SELECT COUNT(*) n FROM lp_exchange').get().n,4);
});
check('V2 维护以军团+方案为键，Y/N约束，变更日志版本与重算排队',t=>{
  const {db,offer}=fixture(t);offer(1,7);offer(2,7);
  const result=updateLpFlags(db,1,7,{is_blocked:'Y'});
  assert.equal(result.before.is_blocked,'N');assert.equal(result.after.is_blocked,'Y');
  assert.equal(db.prepare('SELECT is_blocked FROM lp_exchange WHERE corporation_id=2').get().is_blocked,'N');
  assert.equal(db.prepare("SELECT status FROM tasks WHERE module='rankings'").get().status,'queued');
  const revision=getState(db,'lp_policy_revision');updateLpFlags(db,1,7,{is_blocked:'Y'});assert.equal(getState(db,'lp_policy_revision'),revision);
  assert.throws(()=>updateLpFlags(db,1,7,{is_blocked:'maybe'}),/Y 或 N/);
  assert.throws(()=>updateLpFlags(db,1,7,{isk_cost:0}),/只能/);
  assert.throws(()=>updateLpFlags(db,999,7,{is_blocked:'Y'}),/不存在/);
  assert.throws(()=>db.prepare('UPDATE lp_exchange SET is_blocked=?').run('bad'),/CHECK/);
  db.prepare("UPDATE lp_exchange SET is_high_sec='N' WHERE corporation_id=2").run();assert.equal(getState(db,'lp_policy_revision'),revision+1);
});
check('V2 选择器和详情使用数据库标记，旧服务仍使用旧规则，快照读时防御过滤',t=>{
  const {db,offer}=fixture(t);offer(1,1);offer(1,2);offer(1000283,3);offer(2,4,500010);
  updateLpFlags(db,1,1,{is_blocked:'Y'});
  const policy=businessLpVisibility(true);
  const visible=db.prepare(`SELECT o.corporation_id,o.offer_id FROM lp_offers o JOIN corporations c USING(corporation_id) WHERE ${policy.corporation} AND ${policy.offer} ORDER BY o.offer_id`).all();
  assert.deepEqual(visible.map(r=>r.offer_id),[2,4]);
  const old=businessLpVisibility(false);assert.match(old.corporation,/500013/);assert.match(old.offer,/ak_cost/);assert.doesNotMatch(old.offer,/is_blocked/);
  const rows=filterLpRankingRows([{corporation_id:1,offer_id:1},{corporation_id:1,offer_id:2},{corporation_id:1000283,offer_id:3},{corporation_id:999,offer_id:2}],lpFlagMap(db));
  assert.deepEqual(rows.map(r=>r.offer_id),[2]);assert.equal(rows[0].is_high_sec,'Y');
});
check('V2 catalog 再同步保留已有两种标记，新方案按旧规则初始化',async t=>{
  const {file,dir,db,offer}=fixture(t);offer(1,1);updateLpFlags(db,1,1,{is_high_sec:'N',is_blocked:'Y'});
  const sync=new V2Sync({filename:file,logRoot:join(dir,'logs')});
  sync.request=async path=>({data:path==='/universe/factions/'?[{faction_id:500001,name:'势力'}]:path==='/corporations/npccorps/'?[1]:path==='/corporations/1/'?{name:'军团',faction_id:500001}:path==='/universe/names/'?[{name:'军团'}]:[{offer_id:1,type_id:1,quantity:1,lp_cost:20,isk_cost:100},{offer_id:2,type_id:2,quantity:1,lp_cost:10,isk_cost:0,ak_cost:1}]});
  try{await sync.run('catalog');}finally{sync.db.close();}
  const rows=db.prepare('SELECT offer_id,lp_cost,is_high_sec,is_blocked FROM lp_exchange ORDER BY offer_id').all();
  assert.equal(rows[0].lp_cost,20);assert.equal(rows[0].is_high_sec,'N');assert.equal(rows[0].is_blocked,'Y');
  assert.equal(rows[1].is_high_sec,'Y');assert.equal(rows[1].is_blocked,'Y');
});
check('V2 catalog 复用旧标准 SDE 军团势力映射，不依赖接口必带 faction_id',async t=>{
  const {file,dir,db}=fixture(t),sync=new V2Sync({filename:file,logRoot:join(dir,'logs')});
  sync.request=async path=>({data:path==='/universe/factions/'?[{faction_id:500001,name:'加达里'}]:path==='/corporations/npccorps/'?[1000035]:path==='/corporations/1000035/'?{name:'加达里海军'}:path==='/universe/names/'?[{name:'加达里海军'}]:[{offer_id:1,type_id:1,quantity:1,lp_cost:10,isk_cost:0}]});
  try{await sync.run('catalog');}finally{sync.db.close();}
  const row=db.prepare('SELECT faction_id,faction_name_zh,is_high_sec FROM lp_exchange').get();assert.equal(row.faction_id,500001);assert.equal(row.faction_name_zh,'加达里');assert.equal(row.is_high_sec,'Y');
});
check('V2 脑插六件需同一军团完整可见，屏蔽单件不影响另一个有效军团',t=>{
  const {db,offer}=fixture(t);
  db.prepare('INSERT INTO implant_sets VALUES(?,?,?,?,?,?,?,?,?)').run('set','套装','Set',1,2,3,4,5,6);
  for(const corp of [1,2]){db.prepare('INSERT INTO corporation_sets VALUES(?,?,?)').run(corp,500001,'set');for(let id=1;id<=6;id++)offer(corp,id,500001,0,id);}
  updateLpFlags(db,1,1,{is_blocked:'Y'});assert.equal(db.prepare(visibleImplantSetsSql()).all().length,1);
  updateLpFlags(db,2,2,{is_blocked:'Y'});assert.equal(db.prepare(visibleImplantSetsSql()).all().length,0);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM lp_exchange').get().n,12);
});
check('蓝图脑插合同按成品自动识别，无需人工名单，支付与屏蔽规则不变',t=>{
  const {db,offer,file,dir}=fixture(t);
  const levels=['Alpha','Beta','Gamma','Delta','Epsilon','Omega'];
  for(let id=1;id<=6;id++) {
    db.prepare('UPDATE items SET name_en=? WHERE type_id=?').run(`High-grade Rapture ${levels[id-1]}`,id);
    db.prepare('INSERT INTO recipes VALUES(?,?,1,1,?,?)').run(id+10,id,'N','fixture');
    offer(1,id,500001,0,id+10);
  }
  assert.equal(db.prepare('SELECT COUNT(*) n FROM implant_sets').get().n,0);
  assert.equal(db.prepare(contractImplantSetsSql()).all().length,1);
  // Split offers across corporations or direct/blueprint sources must not form a set.
  updateLpFlags(db,1,1,{is_blocked:'Y'});offer(2,1,500001,0,11);offer(1,7,500001,0,1);
  assert.equal(db.prepare(contractImplantSetsSql()).all().length,0);
  updateLpFlags(db,1,1,{is_blocked:'N'});
  const headers=[{contract_id:101,price:1200},{contract_id:102,price:0},{contract_id:103,price:100},{contract_id:104,price:1200}];
  for(const header of headers) {
    db.prepare('INSERT INTO contracts VALUES(?,?,?)').run(header.contract_id,JSON.stringify({...header,type:'item_exchange',date_expired:'2099-01-01',start_location_id:1}),'fixture');
    const entries=Array.from({length:6},(_,i)=>({record_id:i+1,type_id:i+1+(header.contract_id===104?10:0),quantity:2,is_included:true}));
    if([102,103].includes(header.contract_id))entries.push({record_id:7,type_id:44992,quantity:20,is_included:false});
    for(const entry of entries)db.prepare('INSERT INTO contract_items VALUES(?,?,?,?,?,?)').run(header.contract_id,entry.record_id,entry.type_id,entry.is_included?1:0,entry.quantity,JSON.stringify(entry));
  }
  const sync=new V2Sync({filename:file,logRoot:join(dir,'logs')});
  try {
    sync.buildContractCache();
    const cached=JSON.parse(db.prepare('SELECT payload FROM contract_cache WHERE set_key=?').get('1,2,3,4,5,6').payload);
    assert.deepEqual(cached.map(row=>row.contract_id),[101,102]);
    assert.equal(cached[0].unit_price,600);assert.equal(cached[1].payment_type,'PLEX');
    updateLpFlags(db,1,2,{is_blocked:'Y'});sync.buildContractCache();
    assert.equal(db.prepare('SELECT 1 FROM contract_cache WHERE set_key=?').get('1,2,3,4,5,6'),undefined);
  } finally {sync.db.close();}
});
check('V2 榜单写入按标记去重并补位，保留全局非高安，不破坏原始表',t=>{
  const {db,offer}=fixture(t);offer(1,1);offer(2,1);offer(3,2,500010,0,2);offer(4,3,500001,0,3);
  updateLpFlags(db,4,3,{is_blocked:'Y'});
  db.prepare('INSERT INTO ranking_cache VALUES(?,?,?,?,?)').run('popular',1,'old','old','{}');
  assert.throws(()=>rebuildV2Rankings(db),/首次同步/);assert.equal(db.prepare('SELECT snapshot_date FROM ranking_cache').get().snapshot_date,'old');
  db.prepare("UPDATE tasks SET last_success='fixture' WHERE module IN ('catalog','orders','history')").run();
  for(const type of [1,2,3]){db.prepare('INSERT INTO quote_cache VALUES(?,?,?,?,?,?)').run(type,10,12,100,100,'fixture');db.prepare('INSERT INTO history VALUES(?,?,?,?,?,?,?,?)').run(type,'2026-10-09',10,12,9,300,1,'N');}
  const result=rebuildV2Rankings(db);assert.equal(result.popular,2);assert.equal(result.highRatio,2);
  const rows=db.prepare("SELECT payload FROM ranking_cache WHERE list_kind='highRatio'").all().map(row=>JSON.parse(row.payload));
  assert.equal(rows.length,2);assert.ok(rows.some(row=>row.is_high_sec==='N'));assert.ok(rows.every(row=>row.is_blocked==='N'));assert.equal(rows.filter(row=>row.type_id===1).length,1);
  updateLpFlags(db,1,1,{is_blocked:'Y'});rebuildV2Rankings(db);
  assert.ok(db.prepare("SELECT payload FROM ranking_cache WHERE list_kind='highRatio'").all().map(row=>JSON.parse(row.payload)).some(row=>row.corporation_id===2));
  assert.equal(db.prepare('SELECT COUNT(*) n FROM history').get().n,3);assert.equal(db.prepare('SELECT COUNT(*) n FROM lp_exchange').get().n,4);
  assert.equal(getState(db,'rankings').policy_revision,getState(db,'lp_policy_revision'));
});
check('V2 LP 维护 API 需要管理授权，公共详情和合同脑插路径均按标记处理',()=>{
  const source=path=>readFileSync(new URL(`../${path}`,import.meta.url),'utf8');
  const admin=source('app/api/v2/lp-policy/route.ts');assert.equal((admin.match(/authorizeSyncControl\(request\)/g)??[]).length,2);
  assert.match(source('app/api/data/offers/route.ts'),/o.corporation_id=\? AND \$\{visibleOffer\}/);
  assert.match(source('app/api/data/contracts/route.ts'),/contractImplantSetsSql\(\)/);
  assert.match(source('scripts/v2/sync.mjs'),/is_blocked='N'/);
  assert.match(source('app/sync-v2/page.tsx'),/<LpPolicyPanel/);
  assert.doesNotMatch(source('scripts/v2/rankings.mjs'),/is_high_sec='Y'/);
});

check('V2 实际 API 查询、详情、旧榜单和维护读写保持屏蔽一致',async t=>{
  const {db,offer,file,dir}=fixture(t),slot=`v2-api-test-${crypto.randomUUID()}`;
  const previous=Object.fromEntries(['BUSINESS_DATABASE','V2_SQLITE_PATH','V2_LOG_PATH','SYNC_ADMIN_TOKEN'].map(k=>[k,process.env[k]]));
  Object.assign(process.env,{BUSINESS_DATABASE:'v2',V2_SQLITE_PATH:file,V2_LOG_PATH:join(dir,'logs'),SYNC_ADMIN_TOKEN:'policy-test-only'});
  globalThis[slot]={prepare:sql=>{
    let values=[];
    const statement={bind:(...v)=>{values=v;return statement;},first:async()=>db.prepare(sql).get(...values)??null,all:async()=>({results:db.prepare(sql).all(...values)})};return statement;
  }};
  t.after(()=>{delete globalThis[slot];for(const [k,v] of Object.entries(previous))if(v===undefined)delete process.env[k];else process.env[k]=v;});
  const dataModule=text=>`data:text/javascript;base64,${Buffer.from(text).toString('base64')}`;
  const load=async path=>{
    const url=new URL(`../${path}`,import.meta.url);
    const output=ts.transpileModule(readFileSync(url,'utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ESNext}}).outputText;
    const wired=output.replace(/from (["'])(\.\.?\/[^"']+)\1/g,(_,quote,spec)=>{
      let target;
      if(spec.endsWith('/db/business'))target=dataModule(`export const ensureBusinessSchema=async()=>globalThis[${JSON.stringify(slot)}]`);
      else if(spec.endsWith('/lib/esi-server'))target=dataModule('export const MARKET_REGION_ID=10000002');
      else target=new URL(spec.endsWith('.mjs')?spec:`${spec}.ts`,url).href;
      return `from ${JSON.stringify(target)}`;
    });
    return import(dataModule(wired));
  };
  const options=await load('app/api/data/options/route.ts'),offers=await load('app/api/data/offers/route.ts'),contracts=await load('app/api/data/contracts/route.ts'),admin=await load('app/api/v2/lp-policy/route.ts');
  offer(1,1);offer(1,7,500001,0,7);offer(2,1);updateLpFlags(db,1,1,{is_blocked:'Y'});updateLpFlags(db,2,1,{is_blocked:'Y'});
  const request=(path,init)=>new Request(`http://localhost${path}`,init);
  assert.deepEqual((await (await options.GET()).json()).corporations.map(r=>r.corporation_id),[1]);
  assert.equal((await offers.GET(request('/api/data/offers?corporation_id=2&view=detail'))).status,404);
  const detail=await (await offers.GET(request('/api/data/offers?corporation_id=1&view=detail&page_size=all'))).json();assert.deepEqual(detail.offers.map(r=>r.offer_id),[7]);assert.equal(detail.offers[0].is_high_sec,'Y');
  const snapshot={corporation_id:1,offer_id:7,type_id:7,quantity:1,revenue_quantity:1,is_high_sec:'N',buy_price:0,materials:[]};
  for(const [rank,row] of [[1,{...snapshot,offer_id:1}],[2,snapshot]])db.prepare('INSERT INTO ranking_cache VALUES(?,?,?,?,?)').run('popular',rank,'fixture','fixture',JSON.stringify(row));
  const ranking=await (await offers.GET(request('/api/data/offers'))).json();assert.deepEqual(ranking.popular.map(r=>r.offer_id),[7]);assert.equal(ranking.popular[0].is_high_sec,'Y');
  db.prepare('INSERT INTO implant_sets VALUES(?,?,?,?,?,?,?,?,?)').run('set','套装','Set',1,2,3,4,5,6);db.prepare('INSERT INTO corporation_sets VALUES(?,?,?)').run(3,500001,'set');
  for(let id=1;id<=6;id++)offer(3,id,500001,0,id);
  assert.equal((await contracts.GET(request('/api/data/contracts?type_ids=1,2,3,4,5,6'))).status,200);
  updateLpFlags(db,3,1,{is_blocked:'Y'});assert.equal((await contracts.GET(request('/api/data/contracts?type_ids=1,2,3,4,5,6'))).status,404);
  assert.equal((await admin.GET(request('/api/v2/lp-policy'))).status,403);
  const headers={'x-sync-admin-token':'policy-test-only','content-type':'application/json'};
  const list=await (await admin.GET(request('/api/v2/lp-policy?is_blocked=Y',{headers}))).json();assert.equal(list.total,3);
  const saved=await admin.POST(request('/api/v2/lp-policy',{method:'POST',headers,body:JSON.stringify({corporation_id:1,offer_id:7,changes:{is_blocked:'Y'}})}));assert.equal(saved.status,200);
  assert.equal((await offers.GET(request('/api/data/offers?corporation_id=1&view=detail'))).status,404);
  assert.equal((await (await offers.GET(request('/api/data/offers'))).json()).popular.length,0);
  offer(1000179,20,500001,0,20);offer(4,20,500001,0,20);
  let config=getLpPolicy(db);saveLpPolicy(db,{...config,block_guard:true},config.version);
  assert.equal((await offers.GET(request('/api/data/offers?corporation_id=1000179&view=detail'))).status,404);
  assert.ok(!(await (await options.GET()).json()).corporations.some(row=>row.corporation_id===1000179));
  config=getLpPolicy(db);saveLpPolicy(db,{...config,block_guard:false},config.version);
  assert.equal((await offers.GET(request('/api/data/offers?corporation_id=1000179&view=detail'))).status,200);
  config=getLpPolicy(db);config.rules.push({scope:'item',target_id:20,field:'is_blocked',value:'Y',reason:'按物品跨军团屏蔽'});saveLpPolicy(db,config,config.version);
  for(const id of [1000179,4])assert.equal((await offers.GET(request(`/api/data/offers?corporation_id=${id}&view=detail`))).status,404);
  for(let id=1;id<=6;id++) {
    db.prepare('UPDATE items SET name_en=? WHERE type_id=?').run(`High-grade Rapture ${['Alpha','Beta','Gamma','Delta','Epsilon','Omega'][id-1]}`,id);
    db.prepare('INSERT INTO recipes VALUES(?,?,1,1,?,?)').run(id+10,id,'N','fixture');
    offer(5,id,500001,0,id+10);
  }
  assert.equal((await contracts.GET(request('/api/data/contracts?type_ids=1,2,3,4,5,6'))).status,200);
  assert.equal((await contracts.GET(request('/api/data/contracts?type_ids=11,12,13,14,15,16'))).status,404);
  updateLpFlags(db,5,2,{is_blocked:'Y'});
  assert.equal((await contracts.GET(request('/api/data/contracts?type_ids=1,2,3,4,5,6'))).status,404);
});
