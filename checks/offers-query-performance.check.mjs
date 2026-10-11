import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import ts from 'typescript';
import {openV2} from '../scripts/v2/database.mjs';

const source=readFileSync(new URL('../app/api/data/offers/route.ts',import.meta.url),'utf8');
// Keep the pre-optimization query as an independent regression oracle.
const oldSource=source.replace('WITH selected_offers AS (${selectedSql}), recent AS (','WITH recent AS (')
  .replace('type_id IN (SELECT revenue_type_id FROM selected_offers)\n        AND ','')
  .replace('WHERE (m.corporation_id,m.offer_id) IN (SELECT corporation_id,offer_id FROM selected_offers)','')
  .replace('WHERE bm.blueprint_type_id IN (SELECT type_id FROM selected_offers)','')
  .replace('const bindings = [\n    ...filters,','const bindings = [')
  .replace('`SELECT COUNT(*) count FROM (${selectedSql}) selected`).bind(...filters)','`SELECT COUNT(*) count FROM (${baseSql}) ranked`).bind(...bindings)');
const uri=s=>`data:text/javascript;base64,${Buffer.from(s).toString('base64')}`;
async function load(code,key){
 const url=new URL('../app/api/data/offers/route.ts',import.meta.url);
 const js=ts.transpileModule(code,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ESNext}}).outputText;
 return import(uri(js.replace(/from (["'])(\.\.?\/[^"']+)\1/g,(_,q,spec)=>`from ${JSON.stringify(spec.endsWith('/db/business')?uri(`export const ensureBusinessSchema=async()=>globalThis[${JSON.stringify(key)}]`):spec.endsWith('/lib/esi-server')?uri('export const MARKET_REGION_ID=10000002'):new URL(spec+'.ts',url).href)}`)));
}
test('scoped detail queries preserve prices, materials, sorting, pagination and visibility',async t=>{
 const dir=mkdtempSync(join(tmpdir(),'offers-performance-')),db=openV2(join(dir,'fixture.db')),key='offers-'+crypto.randomUUID(),queries=[];
 const previous=process.env.BUSINESS_DATABASE;process.env.BUSINESS_DATABASE='v2';
 t.after(()=>{db.close();rmSync(dir,{recursive:true,force:true});delete globalThis[key];if(previous===undefined)delete process.env.BUSINESS_DATABASE;else process.env.BUSINESS_DATABASE=previous;});
 globalThis[key]={prepare:sql=>{let values=[];const s={bind:(...v)=>{values=v;return s;},first:async()=>{queries.push({sql,values});return db.prepare(sql).get(...values)??null;},all:async()=>{queries.push({sql,values});return {results:db.prepare(sql).all(...values)};}};return s;}};
 for(const [id,name] of [[1,'普通物品'],[2,'制造产出'],[3,'制造蓝图'],[4,'材料'],[5,'增效剂蓝图'],[6,'增效剂'],[7,'缺价物品'],[8,'无关物品']]){
  db.prepare("INSERT INTO items(type_id,name_zh,name_en,source,published,updated_at) VALUES(?,?,?,'SDE',1,'now')").run(id,name,'Item '+id);
  if(id!==7)db.prepare('INSERT INTO quote_cache VALUES(?,?,?,?,?,?)').run(id,100*id,120*id,100,100,'now');
 }
 for(const [id,corp,type,lp,ak,blocked] of [[1,10,1,100,0,'N'],[2,10,3,200,0,'N'],[3,10,5,300,0,'N'],[4,10,7,400,0,'N'],[5,10,1,100,0,'Y'],[6,10,1,100,1,'N'],[1,11,8,100,0,'N']])
  db.prepare("INSERT INTO lp_exchange(corporation_id,offer_id,faction_id,corporation_name_zh,type_id,quantity,lp_cost,isk_cost,ak_cost,is_blocked,updated_at) VALUES(?,?,500001,'军团',?,2,?,10,?,?,'now')").run(corp,id,type,lp,ak,blocked);
 for(const [blueprint,product] of [[3,2],[5,6]]){db.prepare("INSERT INTO recipes VALUES(?,?,3,60,'N','now')").run(blueprint,product);db.prepare('INSERT INTO recipe_materials VALUES(?,4,5)').run(blueprint);}
 db.prepare('INSERT INTO lp_requirements VALUES(10,1,4,2)').run();
 for(const id of [1,2,4,6,8])for(const date of ['2026-09-01','2026-09-28','2026-10-09'])db.prepare('INSERT INTO history(type_id,date,average,highest,lowest,volume,order_count) VALUES(?,?,100,120,80,10,2)').run(id,date);
 const modern=await load(source,key),legacy=await load(oldSource,key);
 for(const params of ['', '&include_booster_blueprints=1','&page=2','&page_size=all','&faction_id=500002','&days=7&tax=9','&sort_key=materialCost&sort_direction=asc','&sort_key=volume','&sort_key=buy_price&sort_direction=asc']){
  const request=()=>new Request('http://localhost/api/data/offers?corporation_id=10&view=detail'+params);
  assert.deepEqual(await (await modern.GET(request())).json(),await (await legacy.GET(request())).json(),params);
 }
 queries.length=0;await modern.GET(new Request('http://localhost/api/data/offers?corporation_id=10&view=detail'));
 const count=queries.find(q=>q.sql.includes('COUNT(*) count'));assert.ok(!count.sql.includes('market_daily'));assert.ok(!count.sql.includes('ROW_NUMBER'));
 const page=queries.find(q=>q.sql.includes('WITH selected_offers'));
 const plans=db.prepare('EXPLAIN QUERY PLAN '+page.sql).all(...page.values);
 assert.ok(plans.some(p=>p.detail.includes('SEARCH history')&&p.detail.includes('type_id=?')));
 assert.ok(!plans.some(p=>p.detail.startsWith('SCAN history')),'must not scan unrelated history');
});
test('all three containers have bounded rotated logs',()=>{
 const compose=readFileSync(new URL('../docker-compose.yml',import.meta.url),'utf8');
 assert.equal((compose.match(/max-size: "10m"/g)||[]).length,3);
 assert.equal((compose.match(/max-file: "3"/g)||[]).length,3);
});
