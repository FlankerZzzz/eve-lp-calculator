import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync, readFileSync, readdirSync, statSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { transaction, getState, setState } from './database.mjs';
import { getLpPolicy, recomputeLpPolicy, lpFlagsForOffer, validateLpPolicy } from './lp-policy.mjs';

export const MAINTENANCE_FORMAT='eve-v2-maintenance';
export const MAX_IMPORT_BYTES=20*1024*1024;
export const MAX_IMPORT_ROWS=10000;
export const maintenanceModules={items:['items','recipes','recipe_materials'],catalog:['lp_exchange','lp_requirements'],history:['history'],orders:['orders'],contracts:['contracts','contract_items'],rankings:['ranking_cache'],geography:['navigation_cache','navigation_samples']};
const keys={items:['type_id'],recipes:['blueprint_id'],recipe_materials:['blueprint_id','material_type_id'],lp_exchange:['corporation_id','offer_id'],lp_requirements:['corporation_id','offer_id','material_type_id'],history:['type_id','date'],orders:['generation','order_id'],contracts:['contract_id'],contract_items:['contract_id','record_id'],ranking_cache:['list_kind','rank'],navigation_cache:['kind'],navigation_samples:['kind','window_end']};
const active="status IN ('running','queued','pause_requested')";
const digest=value=>createHash('sha256').update(JSON.stringify(value??null)).digest('hex');
const rowKey=(table,row)=>keys[table].map(key=>row[key]).join(':');
const selectRow=(db,table,row)=>db.prepare(`SELECT * FROM ${table} WHERE ${keys[table].map(key=>`${key}=?`).join(' AND ')}`).get(...keys[table].map(key=>row[key]));
export function importIdle(db) {const task=db.prepare(`SELECT module FROM tasks WHERE ${active} LIMIT 1`).get();if(task)throw new Error(`${task.module} 正在运行或排队；请先暂停任务，等待空闲后导入`);}
function validDate(date) {return typeof date==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(date)&&!isNaN(Date.parse(date))&&new Date(`${date}T00:00:00Z`).toISOString().slice(0,10)===date;}
export function exportFilter(db,module,{type_id='',from='',to=''}={}) {
  if(!Object.hasOwn(maintenanceModules,module))throw new Error('导出模块无效');
  const id=type_id===''?null:Number(type_id);
  if(id!==null&&(!Number.isSafeInteger(id)||id<1))throw new Error('物品 ID 无效');
  if(id!==null&&module==='geography')throw new Error('地理缓存按完整星系批次导出，不支持物品 ID 筛选');
  if((from&&!validDate(from))||(to&&!validDate(to))||(from&&to&&from>to))throw new Error('日期范围无效');
  if((from||to)&&module!=='history')throw new Error('日期筛选只适用于历史成交');
  return maintenanceModules[module].map(table=>{
    const where=[],values=[];
    if(table==='orders'){where.push('generation=?');values.push(getState(db,'orders')?.generation??'');}
    if(id!==null) {
      if(['items','lp_exchange','history','orders','contract_items'].includes(table)){where.push('type_id=?');values.push(id);}
      if(table==='recipes'||table==='recipe_materials'){where.push('blueprint_id IN (SELECT blueprint_id FROM recipes WHERE product_type_id=? OR blueprint_id=?)');values.push(id,id);}
      if(table==='lp_requirements'){where.push('(corporation_id,offer_id) IN (SELECT corporation_id,offer_id FROM lp_exchange WHERE type_id=?)');values.push(id);}
      if(table==='contracts'){where.push('contract_id IN (SELECT contract_id FROM contract_items WHERE type_id=?)');values.push(id);}
      // Preserve the complete contract basket when filtering a contract export by one item.
      if(table==='contract_items'){where.splice(0);values.splice(0);where.push('contract_id IN (SELECT contract_id FROM contract_items WHERE type_id=?)');values.push(id);}
      if(table==='ranking_cache'){where.push("json_extract(payload,'$.type_id')=?");values.push(id);}
      // A manufacturing repair package also needs its blueprint and material item references.
      if(table==='items'){where.splice(0);values.splice(0);where.push('type_id=? OR type_id IN (SELECT blueprint_id FROM recipes WHERE product_type_id=? OR blueprint_id=?) OR type_id IN (SELECT product_type_id FROM recipes WHERE product_type_id=? OR blueprint_id=?) OR type_id IN (SELECT material_type_id FROM recipe_materials WHERE blueprint_id IN (SELECT blueprint_id FROM recipes WHERE product_type_id=? OR blueprint_id=?))');values.push(id,id,id,id,id,id,id);}
    }
    if(table==='history'){if(from){where.push('date>=?');values.push(from);}if(to){where.push('date<=?');values.push(to);}}
    const sql=`SELECT * FROM ${table}${where.length?' WHERE '+where.join(' AND '):''} ORDER BY ${keys[table].join(',')}`;
    return {table,sql,values};
  });
}
export function* exportLines(db,module,filters={}) {
  const selections=exportFilter(db,module,filters);
  yield JSON.stringify({format:MAINTENANCE_FORMAT,version:1,module,exported_at:new Date().toISOString(),tables:maintenanceModules[module],note:'is_blocked 为计算结果；LP 人工屏蔽使用 manual_blocked。订单、合同、排行榜禁止导入。'})+'\n';
  for(const selection of selections)for(const row of db.prepare(selection.sql).iterate(...selection.values))yield JSON.stringify({table:selection.table,row})+'\n';
}
function validateRow(db,table,row) {
  if(!row||typeof row!=='object'||Array.isArray(row))throw new Error('记录必须为对象');
  const columns=db.prepare(`PRAGMA table_info(${table})`).all(),names=new Set(columns.map(c=>c.name));
  if(Object.keys(row).some(key=>!names.has(key)))throw new Error('存在未知字段');
  for(const column of columns) {
    const value=row[column.name];
    if(value===undefined)throw new Error(`缺少字段 ${column.name}；请先导出完整记录再修改`);
    if(value===null){if(column.notnull||keys[table].includes(column.name))throw new Error(`${column.name} 不允许为空`);continue;}
    if(column.type==='INTEGER'&&(!Number.isSafeInteger(value)||value<0))throw new Error(`${column.name} 须为非负整数`);
    if(column.type==='REAL'&&(typeof value!=='number'||!Number.isFinite(value)||value<0))throw new Error(`${column.name} 须为非负数`);
    if(column.type==='TEXT'&&(typeof value!=='string'||value.length>10000))throw new Error(`${column.name} 文本无效或过长`);
    if((column.name.startsWith('is_')||column.name==='manual_blocked'||column.name==='sync_protected'||column.name==='in_serenity_catalog')&&column.type==='TEXT'&&!['Y','N'].includes(value))throw new Error(`${column.name} 只能是 Y/N`);
    if((column.name.endsWith('_id')||column.name==='quantity'||column.name==='product_quantity')&&column.type==='INTEGER'&&value<1)throw new Error(`${column.name} 须大于 0`);
  }
  if(table==='items'&&!['SDE','ESI'].includes(row.source))throw new Error('source 只能是 SDE/ESI');
  if(table==='items'&&![0,1].includes(row.published))throw new Error('published 只能是 0/1');
  if(table==='items'&&row.published===0&&!selectRow(db,table,row))throw new Error('不能通过修复导入新增未发布物品');
  if(table==='history'&&(!validDate(row.date)||row.highest<row.lowest||row.average<row.lowest||row.average>row.highest))throw new Error('历史日期或最高/最低/均价关系无效');
  if(table==='lp_exchange'&&(!row.corporation_name_zh.trim()||row.lp_cost<0||row.ak_cost<0))throw new Error('军团名或成本无效');
}
function protectedRow(db,table,row,before=selectRow(db,table,row)) {
  if(before?.sync_protected==='Y')return true;
  if(table==='recipe_materials')return db.prepare('SELECT sync_protected FROM recipes WHERE blueprint_id=?').get(row.blueprint_id)?.sync_protected==='Y';
  if(table==='lp_requirements')return db.prepare('SELECT sync_protected FROM lp_exchange WHERE corporation_id=? AND offer_id=?').get(row.corporation_id,row.offer_id)?.sync_protected==='Y';
  return false;
}
export function previewImport(db,text,module) {
  if(!['items','catalog','history'].includes(module))throw new Error('该模块不允许导入（订单、合同、排行榜仅导出）');
  if(Buffer.byteLength(text)>MAX_IMPORT_BYTES)throw new Error('导入文件超过 20 MiB');
  const lines=text.replace(/^\uFEFF/,'').split(/\r?\n/).filter(line=>line.trim());
  if(lines.length<2||lines.length>MAX_IMPORT_ROWS+1)throw new Error('修复包须有 1–10000 条记录；大范围修复请分批');
  let header;try{header=JSON.parse(lines[0]);}catch{throw new Error('第 1 行须为 JSON 格式说明');}
  if(header.format!==MAINTENANCE_FORMAT||header.version!==1||header.module!==module)throw new Error('文件格式、版本或模块不匹配');
  importIdle(db);
  const records=[],seen=new Set(),summary={insert:0,update:0,unchanged:0,protected:0};
  for(let i=1;i<lines.length;i++) {
    try {
      const entry=JSON.parse(lines[i]);if(!maintenanceModules[module].includes(entry.table))throw new Error('表不属于此模块');
      validateRow(db,entry.table,entry.row);
      const key=`${entry.table}:${rowKey(entry.table,entry.row)}`;if(seen.has(key))throw new Error('主键重复');seen.add(key);
      const before=selectRow(db,entry.table,entry.row),isProtected=protectedRow(db,entry.table,entry.row,before);
      const same=before&&Object.keys(entry.row).every(key=>entry.row[key]===before[key]);
      const action=isProtected?'protected':same?'unchanged':before?'update':'insert';summary[action]++;
      records.push({...entry,before:before??null,action});
    }catch(e){throw new Error(`第 ${i+1} 行：${e.message}`);}
  }
  const incoming=new Map(records.filter(row=>!['protected','unchanged'].includes(row.action)).map(row=>[`${row.table}:${rowKey(row.table,row.row)}`,row.row]));
  const lookup=(table,row)=>incoming.get(`${table}:${rowKey(table,row)}`)??selectRow(db,table,row);
  for(const entry of records.filter(row=>row.action!=='protected')) {
    const {table,row}=entry;
    for(const fk of db.prepare(`PRAGMA foreign_key_list(${table})`).all().reduce((groups,fk)=>{if(!groups.has(fk.id))groups.set(fk.id,[]);groups.get(fk.id).push(fk);return groups;},new Map()).values()) {
      const parent=Object.fromEntries(fk.map(key=>[key.to,row[key.from]]));
      if(!lookup(fk[0].table,parent))throw new Error(`${table} ${rowKey(table,row)}：引用的 ${fk[0].table} 不存在`);
    }
    if(table==='history'&&!db.prepare('SELECT 1 FROM items WHERE type_id=?').get(row.type_id))throw new Error(`历史物品 ${row.type_id} 不存在`);
    if(table==='items'&&row.blueprint_id!==null) {
      const recipe=lookup('recipes',{blueprint_id:row.blueprint_id});
      if(!recipe||recipe.product_type_id!==row.type_id)throw new Error(`物品 ${row.type_id} 与蓝图 ${row.blueprint_id} 关系不一致`);
    }
    if(table==='items') {
      const existing=db.prepare('SELECT blueprint_id FROM recipes WHERE product_type_id=?').get(row.type_id);
      const recipe=existing?lookup('recipes',existing):records.find(entry=>entry.table==='recipes'&&entry.row.product_type_id===row.type_id)?.row;
      if(recipe?.product_type_id===row.type_id&&row.blueprint_id!==recipe.blueprint_id)throw new Error(`物品 ${row.type_id} 的 blueprint_id 与已有配方不一致`);
    }
    if(table==='recipes') {
      const product=lookup('items',{type_id:row.product_type_id});
      if(product?.blueprint_id!==row.blueprint_id)throw new Error(`蓝图 ${row.blueprint_id} 的产物主表须同时维护 blueprint_id`);
      const conflict=db.prepare('SELECT blueprint_id FROM recipes WHERE product_type_id=? AND blueprint_id<>?').get(row.product_type_id,row.blueprint_id);
      if(conflict)throw new Error(`产物 ${row.product_type_id} 已有其他蓝图，不能静默覆盖`);
      const previous=selectRow(db,table,row);
      if(previous&&previous.product_type_id!==row.product_type_id&&lookup('items',{type_id:previous.product_type_id})?.blueprint_id===row.blueprint_id)throw new Error('变更配方产物时须同时修复原产物的 blueprint_id');
    }
  }
  return {module,records,summary,policy_version:getLpPolicy(db).version,created_at:new Date().toISOString(),expires_at:Date.now()+30*60000};
}
function rootFolder(root) {mkdirSync(root,{recursive:true,mode:0o700});return root;}
export function stageImport(root,plan) {
  rootFolder(root);
  // Only expired, isolated previews are removed. Repair backups are not log files.
  for(const file of readdirSync(root))if(/^preview-[a-f0-9-]+\.json$/.test(file)&&Date.now()-statSync(join(root,file)).mtimeMs>24*3600000)unlinkSync(join(root,file));
  const id=randomUUID();writeFileSync(join(root,`preview-${id}.json`),JSON.stringify(plan),{mode:0o600,flag:'wx'});return id;
}
export function commitImport(db,root,id,{protect=false}={}) {
  if(typeof protect!=='boolean'||typeof id!=='string'||!/^[a-f0-9]{8}-[a-f0-9-]{27}$/.test(id))throw new Error('预览 ID 或保护选项无效');
  const plan=JSON.parse(readFileSync(join(root,`preview-${id}.json`),'utf8'));
  if(Date.now()>plan.expires_at)throw new Error('预览已过期，请重新上传');
  const result=transaction(db,()=>{
    importIdle(db);if(getLpPolicy(db).version!==plan.policy_version)throw new Error('LP 规则已变化，请重新预览');
    for(const entry of plan.records)if(digest(selectRow(db,entry.table,entry.row))!==digest(entry.before))throw new Error('数据自预览后已变化，请重新预览');
    // Backup before touching live rows; a filesystem failure aborts the transaction.
    const backup=`backup-${id}.jsonl`;
    writeFileSync(join(rootFolder(root),backup),JSON.stringify({format:MAINTENANCE_FORMAT,version:1,module:plan.module,import_id:id,inserted_keys:plan.records.filter(e=>e.action==='insert').map(e=>({table:e.table,key:rowKey(e.table,e.row)}))})+'\n'+plan.records.filter(e=>e.before&&!['protected','unchanged'].includes(e.action)).map(e=>JSON.stringify({table:e.table,row:e.before})).join('\n')+'\n',{mode:0o600,flag:'wx'});
    const config=getLpPolicy(db);let classificationChanged=false;
    for(const table of maintenanceModules[plan.module])for(const entry of plan.records.filter(row=>row.table===table&&!['protected','unchanged'].includes(row.action))) {
      const row={...entry.row};if(protect&&Object.hasOwn(row,'sync_protected'))row.sync_protected='Y';
      if(table==='lp_exchange') {
        const resolved=lpFlagsForOffer(db,row,row,config);
        for(const field of ['is_guard','is_invalid'])if(resolved[field]!==row[field]) {
          const target_id=`${row.corporation_id}:${row.offer_id}`;
          config.rules=config.rules.filter(r=>!(r.scope==='offer'&&r.target_id===target_id&&r.field===field));config.rules.push({scope:'offer',target_id,field,value:row[field],reason:'修复文件导入的分类',updated_at:new Date().toISOString()});classificationChanged=true;
        }
      }
      const columns=Object.keys(row),primary=keys[table];
      db.prepare(`INSERT INTO ${table}(${columns.join(',')}) VALUES(${columns.map(()=>'?').join(',')}) ON CONFLICT(${primary.join(',')}) DO UPDATE SET ${columns.filter(c=>!primary.includes(c)).map(c=>`${c}=excluded.${c}`).join(',')}`).run(...columns.map(c=>row[c]));
    }
    if(classificationChanged){validateLpPolicy(config);config.version++;setState(db,'lp_policy_config',config);}
    if(plan.module==='catalog')recomputeLpPolicy(db,config);
    db.prepare("UPDATE tasks SET status='queued',run_id=NULL,updated_at=? WHERE module='rankings'").run(new Date().toISOString());
    return {summary:plan.summary,backup,import_id:id};
  });
  // Mark consumed only after the transaction committed. Failed imports retain their preview for diagnosis.
  unlinkSync(join(root,`preview-${id}.json`));return result;
}
