import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createContractNameResolver} from '../lib/contract-analysis.ts';
import {createContractNameCache} from '../lib/contract-name-cache.ts';
test('indexed contract lookup preserves normalization, ambiguity, IDs and duplicate rows',()=>{
 const rows=[{type_id:1,name_zh:'“异域” A',name_en:'One'},{type_id:2,name_zh:'同名',name_en:'Two'},{type_id:3,name_zh:'同名',name_en:'Three'},{type_id:1,name_zh:'“异域” A',name_en:'One'}];
 const lookup=createContractNameResolver(rows);assert.equal(lookup('  "异域"   a ').item.type_id,1);assert.equal(lookup('ONE').item.type_id,1);assert.equal(lookup(' 2 ').item.type_id,2);assert.equal(lookup('同名').ambiguous,true);assert.deepEqual(lookup('同名').candidates.map(x=>x.type_id),[2,3]);assert.equal(lookup('missing').item,null);
 rows.push({type_id:4,name_zh:'补齐',name_en:null});assert.equal(createContractNameResolver(rows)('补齐').item.type_id,4);
});
test('name cache reuses successes and empty results, expires, and coalesces concurrent requests',async()=>{
 let now=0,calls=0;const lookup=createContractNameCache(async()=>{calls++;return {inventory_types:[{id:1,name:'one'}]};},()=>now);
 const data=await Promise.all([lookup(['one','missing']),lookup(['missing','one','one'])]);assert.equal(calls,1);assert.deepEqual(data[0],data[1]);await lookup(['one','missing']);assert.equal(calls,1);now=600001;await lookup(['one','missing']);assert.equal(calls,2);
 let emptyCalls=0;const empty=createContractNameCache(async()=>{emptyCalls++;return {};});await empty(['missing']);await empty(['missing']);assert.equal(emptyCalls,1);
});
test('failed or malformed name responses are never cached; bounded cache evicts old entries',async()=>{
 let calls=0;const broken=createContractNameCache(async()=>{calls++;throw new Error('network');});for(let i=0;i<2;i++)await assert.rejects(broken(['x']),/network/);assert.equal(calls,2);
 const malformed=createContractNameCache(async()=>({inventory_types:[{id:0,name:'bad'}]}));await assert.rejects(malformed(['x']),/Invalid ESI/);
 let loads=0;const bounded=createContractNameCache(async()=>{loads++;return {};});for(let i=0;i<129;i++)await bounded([String(i)]);await bounded(['0']);assert.equal(loads,130);
});
