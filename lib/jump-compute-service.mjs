import {Worker} from 'node:worker_threads';
import {availableParallelism} from 'node:os';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {isIP} from 'node:net';
import {createHash,randomUUID} from 'node:crypto';
import {JumpComputePool,JumpSourceLimiter,JumpComputeError} from './jump-compute-pool.mjs';

const token=value=>typeof value==='string'&&/^[a-f0-9-]{32,36}$/i.test(value);
const integer=(value,fallback,min,max)=>Number.isInteger(Number(value))&&Number(value)>=min&&Number(value)<=max?Number(value):fallback;
export function jumpRequestIdentity(request,{cancel=false,publicOrigin=process.env.JUMP_PUBLIC_ORIGIN}={}){
  const origin=request.headers.get('origin');
  const target=new URL(request.url),raw=request.headers.get('x-real-ip');let host=target.host,protocol=target.protocol;
  const forwardedProtocol=request.headers.get('x-forwarded-proto');if(raw&&isIP(raw)&&['http','https'].includes(forwardedProtocol))protocol=forwardedProtocol+':';
  // $host used by the generic proxy may omit a public non-default port. The
  // compute/cancel gateway locations overwrite this dedicated header with the
  // original HTTP Host, preserving strict same-origin host AND port checks.
  const originalHost=request.headers.get('x-jump-origin-host');
  if(raw&&isIP(raw)&&originalHost){try{const url=new URL(`http://${originalHost}`);if(url.username||url.password||url.pathname!=='/'||url.search||url.hash)throw new Error();host=url.host;}catch{throw new JumpComputeError('请求来源无效。',403,'JUMP_ORIGIN',0);}}
  // A configured public origin is authoritative when TLS terminates upstream.
  // Never infer it from arbitrary forwarded headers supplied by a client.
  if(publicOrigin){
    try{const url=new URL(publicOrigin);if(!['http:','https:'].includes(url.protocol)||url.username||url.password||url.pathname!=='/'||url.search||url.hash)throw new Error();host=url.host;protocol=url.protocol;}
    catch{throw new JumpComputeError('计算服务的公开站点配置无效，请联系管理员。',503,'JUMP_ORIGIN_CONFIG',0);}
  }
  if(request.headers.get('sec-fetch-site')==='cross-site')throw new JumpComputeError('请从本站页面发起计算。',403,'JUMP_ORIGIN',0);
  if(origin){try{const url=new URL(origin);if(url.host!==host||url.protocol!==protocol)throw new Error();}catch{throw new JumpComputeError('请从本站页面发起计算。',403,'JUMP_ORIGIN',0);}}
  // Shipped proxy overwrites X-Real-IP from its socket peer. Browser tokens and
  // client-controlled X-Forwarded-For never replace this source quota.
  const ip=raw&&isIP(raw)?raw.toLowerCase().replace(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/,'$1'):'unproxied';
  const source=createHash('sha256').update(ip).digest('hex'),client=request.headers.get('x-jump-client'),id=request.headers.get('x-jump-request');
  if(cancel&&(!token(client)||!token(id)))throw new JumpComputeError('取消任务参数无效。',400,'JUMP_INVALID_REQUEST',0);
  const requestId=token(id)?id:randomUUID();
  return {source,owner:`${source}/${token(client)?client:requestId}`,requestId};
}
export function createJumpComputeService({pool,limiter=new JumpSourceLimiter({burst:16,perSecond:2}),cancelLimiter=new JumpSourceLimiter({burst:24,perSecond:4}),now=()=>Date.now()}={}){
  const tombstones=new Map(),alias=identity=>JSON.stringify([identity.owner,identity.requestId]);
  function prune(){for(const [key,until]of tombstones){if(until>now())break;tombstones.delete(key);}}
  return {
    admit(request,{cancel=false}={}){const identity=jumpRequestIdentity(request,{cancel});(cancel?cancelLimiter:limiter).take(identity.source);return identity;},
    calculate(input,identity){prune();if(tombstones.has(alias(identity)))return Promise.reject(new JumpComputeError('已取消计算。',499,'JUMP_CANCELLED',0));return pool.submit(JSON.stringify(input),input,identity);},
    cancel(identity){prune();const key=alias(identity);tombstones.delete(key);if(tombstones.size>=4096)tombstones.delete(tombstones.keys().next().value);tombstones.set(key,now()+60000);return pool.cancel(identity.owner,identity.requestId);},
    stats:()=>pool.stats(),close:()=>pool.close(),
  };
}
const serviceKey=Symbol.for('eve.jump-compute.service.v1');
function currentService(){
  if(globalThis[serviceKey])return globalThis[serviceKey];
  const size=integer(process.env.JUMP_COMPUTE_WORKERS,Math.max(1,Math.min(4,availableParallelism()-1)),1,8),workerUrl=pathToFileURL(resolve(process.cwd(),'lib/jump-compute-worker.mjs'));
  const pool=new JumpComputePool({size,maxQueue:integer(process.env.JUMP_COMPUTE_QUEUE,8,0,32),maxPerSource:integer(process.env.JUMP_COMPUTE_SOURCE_PENDING,6,1,16),createWorker:()=>new Worker(workerUrl,{workerData:{filename:process.env.V2_SQLITE_PATH},resourceLimits:{maxOldGenerationSizeMb:384},execArgv:process.execArgv.filter(value=>!value.startsWith('--input-type'))})});
  const service=createJumpComputeService({pool});globalThis[serviceKey]=service;return service;
}
export const jumpComputeService={admit:(...args)=>currentService().admit(...args),calculate:(...args)=>currentService().calculate(...args),cancel:(...args)=>currentService().cancel(...args)};

export async function readJumpRequestBody(request){
  const limit=16384,length=Number(request.headers.get('content-length'));
  if(length>limit)throw new JumpComputeError('自动计算请求过大。',413,'JUMP_BODY_TOO_LARGE',0);
  if(!request.body)throw new JumpComputeError('自动计算参数不是有效 JSON。',400,'JUMP_INVALID_REQUEST',0);
  const reader=request.body.getReader();let timer;
  try{
    const raw=await Promise.race([
      (async()=>{const decoder=new TextDecoder();let bytes=0,text='';while(true){const {value,done}=await reader.read();if(done)break;bytes+=value.byteLength;if(bytes>limit)throw new JumpComputeError('自动计算请求过大。',413,'JUMP_BODY_TOO_LARGE',0);text+=decoder.decode(value,{stream:true});}return text+decoder.decode();})(),
      new Promise((_,reject)=>{timer=setTimeout(()=>reject(new JumpComputeError('读取计算参数超时，请重试。',408,'JUMP_BODY_TIMEOUT',0)),5000);}),
    ]);
    try{return JSON.parse(raw);}catch{throw new JumpComputeError('自动计算参数不是有效 JSON。',400,'JUMP_INVALID_REQUEST',0);}
  }finally{clearTimeout(timer);void reader.cancel().catch(()=>{});reader.releaseLock();}
}
