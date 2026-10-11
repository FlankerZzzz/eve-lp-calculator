import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,readFileSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {openV2,setState,getState} from '../scripts/v2/database.mjs';
import {enableV2Business} from '../scripts/v2/readiness.mjs';
import {calculateRankingOffer,rankingSignature} from '../scripts/v2/rankings.mjs';

test('正式切换要求全部同步成功、完整快照和历史，失败不授予就绪',t=>{
 const dir=mkdtempSync(join(tmpdir(),'v2-production-')),db=openV2(join(dir,'v2.db'));t.after(()=>{db.close();rmSync(dir,{recursive:true,force:true});});
 assert.throws(()=>enableV2Business(db),/items/);
 db.exec("UPDATE tasks SET last_success='fixture'; INSERT INTO items(type_id,name_zh,source,published,updated_at) VALUES(1,'测试','SDE',1,'fixture'); INSERT INTO lp_exchange(corporation_id,offer_id,corporation_name_zh,type_id,quantity,lp_cost,isk_cost,updated_at) VALUES(1,1,'军团',1,1,100,0,'fixture'); INSERT INTO quote_cache VALUES(1,5,6,10,10,'fixture'); INSERT INTO orders VALUES('snapshot',1,1,1,1,1,5,10,10,1,'station','fixture',90,'{}'); INSERT INTO contracts VALUES(1,'{}','snapshot');");
 assert.throws(()=>enableV2Business(db),/history 数据/);assert.equal(getState(db,'business_ready',false),false);
 db.exec("INSERT INTO history(type_id,date,average,highest,lowest,volume,order_count) VALUES(1,'2026-10-10',5,6,4,10,1)");
 setState(db,'orders',{generation:'snapshot',order_count:1});setState(db,'contracts',{generation:'snapshot',count:2});
 assert.throws(()=>enableV2Business(db),/contracts 完整快照/);assert.equal(getState(db,'business_ready',false),false);
 setState(db,'contracts',{generation:'snapshot',count:1});setState(db,'business_test_ready',true);
 const result=enableV2Business(db);assert.equal(result.production_ready,true);assert.equal(result.rankings.history_complete,true);assert.equal(getState(db,'business_ready'),true);assert.equal(getState(db,'business_test_ready',null),null);
});
test('纯 V2 运行配置不再包含旧库、旧同步器或测试模式',()=>{
 const source=p=>readFileSync(new URL('../'+p,import.meta.url),'utf8');
 for(const path of ['db/d1.ts','db/sqlite.ts','db/schema.ts','scripts/sync-daemon.mjs','scripts/order-sync-daemon.mjs','scripts/contract-sync-daemon.mjs','scripts/sync-worker.mjs','app/api/sync/catalog/route.ts'])assert.equal(existsSync(new URL('../'+path,import.meta.url)),false);
 assert.doesNotMatch(source('db/business.ts'),/from '.\/d1'|business_test_ready|V2_TEST_MODE/);assert.match(source('db/business.ts'),/readOnly: true/);
 assert.match(source('docker-compose.yml'),/scripts\/v2\/worker.mjs/);assert.doesNotMatch(source('docker-compose.yml'),/docker-data\/sqlite|wrangler|sync-daemon|SYNC_INTERNAL_TOKEN/);
 assert.match(source('nginx/nginx.conf'),/location = \/sync-v2/);assert.match(source('nginx/nginx.conf'),/location \^~ \/api\/v2\//);
 assert.equal(JSON.parse(source('package.json')).version,'2.0.0');assert.match(source('app/page.tsx'),/V2.0.0/);
});
test('V2 排行保持真实收单、深度保护、税率和跨军团去重签名',()=>{
 const base={type_id:1,quantity:1,lp_cost:10,isk_cost:1,buy_price:10,sell_price:12,materials:[]};
 const result=calculateRankingOffer(base);assert.equal(result.min_profit,10*.97-1);assert.equal(result.max_profit,12*.97-1);
 for(const row of [{...base,buy_price:0},{...base,buy_execution_coverage:.5},{...base,materials:[{type_id:2,quantity:3,sell_price:1,sell_execution_coverage:.5}]}]){assert.equal(calculateRankingOffer(row).min_profit,null);assert.equal(calculateRankingOffer(row).lp_ratio,0);}
 assert.equal(rankingSignature({...base,corporation_id:1}),rankingSignature({...base,corporation_id:2}));
});
