import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import ts from 'typescript';
import {parseContractText,ContractTextError} from '../lib/contract-analysis.ts';

const uri=source=>'data:text/javascript;base64,'+Buffer.from(source).toString('base64');
async function route(t,path,db) {
  const slot='contract-boundary-'+crypto.randomUUID();globalThis[slot]=db;t.after(()=>delete globalThis[slot]);
  const url=new URL('../'+path,import.meta.url);
  const source=ts.transpileModule(readFileSync(url,'utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ESNext}}).outputText;
  return import(uri(source.replace(/from (["'])(\.\.?\/[^"']+)\1/g,(_,q,spec)=>'from '+JSON.stringify(
    spec.endsWith('/db/business')?uri(`export const ensureBusinessSchema=async()=>globalThis[${JSON.stringify(slot)}]`):
    spec.endsWith('/lib/esi-server')?uri('export const MARKET_REGION_ID=10000002; export const esiPost=async()=>{throw new Error("Unexpected ESI lookup")};'):
    new URL(spec.endsWith('.mjs')?spec:spec+'.ts',url).href
  ))));
}
const request=text=>new Request('http://test/api/data/contract-analysis',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({text})});

test('合同解析保留原始行号，正常处理表头、空行、CRLF、千位逗号和多列',()=>{
  const rows=parseContractText('\r\n品目\t数量\t分类\t类型\t槽位\r\n\r\n三钛合金\t30,719,950\t矿物\t材料\t货柜舱\r\n125mm加特林自动加农炮 I  2  射弹武器  装备  高能量槽');
  assert.deepEqual(rows.map(r=>[r.line,r.name,r.quantity,r.category,r.slot]),[[4,'三钛合金',30719950,'材料','货柜舱'],[5,'125mm加特林自动加农炮 I',2,'装备','高能量槽']]);
  assert.deepEqual(parseContractText('Name Quantity Category Type Slot\n\n'),[]);
  assert.equal(parseContractText('品目\t1')[0].quantity,1);
});
test('错误数量不能静默跳过，批量列出原始行号且限制错误响应大小',()=>{
  for(const quantity of ['', '0','-1','1.5','1e3','0x10','NaN','Infinity','abc','1,00','9007199254740992']) {
    assert.throws(()=>parseContractText('品目\t数量\n\n34\t100\n35\t'+quantity),e=>e instanceof ContractTextError&&e.issues[0].line===4&&e.issues[0].name==='35');
  }
  assert.throws(()=>parseContractText('34\t9007199254740991\n34\t1'),/本次未进行估价/);
  assert.throws(()=>parseContractText(Array.from({length:120},()=> '34\tbad').join('\n')),e=>e.issueCount===120&&e.issues.length===100);
  assert.throws(()=>parseContractText('34\t\t矿物\t材料'),e=>e.issues[0].reason==='缺少数量');
});
test('实际分析接口在查询前拒绝错误行，返回行号、原因和全部错误数',async t=>{
  const api=await route(t,'app/api/data/contract-analysis/route.ts',{prepare(){throw new Error('Invalid input must not read database');}});
  const response=await api.POST(request('\n品目\t数量\n34\t100\n35\t-1\n36\tfoo'));
  assert.equal(response.status,422);const data=await response.json();assert.equal(data.code,'INVALID_CONTRACT_LINES');assert.equal(data.issue_count,2);assert.deepEqual(data.issues.map(i=>i.line),[4,5]);assert.equal(data.rows,undefined);assert.equal(data.totals,undefined);
});
test('不同名称或 ID 指向同一物品时，合并数量溢出也不能估价',async t=>{
  const api=await route(t,'app/api/data/contract-analysis/route.ts',{prepare(){return {bind(){return this;},async all(){return {results:[{type_id:34,name_zh:'三钛合金',name_en:'Tritanium'}]};}};}});
  const response=await api.POST(request('34\t9007199254740991\nTritanium\t1'));
  assert.equal(response.status,422);const data=await response.json();assert.equal(data.code,'INVALID_CONTRACT_LINES');assert.equal(data.issues[0].line,2);
});
test('脑插和蓝图合同先过滤到期项，再计算总数与分页，不改持久化缓存',async t=>{
  const now=Date.parse('2026-10-11T12:00:00Z');t.mock.method(Date,'now',()=>now);
  const rows=[{contract_id:1,date_expired:new Date(now-1).toISOString()},{contract_id:2,date_expired:new Date(now).toISOString()},{contract_id:3,date_expired:'invalid'},{contract_id:4},{contract_id:5,date_expired:new Date(now+1).toISOString()},{contract_id:6,date_expired:'2099-01-01T00:00:00Z'}];
  const cache={payload:JSON.stringify(rows),fetched_at:'2026-10-11',expires_at:'2099-01-01',status:'ready',error_message:null};
  const api=await route(t,'app/api/data/contracts/route.ts',{prepare(sql){return {bind(){return this;},async first(){return sql.includes('contract_snapshots')?cache:{visible:1};}};}});
  for(const selector of ['type_ids=1,2,3,4,5,6','blueprint_type_id=11']) {
    const response=await api.GET(new Request('http://test/api/data/contracts?'+selector+'&page_size=1&page=99'));
    assert.equal(response.status,200);const data=await response.json();assert.equal(data.total,2);assert.equal(data.pages,2);assert.equal(data.page,2);assert.deepEqual(data.contracts.map(c=>c.contract_id),[6]);assert.equal(data.stale,false);
  }
  assert.equal(JSON.parse(cache.payload).length,6);
  cache.payload=JSON.stringify(rows.slice(0,4));
  const empty=await (await api.GET(new Request('http://test/api/data/contracts?type_ids=1,2,3,4,5,6&page=99'))).json();
  assert.equal(empty.total,0);assert.equal(empty.pages,1);assert.equal(empty.page,1);assert.deepEqual(empty.contracts,[]);
});
