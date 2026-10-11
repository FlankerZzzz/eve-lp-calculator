import assert from 'node:assert/strict';
import check from 'node:test';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openV2, getState } from '../scripts/v2/database.mjs';
import { importSde,readSdeTypeIndex } from '../scripts/v2/sde.mjs';

// Minimal stored ZIP fixture: exercise the real archive reader without downloading SDE.
function crc32(bytes) {
  let crc=0xffffffff;
  for(const byte of bytes) {
    crc^=byte;
    for(let bit=0;bit<8;bit++) crc=(crc>>>1)^((crc&1)?0xedb88320:0);
  }
  return (crc^0xffffffff)>>>0;
}
function archive(filename, types, blueprints=[]) {
  const files={'_sde.jsonl':[{_key:'fixture'}],'types.jsonl':types,'blueprints.jsonl':blueprints};
  const entries=[],directory=[];let offset=0;
  for(const [name,rows] of Object.entries(files)) {
    const path=Buffer.from(name),data=Buffer.from(rows.map(row=>JSON.stringify(row)).join('\n')+'\n');
    const local=Buffer.alloc(30),central=Buffer.alloc(46),crc=crc32(data);
    local.writeUInt32LE(0x04034b50);local.writeUInt16LE(20,4);
    local.writeUInt32LE(crc,14);local.writeUInt32LE(data.length,18);local.writeUInt32LE(data.length,22);local.writeUInt16LE(path.length,26);
    central.writeUInt32LE(0x02014b50);central.writeUInt16LE(20,4);central.writeUInt16LE(20,6);
    central.writeUInt32LE(crc,16);central.writeUInt32LE(data.length,20);central.writeUInt32LE(data.length,24);
    central.writeUInt16LE(path.length,28);central.writeUInt32LE(offset,42);
    entries.push(local,path,data);directory.push(central,path);offset+=local.length+path.length+data.length;
  }
  const end=Buffer.alloc(22),central=Buffer.concat(directory);
  end.writeUInt32LE(0x06054b50);end.writeUInt16LE(3,8);end.writeUInt16LE(3,10);end.writeUInt32LE(central.length,12);end.writeUInt32LE(offset,16);
  writeFileSync(filename,Buffer.concat([...entries,central,end]));
}
const type=(id,published=true)=>({_key:id,published,name:{zh:`物品${id}`,en:`Item ${id}`},groupID:1,volume:1});
const blueprint=(id,product,material)=>({_key:id,blueprintTypeID:id,activities:{manufacturing:{time:60,products:[{typeID:product,quantity:1}],materials:[{typeID:material,quantity:2}]}}});
function fixture(t) {
  const folder=mkdtempSync(join(tmpdir(),'eve-v2-sde-check-')),file=join(folder,'sde.zip'),db=openV2(join(folder,'v2.db'));
  const records=[],log={info:(event,data)=>records.push({event,data}),payload:(event,data)=>records.push({event,data})};
  t.after(()=>{db.close();rmSync(folder,{recursive:true,force:true});});
  return {file,db,log,records};
}

check('V2 SDE 只导入已发布物品，过滤蓝图及未发布关联的完整配方',async t=>{
  const {file,db,log,records}=fixture(t);
  archive(file,[type(1),type(2),type(3),type(4,false),type(10),type(11,false),type(12),type(13)],
    [blueprint(10,1,3),blueprint(11,1,3),blueprint(12,4,3),blueprint(13,2,4)]);
  const result=await importSde(db,file,log);
  assert.equal(result.types,6);assert.equal(result.skipped_types,2);
  assert.equal(result.recipes,1);assert.equal(result.skipped_recipes,3);
  assert.deepEqual(db.prepare('SELECT type_id FROM items WHERE published<>1 OR type_id IN (4,11)').all(),[]);
  assert.deepEqual(db.prepare('SELECT blueprint_id FROM recipes').all().map(row=>row.blueprint_id),[10]);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM recipe_materials').get().n,1);
  assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(),[]);
  const skipped=records.find(row=>row.event==='sde_skipped_recipes').data;
  assert.equal(skipped[0].reason,'unpublished-blueprint');
  assert.deepEqual(skipped.slice(1).map(row=>row.type_ids),[[4],[4]]);
});

check('V2 SDE published 缺失或类型错误须报错且不写入',async t=>{
  const {file,db,log}=fixture(t);
  for(const value of [undefined,'true',1,null]) {
    archive(file,[type(1),{...type(2),published:value}]);
    await assert.rejects(importSde(db,file,log),/Type 2: published must be a boolean/);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM items').get().n,0);
    assert.equal(getState(db,'sde'),null);
  }
});

check('V2 SDE 真实缺失引用不能被当作未发布过滤，失败保留上一份数据',async t=>{
  const {file,db,log}=fixture(t);
  archive(file,[type(1),type(3),type(10)],[blueprint(10,1,3)]);
  await importSde(db,file,log);
  const previous=getState(db,'sde');
  archive(file,[type(1),type(3),type(10)],[blueprint(10,1,999)]);
  await assert.rejects(importSde(db,file,log),/missing reference 999/);
  assert.deepEqual(getState(db,'sde'),previous);
  assert.equal(db.prepare('SELECT material_type_id FROM recipe_materials').get().material_type_id,3);
});

check('V2 比对索引保留原始 SDE 未发布 ID，版本与导入 SHA256 必须一致',async t=>{
  const {file,db,log}=fixture(t);archive(file,[{_key:0,published:false,name:{en:'#System'},groupID:0},type(1),type(2,false)]);
  await importSde(db,file,log);
  const baseline=getState(db,'sde');
  assert.deepEqual([...await readSdeTypeIndex(file,baseline.sha256)],[[0,false],[1,true],[2,false]]);
  assert.equal(db.prepare('SELECT 1 FROM items WHERE type_id=0').get(),undefined);
  await assert.rejects(readSdeTypeIndex(file,undefined),/baseline hash/);
  archive(file,[type(1),type(3,false)]);
  await assert.rejects(readSdeTypeIndex(file,baseline.sha256),/differs from the imported baseline/);
});

check('SDE 仅接受已核实的未发布 System 零 ID，其他零 ID 或负数报错',async t=>{
  const {file,db,log}=fixture(t);
  for(const row of [type(-1),type(0),{_key:0,published:false,name:{en:'Other'},groupID:0},{_key:0,published:true,name:{en:'#System'},groupID:0}]) {
    archive(file,[row]);await assert.rejects(importSde(db,file,log),/Invalid type ID|Unexpected SDE type 0/);
    assert.equal(db.prepare('SELECT count(*) n FROM items').get().n,0);
  }
});
