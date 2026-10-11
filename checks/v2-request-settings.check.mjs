import assert from 'node:assert/strict';
import check from 'node:test';
import { mkdtempSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { requestSettings,RequestPool } from '../scripts/v2/request.mjs';
import { V2Sync } from '../scripts/v2/sync.mjs';
import { setState,getState } from '../scripts/v2/database.mjs';

check('V2 并发和速率默认保持兼容，提速参数独立配置并校验',()=>{
  assert.deepEqual(requestSettings({}),{rate:5,concurrency:8});
  assert.deepEqual(requestSettings({V2_REQUEST_RATE:'15',V2_REQUEST_CONCURRENCY:'16'}),{rate:15,concurrency:16});
  for(const value of ['0','21','bad','Infinity',''])assert.throws(()=>requestSettings({V2_REQUEST_RATE:value}),/V2_REQUEST_RATE/);
  for(const value of ['0','33','1.5','bad','Infinity',''])assert.throws(()=>requestSettings({V2_REQUEST_CONCURRENCY:value}),/V2_REQUEST_CONCURRENCY/);
});

check('V2 分页使用配置后的并发，不再固定为 8，仍保留页序',async()=>{
  const root=mkdtempSync(join(tmpdir(),'v2-concurrency-'));
  const sync=new V2Sync({filename:join(root,'test.db'),logRoot:root,rate:15,concurrency:16});
  let active=0,peak=0;
  sync.request=async(_path,{page})=>{
    active++;peak=Math.max(peak,active);
    await delay(10);active--;
    return {data:[page],pages:24};
  };
  try {
    assert.deepEqual(await sync.pages('/test/'),Array.from({length:24},(_,i)=>i+1));
    assert.equal(peak,16);
    let modulePeak=0;
    await sync.map(Array.from({length:20}),async()=>{active++;modulePeak=Math.max(modulePeak,active);await delay(10);active--;},2);
    assert.equal(modulePeak,2); // Catalog retains its lower per-corporation fanout.
  } finally {sync.db.close();rmSync(root,{recursive:true,force:true});}
});

check('增加并发仍受共享速率间隔和冷却截止约束',async()=>{
  const pool=new RequestPool({concurrency:16,rate:15});
  assert.equal(pool.limit,16);
  assert.equal(pool.interval,1000/15);
  const deadline=Date.now()+100;pool.cooldown=deadline;
  let started=0;
  await pool.dispatch(()=>{started=Date.now();});
  assert.ok(started>=deadline);
  const nextStart=await pool.dispatch(()=>Date.now());
  assert.ok(nextStart-started>=60);
});

check('晨曦物品同步核实并跳过 #System 占位 ID 0，保留正常补齐与目录标记',async()=>{
  const root=mkdtempSync(join(tmpdir(),'v2-system-type-'));
  const sync=new V2Sync({filename:join(root,'test.db'),logRoot:root,rate:15,concurrency:16}),events=[];
  setState(sync.db,'sde',{types:1});
  sync.sdeTypes=async()=>new Map([[34,true]]);
  sync.db.prepare("INSERT INTO items(type_id,name_zh,source,published,volume,packaged_volume,updated_at) VALUES(34,'三钛合金','SDE',1,0.01,0.01,'now')").run();
  sync.request=async(path)=>{
    if(path==='/universe/types/')return {data:[0,34,35],pages:1};
    if(path==='/universe/types/0/')return {data:{type_id:0,name:'#System',group_id:0,published:false}};
    assert.equal(path,'/universe/types/35/');
    return {data:{type_id:35,name:'Pyerite',group_id:18,published:true,volume:0.01}};
  };
  try {
    await sync.items('run',{info:(event,data)=>events.push({event,...data})});
    assert.equal(sync.db.prepare('SELECT 1 FROM items WHERE type_id=0').get(),undefined);
    assert.deepEqual(sync.db.prepare('SELECT type_id,in_serenity_catalog FROM items ORDER BY type_id').all().map(row=>({...row})),[{type_id:34,in_serenity_catalog:'Y'},{type_id:35,in_serenity_catalog:'Y'}]);
    assert.equal(getState(sync.db,'universe').count,2);
    assert.ok(events.some(row=>row.event==='catalog_system_entry_skipped'&&row.type_id===0));
    const original=sync.request;
    sync.request=async(path,params)=>path==='/universe/types/0/'?{data:{type_id:0,name:'#System',group_id:0,published:true}}:original(path,params);
    await assert.rejects(sync.items('unexpected',{info:()=>{}}),/Unexpected universe type 0/);
    sync.request=async()=>({data:[-1,34],pages:1});
    await assert.rejects(sync.items('invalid',{info:()=>{}}),/Invalid universe type list/);
  } finally {sync.db.close();rmSync(root,{recursive:true,force:true});}
});
