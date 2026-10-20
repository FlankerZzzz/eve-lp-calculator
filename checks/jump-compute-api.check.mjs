import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {EventEmitter} from 'node:events';
import ts from 'typescript';
import {JumpComputePool} from '../lib/jump-compute-pool.mjs';
import {createJumpComputeService} from '../lib/jump-compute-service.mjs';
const uri=code=>`data:text/javascript;base64,${Buffer.from(code).toString('base64')}`;
const body={origin:1,destination:3,waypoints:[],shipId:28846,skills:{calibration:5,conservation:5,shipSkill:5},avoid:{avoid:[],avoidList:true,avoidIncursions:true}};
async function fixture(t,options={}){
 const workers=[],pool=new JumpComputePool({...options,createWorker:()=>{const w=new EventEmitter();w.postMessage=m=>{w.message=m;};w.terminate=async()=>0;workers.push(w);queueMicrotask(()=>w.emit('message',{type:'ready'}));return w;}}),service=createJumpComputeService({pool}),slot=`jump-api-${crypto.randomUUID()}`;
 globalThis[slot]=service;t.after(async()=>{await pool.close();delete globalThis[slot];});
 const url=new URL('../app/api/navigation/jump/auto/route.ts',import.meta.url),js=ts.transpileModule(readFileSync(url,'utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ESNext}}).outputText;
 const code=js.replace(/from (["'])(\.\.?\/[^"']+)\1/g,(_,quote,spec)=>`from ${JSON.stringify(spec.endsWith('/jump-compute-service.mjs')?uri(`export const jumpComputeService=globalThis[${JSON.stringify(slot)}];export {readJumpRequestBody} from ${JSON.stringify(new URL('../lib/jump-compute-service.mjs',import.meta.url).href)};`):new URL(spec,url).href)}`);
 const api=await import(uri(code)),client=crypto.randomUUID(),request=crypto.randomUUID();
 const headers=(extra={})=>({'x-real-ip':'203.0.113.1','x-jump-client':client,'x-jump-request':request,...extra});
 const post=(value=body,extra={})=>{const p=api.POST(new Request('https://nav.example/api/navigation/jump/auto',{method:'POST',headers:headers(extra),body:JSON.stringify(value)}));p.catch(()=>{});return p;};
 const cancel=(extra={})=>api.DELETE(new Request('https://nav.example/api/navigation/jump/auto',{method:'DELETE',headers:headers(extra)}));
 const complete=worker=>{const id=worker.message.id;worker.emit('message',{type:'result',id,result:{status:200,body:{complete:true,legs:[]}},computeMs:1});};
 return {api,post,cancel,workers,pool,headers,complete};
}
const tick=()=>new Promise(resolve=>setImmediate(resolve));
test('HTTP repeated clicks share a bounded job, then return an explicit busy response with retry metadata',async t=>{
 const f=await fixture(t),a=f.post(),b=f.post();await tick();assert.equal(f.pool.stats().jobs,1);const rejected=await f.post();assert.equal(rejected.status,429);assert.equal(rejected.headers.get('retry-after'),'2');assert.equal(rejected.headers.get('cache-control'),'no-store');
 f.complete(f.workers[0]);assert.equal((await a).status,200);assert.equal((await b).status,200);assert.match((await a).headers.get('server-timing'),/jump_queue;dur=.*jump_compute;dur=/);
});
test('HTTP queue overflow is bounded and never reported as an unreachable navigation result',async t=>{
 const f=await fixture(t,{size:1,maxQueue:1}),a=f.post(),b=f.post({...body,destination:4},{'x-real-ip':'203.0.113.2','x-jump-client':crypto.randomUUID(),'x-jump-request':crypto.randomUUID()});await tick();
 const rejected=await f.post({...body,destination:5},{'x-real-ip':'203.0.113.3','x-jump-client':crypto.randomUUID(),'x-jump-request':crypto.randomUUID()});assert.equal(rejected.status,503);const data=await rejected.json();assert.equal(data.code,'JUMP_BUSY');assert.equal(data.complete,undefined);assert.equal(data.legs,undefined);
 f.complete(f.workers[0]);await a;f.complete(f.workers[0]);await b;
});
test('HTTP cancellation is scoped to its owner and also covers DELETE arriving before POST',async t=>{
 const f=await fixture(t),a=f.post();await tick();const noAccess=await f.cancel({'x-jump-client':crypto.randomUUID()});assert.equal(noAccess.status,200);assert.equal(f.pool.stats().active,1);
 assert.equal((await f.cancel()).status,200);const stopped=await a;assert.equal(stopped.status,499);assert.equal((await stopped.json()).code,'JUMP_CANCELLED');
 assert.equal((await f.post()).status,499);assert.equal(f.pool.stats().jobs,0);
});
test('invalid-input storms are source-limited before work and forged browser/forwarded headers cannot evade the quota',async t=>{
 const f=await fixture(t);
 for(let n=0;n<16;n++)assert.equal((await f.post(null,{'x-jump-client':crypto.randomUUID(),'x-jump-request':crypto.randomUUID(),'x-forwarded-for':`203.0.113.${n+2}`})).status,400);
 const limit=await f.post();assert.equal(limit.status,429);assert.ok(Number(limit.headers.get('retry-after'))>=1);assert.equal((await limit.json()).code,'JUMP_RATE_LIMIT');assert.equal(f.workers.length,0);
});
test('cross-site and oversized HTTP bodies are rejected without starting worker threads',async t=>{
 const f=await fixture(t);assert.equal((await f.post(body,{origin:'https://attacker.example'})).status,403);
 const large=await f.post({...body,padding:'x'.repeat(17000)});assert.equal(large.status,413);assert.equal((await large.json()).code,'JUMP_BODY_TOO_LARGE');assert.equal(f.workers.length,0);
});
