import { resolve,dirname } from 'node:path';
import { RequestPool, ModuleLog, mapPool, requestSettings } from './request.mjs';
import { openV2, transaction, setState, getState } from './database.mjs';
import { summarize } from '../order-fetch-process.mjs';
import { canonicalTypeSignature, classifyContractItems, classifyBlueprintCopyContractItems } from '../contract-sync-core.mjs';
import { NPC_CORPORATION_FACTIONS } from '../../lib/npc-factions.ts';
import { contractImplantSetsSql, lpFlagsForOffer } from './lp-policy.mjs';
import { rebuildV2Rankings } from './rankings.mjs';
import { readSdeTypeIndex } from './sde.mjs';

export class V2Sync {
  constructor({filename,logRoot,base='https://ali-esi.evepc.163.com',rate=5,concurrency=8,sdeArchive=process.env.V2_SDE_PATH||resolve(dirname(filename),'sde.zip')}={}) {
    this.db=openV2(filename);this.logRoot=logRoot;this.base=base.replace(/\/$/,'');this.pool=new RequestPool({rate,concurrency});this.controllers=new Map();
    this.sdeArchive=sdeArchive;
  }
  async request(path,params={},options={}) {
    const url=new URL(`${this.base}/latest${path}`);url.searchParams.set('datasource','serenity');
    for(const [key,value] of Object.entries(params))url.searchParams.set(key,String(value));
    return this.pool.request(url.href,{...this.context,...options});
  }
  progress(module,processed,remaining,phase) {this.db.prepare('UPDATE tasks SET processed=?,remaining=?,phase=?,updated_at=? WHERE module=?').run(processed,remaining,phase,new Date().toISOString(),module);}
  map(rows,callback,concurrency=this.pool.limit) {return mapPool(rows,callback,concurrency);}
  async rankings(runId,log) {
    const result=rebuildV2Rankings(this.db);
    this.progress('rankings',result.offers,0,'按维护标记重算全局 Top 100');
    log.info('ranking_policy',result);
  }
  async run(module,{resume=true}={}) {
    if(this.controllers.size)throw new Error('V2 worker is already running a task');
    const task=this.db.prepare('SELECT * FROM tasks WHERE module=?').get(module);if(!task)throw new Error(`Unknown module ${module}`);
    const runId=resume&&['paused','failed','running','queued'].includes(task.status)&&task.run_id?task.run_id:new Date().toISOString();
    const historySettings=module==='history'&&process.env.V2_HISTORY_REQUEST_RATE?requestSettings({V2_REQUEST_RATE:process.env.V2_HISTORY_REQUEST_RATE,V2_REQUEST_CONCURRENCY:process.env.V2_HISTORY_REQUEST_CONCURRENCY??2}):null;
    const controller=new AbortController();this.controllers.set(module,controller);
    const originalRate={interval:this.pool.interval,limit:this.pool.limit};
    if(historySettings) {
      this.pool.interval=1000/historySettings.rate;this.pool.limit=historySettings.concurrency;
    }
    const log=new ModuleLog(this.logRoot,module,runId,Boolean(task.debug));this.context={log,signal:controller.signal};
    this.db.prepare("UPDATE tasks SET status='running',run_id=?,error=NULL,updated_at=? WHERE module=?").run(runId,new Date().toISOString(),module);
    log.info('start',{resume:task.run_id===runId,request_rate:1000/this.pool.interval,request_concurrency:this.pool.limit});
    try {
      await this[module](runId,log);
      this.db.prepare("UPDATE tasks SET status='complete',remaining=0,last_success=?,updated_at=? WHERE module=?").run(new Date().toISOString(),new Date().toISOString(),module);
      log.info('complete');
      // Retain the most recent run for crash recovery; older completed checkpoints are no longer useful.
      this.db.prepare('DELETE FROM checkpoints WHERE module=? AND run_id<>?').run(module,runId);
    } catch(error) {
      const interruption=controller.signal.reason;
      if(controller.signal.aborted&&['SYNC_YIELD','WORKER_STOP'].includes(interruption?.code)) {
        this.db.prepare("UPDATE tasks SET status='queued',error=NULL,updated_at=? WHERE module=?").run(new Date().toISOString(),module);
        log.info(interruption.code==='SYNC_YIELD'?'yield':'worker_stop',{message:interruption.message});
        return;
      }
      this.db.prepare('UPDATE tasks SET status=?,error=?,updated_at=? WHERE module=?').run(controller.signal.aborted?'paused':'failed',error.message,new Date().toISOString(),module);
      log.info('error',{message:error.message});throw error;
    } finally {this.pool.interval=originalRate.interval;this.pool.limit=originalRate.limit;this.controllers.delete(module);this.context=null;}
  }
  async pages(path,params={},requireStablePages=false) {
    const first=await this.request(path,{...params,page:1});
    if(!Array.isArray(first.data)||!Number.isInteger(first.pages)||first.pages<1||first.pages>1000)throw new Error(`Invalid paginated result ${path}`);
    const pages=new Map([[1,first.data]]);
    await this.map(Array.from({length:first.pages-1},(_,i)=>i+2),async page=>{const result=await this.request(path,{...params,page});if(!Array.isArray(result.data))throw new Error('Expected array');if(requireStablePages&&result.pages!==first.pages)throw new Error(`Page count changed ${path}; incomplete directory recheck`);pages.set(page,result.data);});
    return [...pages].sort((a,b)=>a[0]-b[0]).flatMap(x=>x[1]);
  }
  checkpoint(module,runId,key) {
    const row=this.db.prepare('SELECT payload FROM checkpoints WHERE module=? AND run_id=? AND key=?').get(module,runId,key);
    return row?.payload?JSON.parse(row.payload):null;
  }
  saveCheckpoint(module,runId,key,payload) {
    this.db.prepare('INSERT INTO checkpoints(module,run_id,key,payload) VALUES(?,?,?,?) ON CONFLICT(module,run_id,key) DO UPDATE SET payload=excluded.payload').run(module,runId,key,JSON.stringify(payload));
  }
  async persistentPages(path,runId,key,validate) {
    const load=async(page,expectedPages)=>{
      const checkpointKey=`${key}:page:${page}`;
      let result=this.checkpoint('contracts',runId,checkpointKey);
      if(!result) {
        const response=await this.request(path,{page});
        result={path,data:response.data,pages:response.pages};
        if(!Array.isArray(result.data)||!Number.isInteger(result.pages)||result.pages<1||result.pages>1000)throw Object.assign(new Error(`Invalid paginated result ${path} page ${page}`),{code:path.startsWith('/contracts/public/items/')?'INVALID_CONTRACT_ITEMS':'INVALID_DIRECTORY'});
        if(expectedPages!==undefined&&result.pages!==expectedPages)throw new Error(`Page count changed ${path}; restart this snapshot`);
        validate(result.data);
        // A single committed row contains both page completion and the complete payload.
        this.saveCheckpoint('contracts',runId,checkpointKey,result);
      }
      if(result.path!==path||!Array.isArray(result.data)||!Number.isInteger(result.pages)||result.pages<1||result.pages>1000)throw new Error(`Invalid checkpoint ${checkpointKey}`);
      if(expectedPages!==undefined&&result.pages!==expectedPages)throw new Error(`Checkpoint page count mismatch ${path}`);
      validate(result.data);return result;
    };
    const first=await load(1),pages=new Map([[1,first.data]]);
    await this.map(Array.from({length:first.pages-1},(_,i)=>i+2),async page=>pages.set(page,(await load(page,first.pages)).data));
    return [...pages].sort((a,b)=>a[0]-b[0]).flatMap(row=>row[1]);
  }
  async ensureItems(ids,module='items',{publishedOnly=false,runId,log=this.context?.log}={}) {
    const unique=[...new Set(ids)];const missing=unique.filter(id=>!this.db.prepare('SELECT 1 FROM items WHERE type_id=?').get(id));let completed=0;
    let inserted=0,skipped=0;
    this.progress(module,0,missing.length,'缺失物品详情补齐');
    await this.map(missing,async id=>{
      const prior=publishedOnly&&runId?this.checkpoint('items',runId,`unpublished:${id}`):null;
      if(prior?.status==='excluded'&&prior.type_id===id&&prior.published===false) {skipped++;completed++;this.progress(module,completed,missing.length-completed,'缺失物品详情补齐');return;}
      const {data:item}=await this.request(`/universe/types/${id}/`,{language:'zh'});
      if(item.type_id!==id||typeof item.name!=='string'||typeof item.published!=='boolean')throw new Error(`Invalid type response ${id}`);
      if(publishedOnly&&!item.published) {
        if(runId)this.saveCheckpoint('items',runId,`unpublished:${id}`,{status:'excluded',type_id:id,published:false});
        log?.info('esi_unpublished_type_skipped',{type_id:id,name:item.name,reason:'unpublished'});skipped++;
      } else {
        const {data:english}=await this.request(`/universe/types/${id}/`,{language:'en'});
        if(english.type_id!==id||typeof english.name!=='string'||english.published!==item.published)throw new Error(`Invalid or inconsistent English type response ${id}`);
        inserted+=this.db.prepare("INSERT OR IGNORE INTO items(type_id,name_zh,name_en,group_id,volume,packaged_volume,source,published,updated_at) VALUES(?,?,?,?,?,?,'ESI',?,?)").run(id,item.name,english.name,item.group_id??null,item.volume??null,item.packaged_volume??null,item.published?1:0,new Date().toISOString()).changes;
      }
      completed++;this.progress(module,completed,missing.length-completed,'缺失物品详情补齐');
    });
    return {queried_candidates:missing.length,inserted,skipped_unpublished:skipped,reused:unique.length-missing.length};
  }
  async sdeTypes() {
    const baseline=getState(this.db,'sde');if(!baseline)throw new Error('Import SDE first');
    return readSdeTypeIndex(this.sdeArchive,baseline.sha256);
  }
  async fillMissingVolumes(runId,log) {
    const candidates=this.db.prepare("SELECT type_id FROM items WHERE published=1 AND sync_protected='N' AND (volume IS NULL OR packaged_volume IS NULL) ORDER BY type_id").all();
    const result={candidates:candidates.length,queried:0,filled:0,unresolved:0,reused:0};let completed=0;
    const update=this.db.prepare("UPDATE items SET volume=COALESCE(volume,?),packaged_volume=COALESCE(packaged_volume,?),updated_at=? WHERE type_id=? AND sync_protected='N' AND ((volume IS NULL AND ? IS NOT NULL) OR (packaged_volume IS NULL AND ? IS NOT NULL))");
    log.info('volume_fill_start',{candidates:candidates.length});
    this.progress('items',0,candidates.length,'已有物品缺失体积补全');
    await this.map(candidates,async({type_id:id})=>{
      let saved=this.checkpoint('items',runId,`volume:${id}`);
      if(saved)result.reused++;
      else {
        let item,unavailable=false;
        try {item=(await this.request(`/universe/types/${id}/`,{language:'en'})).data;}
        catch(error){if(error.status!==404)throw error;unavailable=true;log.info('volume_unavailable',{type_id:id,status:404});}
        if(!unavailable&&(!item||Array.isArray(item)||item.type_id!==id))throw new Error(`Invalid volume type response ${id}`);
        for(const field of ['volume','packaged_volume'])if(item?.[field]!=null&&(typeof item[field]!=='number'||!Number.isFinite(item[field])||item[field]<0))throw new Error(`Invalid ${field} for type ${id}`);
        saved={volume:item?.volume??null,packaged_volume:item?.packaged_volume??null};result.queried++;
        this.saveCheckpoint('items',runId,`volume:${id}`,saved);
      }
      const changed=update.run(saved.volume,saved.packaged_volume,new Date().toISOString(),id,saved.volume,saved.packaged_volume).changes;
      if(changed)result.filled++;
      const remaining=this.db.prepare('SELECT volume,packaged_volume FROM items WHERE type_id=?').get(id);
      if(remaining.volume===null||remaining.packaged_volume===null){result.unresolved++;log.info('volume_still_missing',{type_id:id,volume:remaining.volume,packaged_volume:remaining.packaged_volume});}
      completed++;this.progress('items',completed,candidates.length-completed,'已有物品缺失体积补全');
    });
    result.remaining=this.db.prepare("SELECT COUNT(*) n FROM items WHERE published=1 AND sync_protected='N' AND (volume IS NULL OR packaged_volume IS NULL)").get().n;
    log.info('volume_fill_complete',result);return result;
  }
  async items(runId,log) {
    const sde=await this.sdeTypes();
    const catalog=await this.pages('/universe/types/',{},true);
    if(catalog.some(x=>!Number.isSafeInteger(x)||x<0)||new Set(catalog).size!==catalog.length)throw new Error('Invalid universe type list');
    if(catalog.includes(0)) {
      const {data:system}=await this.request('/universe/types/0/',{language:'en'});
      if(system.type_id!==0||system.name!=='#System'||system.group_id!==0||system.published!==false)throw new Error('Unexpected universe type 0; cannot omit it');
      log.info('catalog_system_entry_skipped',{type_id:0,name:system.name,published:system.published,reason:'verified-system-placeholder'});
    }
    const ids=catalog.filter(id=>id!==0);
    const existing=new Map(this.db.prepare('SELECT type_id,published,sync_protected FROM items').all().map(row=>[row.type_id,row]));
    const publishedSde=ids.filter(id=>sde.get(id)===true),unpublishedSde=ids.filter(id=>sde.get(id)===false),absentSde=ids.filter(id=>!sde.has(id));
    for(const id of publishedSde)if(!existing.has(id)||existing.get(id).published!==1&&existing.get(id).sync_protected!=='Y')throw new Error(`Published SDE type ${id} missing from the imported baseline; reimport SDE`);
    log.info('compare',{catalog:ids.length,sde_total:sde.size,sde_published:publishedSde.length,skipped_sde_unpublished:unpublishedSde.length,absent_from_sde:absentSde.length,missing:absentSde.filter(id=>!existing.has(id)).length});
    log.payload?.('sde_unpublished_catalog_ids',unpublishedSde);
    log.payload?.('catalog_ids_absent_from_sde',absentSde);
    const result=await this.ensureItems(absentSde,'items',{publishedOnly:true,runId,log});
    const volumeFill=await this.fillMissingVolumes(runId,log);
    transaction(this.db,()=>{
      this.db.prepare("UPDATE items SET in_serenity_catalog='N' WHERE sync_protected='N'").run();
      const update=this.db.prepare("UPDATE items SET in_serenity_catalog='Y' WHERE type_id=? AND published=1 AND sync_protected='N'");for(const id of [...publishedSde,...absentSde])update.run(id);
      setState(this.db,'universe',{run_id:runId,count:ids.length,skipped_sde_unpublished:unpublishedSde.length,absent_from_sde:absentSde.length,...result,volume_fill:volumeFill});
    });
    log.info('item_catalog_published',result);
  }
  async catalog(runId,log) {
    const [factionsZh,factionsEn,corporations]=await Promise.all([this.request('/universe/factions/',{language:'zh'}),this.request('/universe/factions/',{language:'en'}),this.request('/corporations/npccorps/')]);
    const factions=new Map(factionsZh.data.map(row=>[row.faction_id,row]));const english=new Map(factionsEn.data.map(row=>[row.faction_id,row.name]));
    const done=new Set(this.db.prepare("SELECT key FROM checkpoints WHERE module='catalog' AND run_id=?").all(runId).map(row=>Number(row.key)));
    let completed=done.size;
    await this.map(corporations.data.filter(id=>!done.has(id)),async id=>{
      const [corp,namesZh,namesEn]=await Promise.all([this.request(`/corporations/${id}/`),this.request('/universe/names/',{language:'zh'},{method:'POST',body:[id],retrySafe:true}),this.request('/universe/names/',{language:'en'},{method:'POST',body:[id],retrySafe:true})]);
      let offers;try {offers=(await this.request(`/loyalty/stores/${id}/offers/`)).data;}catch(error){if(error.status!==404)throw error;offers=[];}
      if(!Array.isArray(offers))throw new Error(`Invalid offers ${id}`);
      const seen=new Set();for(const offer of offers){if(seen.has(offer.offer_id)||!Number.isInteger(offer.quantity)||offer.quantity<1)throw new Error(`Invalid duplicate/quantity offer ${id}`);seen.add(offer.offer_id);}
      await this.ensureItems(offers.flatMap(offer=>[offer.type_id,...(offer.required_items??[]).map(material=>material.type_id)]),'catalog');
      const factionId=NPC_CORPORATION_FACTIONS[id]??corp.data.faction_id??null,faction=factions.get(factionId);const now=new Date().toISOString();
      transaction(this.db,()=>{
        const maintainedFlags=new Map(this.db.prepare('SELECT * FROM lp_exchange WHERE corporation_id=?').all(id).map(row=>[row.offer_id,row]));
        const protectedIds=new Set(this.db.prepare("SELECT offer_id FROM lp_exchange WHERE corporation_id=? AND sync_protected='Y'").all(id).map(row=>row.offer_id));
        this.db.prepare("DELETE FROM lp_requirements WHERE corporation_id=? AND offer_id IN (SELECT offer_id FROM lp_exchange WHERE corporation_id=? AND sync_protected='N')").run(id,id);
        this.db.prepare("DELETE FROM lp_exchange WHERE corporation_id=? AND sync_protected='N'").run(id);
        const insert=this.db.prepare('INSERT INTO lp_exchange(corporation_id,offer_id,faction_id,faction_name_zh,faction_name_en,corporation_name_zh,corporation_name_en,type_id,quantity,lp_cost,isk_cost,ak_cost,updated_at,is_high_sec,is_blocked,manual_blocked,is_guard,is_invalid) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)');
        const material=this.db.prepare('INSERT INTO lp_requirements VALUES(?,?,?,?)');
        for(const offer of offers){if(protectedIds.has(offer.offer_id))continue;const flags=lpFlagsForOffer(this.db,{...offer,corporation_id:id,faction_id:factionId},maintainedFlags.get(offer.offer_id));insert.run(id,offer.offer_id,factionId,faction?.name??null,english.get(factionId)??null,namesZh.data[0]?.name??corp.data.name,namesEn.data[0]?.name??corp.data.name,offer.type_id,offer.quantity,offer.lp_cost,offer.isk_cost,offer.ak_cost??0,now,flags.is_high_sec,flags.is_blocked,flags.manual_blocked,flags.is_guard,flags.is_invalid);for(const row of offer.required_items??[])material.run(id,offer.offer_id,row.type_id,row.quantity);}
        this.db.prepare("INSERT OR IGNORE INTO checkpoints(module,run_id,key) VALUES('catalog',?,?)").run(runId,String(id));
      });
      completed++;this.progress('catalog',completed,corporations.data.length-completed,'军团/势力/LP');log.info('corporation',{corporation_id:id,offers:offers.length});
    },2);
    setState(this.db,'catalog',{run_id:runId,corporations:corporations.data.length});
  }
  async orders(runId,log) {
    if(getState(this.db,'orders')?.generation===runId){log.info('snapshot_already_published');return;}
    let pages=0;
    const unstable=message=>Object.assign(new Error(message),{code:'SNAPSHOT_UNSTABLE'});
    const insert=this.db.prepare('INSERT INTO orders VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)');
    for(let attempt=1;attempt<=3;attempt++) {
      this.db.prepare('DELETE FROM orders WHERE generation=?').run(runId);pages=0;
      const seen=new Set();
      try {
        const first=await this.request('/markets/10000002/orders/',{order_type:'all',page:1});
        if(!Array.isArray(first.data)||!Number.isInteger(first.pages)||first.pages<1||first.pages>1000)throw new Error('Invalid order pages');
        const write=(response,page)=>{
          if(!Array.isArray(response.data))throw new Error(`Invalid order page ${page}`);
          if(response.pages!==first.pages)throw unstable(`Order page count changed at page ${page}: ${first.pages} -> ${response.pages}`);
          for(const row of response.data) {
            for(const key of ['order_id','type_id','location_id','system_id'])if(!Number.isSafeInteger(row[key])||row[key]<1)throw new Error(`Invalid order ${key} at page ${page}`);
            for(const key of ['volume_remain','volume_total','min_volume','duration'])if(!Number.isSafeInteger(row[key])||row[key]<0)throw new Error(`Invalid order ${key}: ${row.order_id}`);
            if(typeof row.price!=='number'||!Number.isFinite(row.price)||row.price<0||typeof row.is_buy_order!=='boolean'||!Number.isFinite(Date.parse(row.issued))||row.range==null)throw new Error(`Invalid order fields: ${row.order_id}`);
            if(seen.has(row.order_id))throw unstable(`Duplicate order ${row.order_id} at page ${page}`);
            seen.add(row.order_id);
          }
          transaction(this.db,()=>{for(const row of response.data)insert.run(runId,row.order_id,row.type_id,row.location_id,row.system_id,row.is_buy_order?1:0,row.price,row.volume_remain,row.volume_total,row.min_volume,String(row.range),row.issued,row.duration,JSON.stringify(row));});
          pages++;this.progress('orders',pages,first.pages-pages,'全量分页');
        };
        write(first,1);
        await this.map(Array.from({length:first.pages-1},(_,i)=>i+2),async page=>write(await this.request('/markets/10000002/orders/',{order_type:'all',page}),page));
        break;
      } catch(error) {
        this.db.prepare('DELETE FROM orders WHERE generation=?').run(runId);
        if(error.code!=='SNAPSHOT_UNSTABLE'||attempt===3)throw error;
        log.info('order_snapshot_retry',{attempt,message:error.message});
      }
    }
    const grouped=new Map();for(const row of this.db.prepare('SELECT type_id,is_buy_order,price,volume_remain FROM orders WHERE generation=?').all(runId)){const rows=grouped.get(row.type_id)||[];rows.push(row);grouped.set(row.type_id,rows);}
    const now=new Date().toISOString();
    transaction(this.db,()=>{
      this.db.exec('DELETE FROM quote_cache; DELETE FROM depth_cache;');
      const quote=this.db.prepare('INSERT INTO quote_cache VALUES(?,?,?,?,?,?)'),depth=this.db.prepare('INSERT INTO depth_cache VALUES(?,?,?,?,?,?)');
      for(const [id,rows] of grouped){const result=summarize(rows);quote.run(id,result.buyPrice,result.sellPrice,result.buyVolume,result.sellVolume,now);for(const [side,levels] of [['buy',result.buyLevels],['sell',result.sellLevels]])for(const row of levels)depth.run(id,side,row.level,row.price,row.volume,now);}
      setState(this.db,'orders',{generation:runId,collected_at:now,order_count:this.db.prepare('SELECT COUNT(*) AS n FROM orders WHERE generation=?').get(runId).n});
      this.db.prepare('DELETE FROM orders WHERE generation<>?').run(runId);
    });
    log.info('snapshot_published',{types:grouped.size,pages});
  }
  async contracts(runId,log) {
    if(getState(this.db,'contracts')?.generation===runId) {log.info('snapshot_already_published');return;}
    const validateHeaders=rows=>{for(const row of rows)if(!Number.isSafeInteger(row?.contract_id)||row.contract_id<1||typeof row.type!=='string')throw new Error('Invalid contract header');};
    const validateItems=rows=>{for(const row of rows)if(!Number.isSafeInteger(row?.record_id)||!Number.isSafeInteger(row.type_id)||row.type_id<1||!Number.isSafeInteger(row.quantity)||row.quantity<=0||typeof row.is_included!=='boolean')throw Object.assign(new Error('Invalid contract item'),{code:'INVALID_CONTRACT_ITEMS'});};
    const directory=await this.persistentPages('/contracts/public/10000002/',runId,'directory',validateHeaders);
    const headers=new Map();for(const row of directory){if(headers.has(row.contract_id))throw new Error(`Duplicate contract ${row.contract_id}`);headers.set(row.contract_id,row);}
    const candidates=directory.filter(row=>['item_exchange','auction'].includes(row.type));
    const done=candidates.filter(row=>this.checkpoint('contracts',runId,`detail:${row.contract_id}:done`));
    let count=done.length;const failures=[];
    const skip=(id,reason)=>{
      this.saveCheckpoint('contracts',runId,`detail:${id}:done`,{status:'skipped',reason});
      log.info('contract_skipped',{contract_id:id,reason});
    };
    this.progress('contracts',count,candidates.length-count,'持久化明细补齐/断点复用');
    log.info('checkpoint_resume',{completed:count,total:candidates.length});
    await this.map(candidates.filter(row=>!this.checkpoint('contracts',runId,`detail:${row.contract_id}:done`)),async contract=>{
      const id=contract.contract_id;
      try {
        const cachedHeader=this.db.prepare('SELECT 1 FROM contracts WHERE contract_id=?').get(id);
        if(cachedHeader) {
          const cached=this.db.prepare('SELECT raw_json FROM contract_items WHERE contract_id=? ORDER BY record_id').all(id).map(row=>JSON.parse(row.raw_json));
          validateItems(cached);
          if(!cached.length){skip(id,'empty-items');count++;this.progress('contracts',count,candidates.length-count,'空合同已略过');return;}
          transaction(this.db,()=>{
            this.saveCheckpoint('contracts',runId,`detail:${id}:page:1`,{path:`/contracts/public/items/${id}/`,data:cached,pages:1});
            this.saveCheckpoint('contracts',runId,`detail:${id}:done`,{status:'ready',pages:1,source:'published-cache'});
          });
        } else {
          let rows;
          try {rows=await this.persistentPages(`/contracts/public/items/${id}/`,runId,`detail:${id}`,validateItems);}
          catch(error) {
            if(error.status!==404)throw error;
            this.saveCheckpoint('contracts',runId,`detail:${id}:done`,{status:'gone',reason:'http-404'});
            log.info('contract_skipped',{contract_id:id,reason:'http-404'});
          }
          if(rows) {
            if(!rows.length){skip(id,'empty-items');count++;this.progress('contracts',count,candidates.length-count,'空合同已略过');return;}
            if(new Set(rows.map(row=>row.record_id)).size!==rows.length)throw Object.assign(new Error(`Duplicate contract item ${id}`),{code:'INVALID_CONTRACT_ITEMS'});
            const first=this.checkpoint('contracts',runId,`detail:${id}:page:1`);
            this.saveCheckpoint('contracts',runId,`detail:${id}:done`,{status:'ready',pages:first.pages,source:'api'});
          }
        }
        count++;this.progress('contracts',count,candidates.length-count,'持久化明细补齐/断点复用');
      } catch(error) {
        if(this.context?.signal?.aborted)throw error;
        if(error.code==='INVALID_CONTRACT_ITEMS'||(error.code==='INVALID_JSON_RESPONSE'&&error.httpStatus===200&&!error.emptyResponse)) {
          skip(id,error.message);count++;this.progress('contracts',count,candidates.length-count,'错误合同已略过');return;
        }
        failures.push({contract_id:id,message:error.message,empty_response:error.code==='INVALID_JSON_RESPONSE'&&error.httpStatus===200&&error.emptyResponse===true});
        this.saveCheckpoint('contracts',runId,`detail:${id}:error`,{message:error.message,time:new Date().toISOString()});
        log.info('contract_detail_error',{contract_id:id,message:error.message});
      }
    });
    // Serenity can return HTTP 200 with no body after a contract has left the directory.
    // An empty body is not []. Only absence from a new, complete directory permits dropping it.
    const emptyFailures=failures.filter(row=>row.empty_response);
    if(emptyFailures.length) {
      log.info('empty_contract_directory_recheck',{contract_ids:emptyFailures.map(row=>row.contract_id)});
      const fresh=await this.pages('/contracts/public/10000002/',{},true);validateHeaders(fresh);
      const active=new Set(fresh.map(row=>row.contract_id));
      if(active.size!==fresh.length)throw new Error('Duplicate contract in refreshed directory; cannot determine disappeared contracts');
      const gone=emptyFailures.filter(row=>!active.has(row.contract_id));
      const checkedAt=new Date().toISOString();
      transaction(this.db,()=>{
        for(const row of gone)this.saveCheckpoint('contracts',runId,`detail:${row.contract_id}:done`,{status:'gone',reason:'absent-from-refreshed-directory',checked_at:checkedAt,directory_count:fresh.length});
      });
      for(const row of gone) {
        failures.splice(failures.indexOf(row),1);count++;
        log.info('contract_disappeared_after_empty_response',{contract_id:row.contract_id,reason:'absent-from-refreshed-directory',checked_at:checkedAt,directory_count:fresh.length});
      }
      log.payload('empty_contract_directory_recheck',fresh);
      this.progress('contracts',count,candidates.length-count,'空响应复查目录/已消失合同跳过');
    }
    if(failures.length)throw new Error(`${failures.length} contract details incomplete; saved ${count}/${candidates.length}. First: ${failures[0].contract_id}: ${failures[0].message}`);
    transaction(this.db,()=>{
      const header=this.db.prepare('INSERT INTO contracts VALUES(?,?,?) ON CONFLICT(contract_id) DO UPDATE SET raw_json=excluded.raw_json,generation=excluded.generation');
      const item=this.db.prepare('INSERT INTO contract_items VALUES(?,?,?,?,?,?)');
      let published=0;
      for(const row of directory){
        const completion=this.checkpoint('contracts',runId,`detail:${row.contract_id}:done`);
        if(['gone','skipped'].includes(completion?.status))continue;
        if(['item_exchange','auction'].includes(row.type)&&completion?.status!=='ready')throw new Error(`Contract ${row.contract_id} has no completed details`);
        header.run(row.contract_id,JSON.stringify(row),runId);published++;
        if(completion?.status==='ready') {
          this.db.prepare('DELETE FROM contract_items WHERE contract_id=?').run(row.contract_id);
          for(let page=1;page<=completion.pages;page++) {
            const saved=this.checkpoint('contracts',runId,`detail:${row.contract_id}:page:${page}`);
            if(!saved)throw new Error(`Contract ${row.contract_id}: missing saved page ${page}`);
            for(const entry of saved.data)item.run(row.contract_id,entry.record_id,entry.type_id,entry.is_included?1:0,entry.quantity,JSON.stringify(entry));
          }
        }
      }
      this.db.prepare('DELETE FROM contracts WHERE generation<>?').run(runId);
      this.buildContractCache(runId);
      setState(this.db,'contracts',{generation:runId,count:published});
      // Only a successful publication can discard staging, including abandoned old runs.
      this.db.prepare("DELETE FROM checkpoints WHERE module='contracts'").run();
    });
    log.info('contracts_published',{headers:getState(this.db,'contracts').count,details:candidates.length});
  }
  buildContractCache() {
    const locations=new Map(this.db.prepare('SELECT location_id,system_name,mapping_name FROM station_mappings').all().map(row=>[row.location_id,`${row.system_name}·${row.mapping_name}`]));
    const groups=new Map();for(const set of this.db.prepare(contractImplantSetsSql()).all()){const ids=[1,2,3,4,5,6].map(i=>set[`slot_${i}_type_id`]);groups.set(canonicalTypeSignature(ids),[]);}
    const blueprints=new Set(this.db.prepare("SELECT DISTINCT r.blueprint_id FROM recipes r JOIN lp_exchange o ON o.type_id=r.blueprint_id WHERE o.is_blocked='N'").all().map(row=>row.blueprint_id));
    for(const id of blueprints)groups.set(`blueprint-copy:${id}`,[]);
    for(const header of this.db.prepare('SELECT raw_json FROM contracts').all()){
      const contract=JSON.parse(header.raw_json);if(contract.type!=='item_exchange'||Date.parse(contract.date_expired)<=Date.now())continue;
      if(locations.has(contract.start_location_id))contract.location_name=locations.get(contract.start_location_id);
      const items=this.db.prepare('SELECT raw_json FROM contract_items WHERE contract_id=?').all(contract.contract_id).map(row=>JSON.parse(row.raw_json));
      const requested=items.filter(row=>!row.is_included&&row.quantity>0);const plexId=44992;
      const pureIsk=contract.price>0&&!requested.length,purePlex=Number(contract.price||0)===0&&requested.length>0&&requested.every(row=>row.type_id===plexId);
      if(!pureIsk&&!purePlex)continue;
      const classified=classifyContractItems(items.filter(row=>row.is_included));
      if(classified.valid&&groups.has(classified.signature))groups.get(classified.signature).push({...contract,unit_price:pureIsk?contract.price/classified.setCount:null,set_count:classified.setCount,payment_type:pureIsk?'ISK':'PLEX',plex_quantity:requested.reduce((n,row)=>n+row.quantity,0)});
      if(pureIsk){const blueprint=classifyBlueprintCopyContractItems(items);if(blueprint.valid&&blueprints.has(blueprint.blueprintTypeId))groups.get(`blueprint-copy:${blueprint.blueprintTypeId}`).push({...contract,unit_price:contract.price/blueprint.copyCount,price_per_run:contract.price/(blueprint.copyCount*blueprint.runs),copy_count:blueprint.copyCount,runs:blueprint.runs,material_efficiency:blueprint.materialEfficiency,time_efficiency:blueprint.timeEfficiency});}
    }
    this.db.exec('DELETE FROM contract_cache');const insert=this.db.prepare('INSERT INTO contract_cache(set_key,payload,fetched_at,expires_at) VALUES(?,?,?,?)');
    for(const [key,rows] of groups){rows.sort((a,b)=>(a.price_per_run??a.unit_price??Infinity)-(b.price_per_run??b.unit_price??Infinity));insert.run(key,JSON.stringify(rows),new Date().toISOString(),new Date(Date.now()+40*60000).toISOString());}
  }
  async history(runId,log) {
    const market=await this.pages('/markets/10000002/types/');
    const ids=[...new Set([...market,...getState(this.db,'history_seed',[]),...this.db.prepare('SELECT DISTINCT type_id FROM lp_exchange UNION SELECT DISTINCT material_type_id AS type_id FROM lp_requirements').all().map(row=>row.type_id)])];
    const done=new Set(this.db.prepare("SELECT key FROM checkpoints WHERE module='history' AND run_id=?").all(runId).map(row=>Number(row.key)));let completed=done.size;
    await this.map(ids.filter(id=>!done.has(id)),async id=>{
      let rows;try {rows=(await this.request('/markets/10000002/history/',{type_id:id})).data;}catch(error){if(error.status!==400&&error.status!==404)throw error;if(!/not tradable|type not found/i.test(error.message))throw error;rows=[];}
      if(!Array.isArray(rows))throw new Error(`Invalid history ${id}`);
      const insert=this.db.prepare("INSERT INTO history(type_id,date,average,highest,lowest,volume,order_count) VALUES(?,?,?,?,?,?,?) ON CONFLICT(type_id,date) DO UPDATE SET average=excluded.average,highest=excluded.highest,lowest=excluded.lowest,volume=excluded.volume,order_count=excluded.order_count WHERE history.sync_protected='N' AND (history.average<>excluded.average OR history.highest<>excluded.highest OR history.lowest<>excluded.lowest OR history.volume<>excluded.volume OR history.order_count<>excluded.order_count)");
      transaction(this.db,()=>{for(const row of rows){if(!/^\d{4}-\d{2}-\d{2}$/.test(row.date)||!Number.isInteger(row.order_count))throw new Error(`Invalid history row ${id}`);insert.run(id,row.date,row.average,row.highest,row.lowest,row.volume,row.order_count);}this.db.prepare("INSERT OR IGNORE INTO checkpoints(module,run_id,key) VALUES('history',?,?)").run(runId,String(id));});
      completed++;this.progress('history',completed,ids.length-completed,'日成交');if(completed%100===0)log.info('history_progress',{processed:completed,total:ids.length});
    });
  }
}
