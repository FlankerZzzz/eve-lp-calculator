import assert from 'node:assert/strict';
import check from 'node:test';
import { mkdtempSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { V2Sync } from '../scripts/v2/sync.mjs';
import { getState } from '../scripts/v2/database.mjs';
import { pruneErroneousUnpublishedItems } from '../scripts/v2/item-maintenance.mjs';

function fixture(t) {
  const root=mkdtempSync(join(tmpdir(),'v2-item-catalog-'));
  const sync=new V2Sync({filename:join(root,'test.db'),logRoot:root}),events=[];
  sync.sdeTypes=async()=>new Map([[34,true],[2,false]]);
  const insert=(id,published=1,protectedFlag='N',source='ESI',date='2026-10-10T14:50:00.000Z')=>sync.db.prepare('INSERT INTO items(type_id,name_zh,source,published,sync_protected,updated_at) VALUES(?,?,?,?,?,?)').run(id,`物品${id}`,source,published,protectedFlag,date);
  insert(34,1,'N','SDE');
  sync.db.prepare('UPDATE items SET volume=0.01,packaged_volume=0.01 WHERE type_id=34').run();
  const log={info:(event,data)=>events.push({event,...data}),payload:()=>{}};
  t.after(()=>{sync.db.close();rmSync(root,{recursive:true,force:true});});return {sync,events,insert,log};
}

check('主表比较原始 SDE 全量 ID，未发布项不查 ESI；真正缺失项仅已发布入库',async t=>{
  const {sync,events,log}=fixture(t),calls=[];
  sync.request=async(path,params)=>{
    calls.push([path,params]);
    if(path==='/universe/types/')return {data:[2,34,35,36],pages:1};
    assert.ok(path==='/universe/types/35/'||path==='/universe/types/36/');
    const id=path.includes('/35/')?35:36;
    return {data:{type_id:id,name:`物品${id}`,published:id===35,volume:1}};
  };
  await sync.items('run',log);
  assert.deepEqual(sync.db.prepare('SELECT type_id FROM items ORDER BY type_id').all().map(x=>x.type_id),[34,35]);
  assert.equal(calls.filter(([path])=>path==='/universe/types/36/').length,1);
  assert.ok(!calls.some(([path])=>path==='/universe/types/2/'||path==='/universe/types/34/'));
  assert.equal(events.find(x=>x.event==='compare').skipped_sde_unpublished,1);
  assert.equal(getState(sync.db,'universe').absent_from_sde,2);
  assert.equal(getState(sync.db,'universe').skipped_unpublished,1);
  assert.equal(sync.db.prepare('SELECT in_serenity_catalog FROM items WHERE type_id=35').get().in_serenity_catalog,'Y');
  calls.length=0;await sync.items('run',log);
  assert.deepEqual(calls.map(x=>x[0]),['/universe/types/']); // Published data and excluded checkpoints both resume.
  calls.length=0;await sync.items('new-run',log);
  assert.ok(calls.some(([path])=>path==='/universe/types/36/')); // A new run rechecks ESI publication.
});

check('缺失 published 或中英文状态不一致必须报错，不写入、不标记完成',async t=>{
  const {sync,log}=fixture(t);
  sync.request=async(path)=>path==='/universe/types/'?{data:[34,35],pages:1}:{data:{type_id:35,name:'物品35'}};
  await assert.rejects(sync.items('missing-flag',log),/Invalid type response/);
  assert.equal(getState(sync.db,'universe'),null);
  sync.request=async(path,params)=>path==='/universe/types/'?{data:[34,35],pages:1}:{data:{type_id:35,name:'物品35',published:params.language==='zh'}};
  await assert.rejects(sync.items('mismatch',log),/inconsistent English/);
  assert.equal(sync.db.prepare('SELECT 1 FROM items WHERE type_id=35').get(),undefined);
});

check('已发布 SDE 基线缺失不能错误走 ESI 补齐，人工保护不覆盖',async t=>{
  const {sync,insert,log}=fixture(t);sync.db.prepare('DELETE FROM items WHERE type_id=34').run();
  sync.request=async(path)=>{assert.equal(path,'/universe/types/');return {data:[2,34],pages:1};};
  await assert.rejects(sync.items('missing-sde',log),/reimport SDE/);
  insert(34,1,'Y','SDE');insert(2,0,'Y');
  sync.db.prepare("UPDATE items SET in_serenity_catalog='Y' WHERE sync_protected='Y'").run();
  await sync.items('protected',log);
  assert.equal(sync.db.prepare('SELECT count(*) n FROM items WHERE sync_protected=? AND in_serenity_catalog=?').get('Y','Y').n,2);
});

check('误补清理限定来源、日期、未发布且无引用，保护记录与关联数据保留',t=>{
  const {sync,insert,log}=fixture(t);
  insert(10,0,'N','ESI','2026-10-10T13:00:00.000Z');insert(11,0);insert(12,1);insert(13,0,'Y');insert(14,0);insert(15,1);insert(16,0,'N','SDE');insert(17,0);
  sync.db.prepare('INSERT INTO recipes(blueprint_id,product_type_id,product_quantity,manufacturing_time,updated_at) VALUES(14,15,1,1,?)').run('now');
  sync.db.prepare('INSERT INTO implant_sets VALUES(?,?,?,?,?,?,?,?,?)').run('set','套装','Set',17,34,34,34,34,34);
  assert.throws(()=>pruneErroneousUnpublishedItems(sync.db,'',log),/ISO timestamp/);
  const result=pruneErroneousUnpublishedItems(sync.db,'2026-10-10T14:47:06.019Z',log);
  assert.equal(result.deleted,1);assert.deepEqual(result.retained.map(x=>[x.type_id,x.reason]),[[13,'protected'],[14,'referenced'],[17,'referenced']]);
  assert.equal(sync.db.prepare('SELECT 1 FROM items WHERE type_id=11').get(),undefined);
  assert.equal(sync.db.prepare('SELECT count(*) n FROM items').get().n,8);
  assert.deepEqual(sync.db.prepare('PRAGMA foreign_key_check').all(),[]);
});
