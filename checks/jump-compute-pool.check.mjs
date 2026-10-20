import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {JumpComputePool,JumpSourceLimiter} from '../lib/jump-compute-pool.mjs';
import {createJumpComputeService,jumpRequestIdentity,readJumpRequestBody} from '../lib/jump-compute-service.mjs';
import {normalizeJumpRequest} from '../lib/jump-auto-request.mjs';
const tick=()=>new Promise(resolve=>setImmediate(resolve));
const identity=n=>({source:`source-${n}`,owner:`owner-${n}`,requestId:`request-${n}`});
class FakeWorker extends EventEmitter{
  constructor(){super();this.message=null;this.terminated=false;queueMicrotask(()=>this.emit('message',{type:'ready'}));}
  ref(){}unref(){}
  postMessage(message){this.message=message;}
  complete(body={complete:true}){const id=this.message.id;this.message=null;this.emit('message',{type:'result',id,result:{status:200,body},computeMs:5});}
  async terminate(){this.terminated=true;return 0;}
}
function fixture(t,options={}){
  const workers=[],pool=new JumpComputePool({...options,createWorker:()=>{const worker=new FakeWorker();workers.push(worker);return worker;}});
  t.after(()=>pool.close());
  const submit=(key,n=key,extra={})=>{const promise=pool.submit(String(key),{value:key},{...identity(n),...extra});promise.catch(()=>{});return promise;};
  return {pool,workers,submit};
}
test('four active threads, eight queued jobs, bounded overflow and FIFO dispatch',async t=>{
  const {pool,workers,submit}=fixture(t),promises=Array.from({length:12},(_,i)=>submit(i));await tick();
  assert.deepEqual(pool.stats(),{workers:4,active:4,queued:8,starting:0,jobs:12,waiters:12});
  await assert.rejects(submit(12),e=>e.status===503&&e.code==='JUMP_BUSY');assert.equal(workers.length,4);
  assert.deepEqual(workers.map(w=>w.message.input.value),[0,1,2,3]);workers[0].complete();assert.equal(workers[0].message.input.value,4);
  while(pool.stats().jobs){for(const worker of workers)if(worker.message&&!worker.terminated)worker.complete();await tick();}
  assert.ok((await Promise.all(promises)).every(r=>r.status===200));assert.equal(pool.bindings.size,0);assert.equal(pool.owners.size,0);assert.equal(pool.sources.size,0);
});
test('same request shares in-flight work; no completed-result cache',async t=>{
  const {pool,workers,submit}=fixture(t),a=submit('same',1),b=submit('same',2);await tick();assert.equal(workers.length,1);assert.equal(pool.stats().jobs,1);
  workers[0].complete({answer:42});assert.deepEqual((await a).body,(await b).body);
  const c=submit('same',3);assert.equal(pool.stats().active,1);workers[0].complete({answer:43});assert.equal((await c).body.answer,43);
});
test('one client cannot run two different jobs and repeated HTTP waiters remain bounded',async t=>{
  const {pool,workers,submit}=fixture(t),a=submit('a',1),b=submit('a',1);await tick();
  await assert.rejects(submit('a',1),e=>e.status===429);await assert.rejects(submit('b',1,{requestId:'another'}),e=>e.status===429);
  await assert.rejects(submit('b',1),e=>e.status===409);assert.equal(pool.stats().jobs,1);workers[0].complete();await Promise.all([a,b]);
});
test('source pending quota survives browser-token rotation; other sources retain capacity',async t=>{
  const {pool,workers,submit}=fixture(t,{maxPerSource:2}),a=submit('a',1,{source:'same'}),b=submit('b',2,{source:'same'});await tick();
  await assert.rejects(submit('c',3,{source:'same'}),e=>e.status===429&&e.code==='JUMP_RATE_LIMIT');
  const c=submit('c',3);await tick();assert.equal(pool.stats().jobs,3);for(const worker of workers)worker.complete();await Promise.all([a,b,c]);
});
test('cancel removes queued work immediately and cannot cancel another owner',async t=>{
  const {pool,workers,submit}=fixture(t,{size:1}),a=submit('a',1),b=submit('b',2);await tick();
  assert.equal(pool.cancel('wrong','request-2'),false);assert.equal(pool.cancel('owner-2','request-2'),true);await assert.rejects(b,e=>e.status===499);
  assert.equal(pool.stats().queued,0);workers[0].complete();await a;
});
test('one shared subscriber cancellation leaves other subscribers running',async t=>{
  const {pool,workers,submit}=fixture(t),a=submit('same',1),b=submit('same',2);await tick();
  pool.cancel('owner-1','request-1');await assert.rejects(a,e=>e.status===499);assert.equal(workers[0].terminated,false);assert.equal(pool.stats().active,1);
  workers[0].complete();await b;
});
test('aborted subscriber and last-subscriber cancellation terminate running work and restore capacity',async t=>{
  const {pool,workers,submit}=fixture(t,{size:1}),abort=new AbortController(),a=submit('a',1,{signal:abort.signal});await tick();abort.abort();await assert.rejects(a,e=>e.status===499);await tick();assert.equal(workers[0].terminated,true);
  const b=submit('b',2);await tick();assert.equal(workers.length,2);assert.equal(pool.stats().active,1);workers[1].complete();await b;
});
test('queue, execution and startup deadlines release all bookkeeping without fake partial results',async t=>{
  const a=fixture(t,{size:1,queueMs:30,taskMs:1000}),running=a.submit('a',1),queued=a.submit('b',2);await tick();
  await assert.rejects(queued,e=>e.code==='JUMP_QUEUE_TIMEOUT');a.workers[0].complete();await running;
  const b=fixture(t,{size:1,taskMs:30}),timeout=b.submit('c',3);await assert.rejects(timeout,e=>e.code==='JUMP_TASK_TIMEOUT');await tick();assert.equal(b.pool.stats().jobs,0);
  const worker=new FakeWorker();worker.removeAllListeners();
  const stalled=new JumpComputePool({size:1,startupMs:30,createWorker:()=>{const w=new EventEmitter();w.terminate=async()=>0;w.postMessage=()=>{};return w;}});t.after(()=>stalled.close());
  await assert.rejects(stalled.submit('x',{},identity(9)),e=>e.code==='JUMP_WORKER_FAILED');
});
test('worker error and stale messages cannot resurrect a cancelled or failed job',async t=>{
  const {pool,workers,submit}=fixture(t,{size:1}),a=submit('a',1),b=submit('b',2);await tick();const stale=workers[0].message.id;
  workers[0].emit('error',new Error('private path must not leak'));await assert.rejects(a,e=>e.code==='JUMP_WORKER_FAILED'&&!e.message.includes('private'));await tick();
  workers[0].emit('message',{type:'result',id:stale,result:{status:200,body:{}},computeMs:1});assert.equal(pool.stats().jobs,1);workers[1].complete();await b;
});
test('cancellation storms never create replacement threads before old threads stop',async t=>{
  const {pool,workers,submit}=fixture(t,{size:2}),a=submit('a',1),b=submit('b',2);await tick();const releases=[];
  for(const worker of workers)worker.terminate=()=>new Promise(resolve=>releases.push(()=>{worker.terminated=true;resolve(0);}));
  pool.cancel('owner-1','request-1');pool.cancel('owner-2','request-2');await Promise.allSettled([a,b]);await tick();
  const c=submit('c',3),d=submit('d',4);assert.equal(workers.length,2);assert.equal(pool.stats().workers,2);assert.equal(pool.stats().queued,2);
  for(const release of releases)release();await tick();assert.equal(workers.length,4);assert.equal(pool.stats().workers,2);workers[2].complete();workers[3].complete();await Promise.all([c,d]);
});
test('token buckets refill on elapsed time, do not lose fractional tokens on rejection and stay bounded',()=>{
  let now=0;const limiter=new JumpSourceLimiter({burst:2,perSecond:1,maxSources:2,now:()=>now});limiter.take('a');limiter.take('a');assert.throws(()=>limiter.take('a'),e=>e.status===429);
  now=500;assert.throws(()=>limiter.take('a'));now=1000;limiter.take('a');limiter.take('b');limiter.take('c');assert.equal(limiter.rows.size,2);
});
test('proxy source is independent of supplied forwarded chains and client IDs; cross-site requests rejected',()=>{
  const req=headers=>new Request('https://nav.example/api/navigation/jump/auto',{headers});
  const a=jumpRequestIdentity(req({'x-real-ip':'203.0.113.1','x-forwarded-for':'203.0.113.2','x-jump-client':'a'.repeat(32)})),b=jumpRequestIdentity(req({'x-real-ip':'203.0.113.1','x-forwarded-for':'203.0.113.3','x-jump-client':'b'.repeat(32)}));
  assert.equal(a.source,b.source);assert.notEqual(a.owner,b.owner);assert.equal(jumpRequestIdentity(req({'x-forwarded-for':'203.0.113.1'})).source,jumpRequestIdentity(req({})).source);
  assert.throws(()=>jumpRequestIdentity(req({origin:'https://other.example'})),e=>e.status===403);assert.throws(()=>jumpRequestIdentity(req({'sec-fetch-site':'cross-site'})),e=>e.status===403);
  assert.throws(()=>jumpRequestIdentity(req({}),{cancel:true}),e=>e.status===400);
  assert.doesNotThrow(()=>jumpRequestIdentity(req({'x-real-ip':'203.0.113.1','x-jump-origin-host':'nav.example:8443',origin:'https://nav.example:8443'})));
  assert.throws(()=>jumpRequestIdentity(req({'x-real-ip':'203.0.113.1','x-jump-origin-host':'nav.example:8443',origin:'https://nav.example:8444'})),e=>e.status===403);
  assert.throws(()=>jumpRequestIdentity(req({'x-jump-origin-host':'attacker.example',origin:'https://attacker.example'})),e=>e.status===403);
  assert.throws(()=>jumpRequestIdentity(req({origin:'http://nav.example'})),e=>e.status===403);
});
test('configured public origin supports upstream TLS without trusting spoofed origins or forwarded protocol',()=>{
  const req=headers=>new Request('http://internal.example/api/navigation/jump/auto',{headers:{'x-real-ip':'203.0.113.1','x-forwarded-proto':'http',...headers}}),options={publicOrigin:'https://nav.example:8443'};
  assert.doesNotThrow(()=>jumpRequestIdentity(req({origin:'https://nav.example:8443'}),options));
  for(const origin of ['http://nav.example:8443','https://nav.example','https://attacker.example'])assert.throws(()=>jumpRequestIdentity(req({origin,'x-forwarded-proto':'https','x-jump-origin-host':'attacker.example'}),options),e=>e.status===403);
  assert.throws(()=>jumpRequestIdentity(req({origin:options.publicOrigin,'sec-fetch-site':'cross-site'}),options),e=>e.status===403);
  for(const publicOrigin of ['https://nav.example/path','https://user:pass@nav.example','javascript:bad','https://nav.example?x=1','https://nav.example#x'])assert.throws(()=>jumpRequestIdentity(req({}),{publicOrigin}),e=>e.status===503&&e.code==='JUMP_ORIGIN_CONFIG');
});
test('cancel arriving before POST leaves a short-lived tombstone rather than starting orphan work',async()=>{
  let calls=0,now=0;const service=createJumpComputeService({pool:{cancel(){},submit(){calls++;return Promise.resolve({});}},now:()=>now}),who=identity(1);
  service.cancel(who);await assert.rejects(service.calculate({},who),e=>e.status===499);assert.equal(calls,0);now=60001;await service.calculate({},who);assert.equal(calls,1);
});
test('request body bounds count UTF-8 bytes and reject malformed JSON without allocating work',async()=>{
  const req=body=>new Request('https://nav.example/api/navigation/jump/auto',{method:'POST',body});
  assert.deepEqual(await readJumpRequestBody(req('{"a":1}')),{a:1});await assert.rejects(readJumpRequestBody(req('{bad')),e=>e.status===400);
  await assert.rejects(readJumpRequestBody(req('x'.repeat(16385))),e=>e.status===413);await assert.rejects(readJumpRequestBody(req(JSON.stringify({value:'汉'.repeat(6000)}))),e=>e.status===413);
  const declared=new Request('https://nav.example/api/navigation/jump/auto',{method:'POST',body:'{}',headers:{'content-length':'17000'}});await assert.rejects(readJumpRequestBody(declared),e=>e.status===413);
});
test('slow body read has a deadline and is cancelled before it can consume a pool slot',async t=>{
  t.mock.timers.enable({apis:['setTimeout']});let cancelled=false;
  const stream=new ReadableStream({cancel(){cancelled=true;}}),request=new Request('https://nav.example/api/navigation/jump/auto',{method:'POST',body:stream,duplex:'half'}),pending=readJumpRequestBody(request);
  t.mock.timers.tick(5001);await assert.rejects(pending,e=>e.status===408);assert.equal(cancelled,true);
});
test('normalized in-flight keys preserve route order and safety options, reject fake capacities and ignore untrusted data',()=>{
  const body={origin:1,destination:3,waypoints:[2,2],shipId:28846,skills:{calibration:5,conservation:5,shipSkill:5},avoid:{avoid:[5,4,5],avoidList:true,avoidIncursions:true}},a=normalizeJumpRequest({...body,ship:{baseRange:1000},stations:{},maxWorkers:100}),b=normalizeJumpRequest({...body,avoid:{...body.avoid,avoid:[4,5]}});
  assert.deepEqual(a,b);assert.deepEqual(a.waypoints,[2,2]);assert.equal('maxWorkers' in a,false);assert.notDeepEqual(a,normalizeJumpRequest({...body,npcStationsOnly:true}));assert.notDeepEqual(a,normalizeJumpRequest({...body,waypoints:[2]}));
});
