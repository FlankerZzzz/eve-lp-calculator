import {readFile} from 'node:fs/promises';
import {dirname,join} from 'node:path';
import {createHash} from 'node:crypto';
import {transaction} from './database.mjs';
import {validateJumpSupplement,validateJumpCatalog} from '../../lib/jump-catalog.mjs';

export const geographyFeeds={system_jumps:'/universe/system_jumps/',system_kills:'/universe/system_kills/',incursions:'/incursions/',sovereignty:'/sovereignty/map/',industry:'/industry/systems/'};
const stats=new Set(['system_jumps','system_kills']);
const id=n=>Number.isSafeInteger(n)&&n>0;
const count=n=>Number.isSafeInteger(n)&&n>=0;
export function validateGeography(kind,rows){
  if(!Array.isArray(rows))throw new Error(`${kind}: 响应不是数组`);
  const seen=new Set();
  for(const r of rows){
    if(!r||typeof r!=='object')throw new Error(`${kind}: 无效记录`);
    const key=kind==='industry'?r.solar_system_id:kind==='incursions'?r.constellation_id:r.system_id;
    if(!id(key)||seen.has(key))throw new Error(`${kind}: 无效或重复 ID`);
    seen.add(key);
    let valid=false;
    if(kind==='system_jumps')valid=count(r.ship_jumps);
    if(kind==='system_kills')valid=['ship_kills','pod_kills','npc_kills'].every(k=>count(r[k]));
    if(kind==='sovereignty')valid=['faction_id','corporation_id','alliance_id'].every(k=>r[k]===undefined||id(r[k]));
    if(kind==='incursions')valid=Array.isArray(r.infested_solar_systems)&&r.infested_solar_systems.every(id)&&Number.isFinite(r.influence)&&r.influence>=0&&r.influence<=1&&typeof r.state==='string';
    if(kind==='industry')valid=Array.isArray(r.cost_indices)&&r.cost_indices.every(c=>typeof c?.activity==='string'&&c.activity.length>0&&Number.isFinite(c.cost_index)&&c.cost_index>=0)&&new Set(r.cost_indices.map(c=>c.activity)).size===r.cost_indices.length;
    if(!valid)throw new Error(`${kind}: 字段校验失败 (${key})`);
  }
  // Empty statistics/incursion lists are legitimate. Empty global catalogues are not.
  if(!rows.length&&['sovereignty','industry'].includes(kind))throw new Error(`${kind}: 全量目录为空`);
  return rows;
}
export function publishNavigation(db,kind,data,modified=null,now=new Date()){
  const payload=JSON.stringify(data),version=createHash('sha256').update(payload).digest('hex'),at=now.toISOString();
  const date=modified?Date.parse(modified):NaN;
  if(stats.has(kind)&&!Number.isFinite(date))throw new Error(`${kind}: 缺少有效 Last-Modified，无法确定统计窗口`);
  if(Number.isFinite(date)&&date>now.getTime()+60000)throw new Error(`${kind}: 数据时间位于未来`);
  const stamp=Number.isFinite(date)?new Date(date).toISOString():null;
  transaction(db,()=>{
    const old=db.prepare('SELECT modified FROM navigation_cache WHERE kind=?').get(kind);
    if(stamp&&old?.modified&&stamp<old.modified)throw new Error(`${kind}: 上游返回较旧快照，保留现有数据`);
    db.prepare(`INSERT INTO navigation_cache(kind,payload,modified,fetched,attempted,error,version) VALUES(?,?,?,?,?,NULL,?)
      ON CONFLICT(kind) DO UPDATE SET payload=excluded.payload,modified=excluded.modified,fetched=excluded.fetched,attempted=excluded.attempted,error=NULL,version=excluded.version`).run(kind,payload,stamp,at,at,version);
    if(stats.has(kind))db.prepare(`INSERT INTO navigation_samples(kind,window_end,fetched,payload) VALUES(?,?,?,?) ON CONFLICT(kind,window_end) DO UPDATE SET fetched=excluded.fetched,payload=excluded.payload`).run(kind,stamp,at,payload);
    db.prepare('DELETE FROM navigation_samples WHERE window_end<?').run(new Date(now.getTime()-72*3600000).toISOString());
  });
  return {kind,rows:Array.isArray(data)?data.length:undefined,modified:stamp,version};
}
export function failNavigation(db,kind,error,now=new Date()){
  db.prepare(`INSERT INTO navigation_cache(kind,attempted,error) VALUES(?,?,?) ON CONFLICT(kind) DO UPDATE SET attempted=excluded.attempted,error=excluded.error`).run(kind,now.toISOString(),String(error?.message??error));
}
export async function syncSovereigntyNames(sync,rows,log){
  const ids=[...new Set(rows.flatMap(r=>[r.faction_id,r.alliance_id,r.corporation_id].filter(id)))].sort((a,b)=>a-b);
  // One small batched lookup per hourly run keeps renames current without per-click requests.
  const byId=new Map(),missing=ids;
  for(let offset=0;offset<missing.length;offset+=1000){
    const batch=missing.slice(offset,offset+1000),wanted=new Set(batch);
    const {data}=await sync.request('/universe/names/',{}, {method:'POST',body:batch,retrySafe:true});
    if(!Array.isArray(data)||data.length!==batch.length||new Set(data.map(r=>r?.id)).size!==batch.length||data.some(r=>!wanted.has(r?.id)||!['faction','alliance','corporation'].includes(r.category)||typeof r.name!=='string'||!r.name.trim()))throw new Error('主权归属名称批次不完整或格式无效');
    for(const row of data)byId.set(row.id,row);
  }
  const result=ids.map(n=>byId.get(n));publishNavigation(sync.db,'sovereignty_names',result);log.info('sovereignty_names_published',{entities:result.length,queried:missing.length});
}
export async function syncGeography(sync,runId,log){
  const directory=dirname(sync.filename);
  const failures=[];let processed=0;
  sync.db.prepare('DELETE FROM navigation_samples WHERE window_end<?').run(new Date(Date.now()-72*3600000).toISOString());
  // Import complete, validated local baselines atomically; web readers never read files.
  try{
    const map=JSON.parse(await readFile(join(directory,'star-map.json'),'utf8'));
    if(map.schema!==1||!Array.isArray(map.systems)||!map.systems.length||!Array.isArray(map.gates))throw new Error('星图基线格式无效');
    const supplement=validateJumpSupplement(JSON.parse(await readFile(join(directory,'jump-demo.json'),'utf8')));
    validateJumpCatalog({...supplement,systems:map.systems,gates:map.gates});
    publishNavigation(sync.db,'map',map);publishNavigation(sync.db,'jump',supplement);
    log.info('geography_baseline',{systems:map.systems.length,station_systems:Object.keys(supplement.stations).length});
  }catch(error){failures.push(`SDE 基线：${error.message}`);log.info('geography_baseline_failed',{message:error.message});}
  for(const [kind,path] of Object.entries(geographyFeeds)){
    sync.context?.signal?.throwIfAborted();
    sync.progress('geography',processed,5-processed,`缓存 ${kind}`);
    try{
      const result=await sync.request(path);
      validateGeography(kind,result.data);
      const published=publishNavigation(sync.db,kind,result.data,result.modified);
      log.info('geography_published',published);
      if(kind==='sovereignty'){
        try{await syncSovereigntyNames(sync,result.data,log);}catch(error){sync.context?.signal?.throwIfAborted();failNavigation(sync.db,'sovereignty_names',error);failures.push(`主权名称：${error.message}`);log.info('sovereignty_names_failed',{message:error.message});}
      }
    }catch(error){
      sync.context?.signal?.throwIfAborted();
      failNavigation(sync.db,kind,error);failures.push(`${kind}: ${error.message}`);log.info('geography_feed_failed',{kind,message:error.message});
    }
    processed++;sync.progress('geography',processed,5-processed,`已处理 ${processed}/5 组数据 · 统计保留 72 小时`);
  }
  if(failures.length)throw new Error(failures.join('；'));
}
