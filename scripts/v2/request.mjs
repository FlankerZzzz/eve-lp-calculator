import { appendFileSync, mkdirSync, readdirSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

export function requestSettings(env=process.env) {
  const rate=Number(env.V2_REQUEST_RATE??5),concurrency=Number(env.V2_REQUEST_CONCURRENCY??8);
  if(!Number.isFinite(rate)||rate<1||rate>20)throw new Error('V2_REQUEST_RATE must be between 1 and 20');
  if(!Number.isSafeInteger(concurrency)||concurrency<1||concurrency>32)throw new Error('V2_REQUEST_CONCURRENCY must be an integer between 1 and 32');
  return {rate,concurrency};
}

export class ModuleLog {
  constructor(root,module,runId,debug=false) { this.root=root; this.module=module; this.runId=runId; this.debug=debug; mkdirSync(join(root,module),{recursive:true}); }
  info(event,data={}) { this.write('INFO',event,data); }
  write(level,event,data) { appendFileSync(join(this.root,this.module,`${new Date().toISOString().slice(0,10)}.jsonl`),JSON.stringify({time:new Date().toISOString(),module:this.module,run_id:this.runId,level,event,...data})+'\n'); }
  payload(label,data) {
    if(!this.debug) return;
    const file=`${this.runId.replaceAll(':','-')}-${crypto.randomUUID()}.json`;
    writeFileSync(join(this.root,this.module,file),JSON.stringify(data));
    this.write('DEBUG',label,{attachment:file});
  }
  static clean(root) {
    mkdirSync(root,{recursive:true});
    const cutoff=Date.now()-7*86400000;
    for(const moduleEntry of readdirSync(root,{withFileTypes:true}).filter(x=>x.isDirectory())) for(const file of readdirSync(join(root,moduleEntry.name),{withFileTypes:true}).filter(x=>x.isFile())) {
      const path=join(root,moduleEntry.name,file.name); if(statSync(path).mtimeMs<cutoff) unlinkSync(path);
    }
  }
}

export class RequestPool {
  constructor({concurrency=8,rate=5,fetchImpl=fetch,now=()=>Date.now()}={}) { this.limit=concurrency; this.interval=1000/rate; this.fetch=fetchImpl; this.now=now; this.active=0; this.next=0; this.cooldown=0; this.queue=[]; this.wake=null; this.limits=0; }
  async request(url,{signal,log,method='GET',body,retrySafe=method==='GET'}={}) {
    for(let attempt=0;attempt<4;attempt++) {
      signal?.throwIfAborted();
      if(attempt) await delay((2**(attempt-1))*1000+Math.random()*500,undefined,{signal});
      try {
        const result=await this.dispatch(async()=>{
          const started=this.now();
          const response=await this.fetch(url,{method,body:body===undefined?undefined:JSON.stringify(body),headers:{accept:'application/json','content-type':'application/json','user-agent':'EVE-LP-V2'},signal:signal ? AbortSignal.any([signal,AbortSignal.timeout(30000)]) : AbortSignal.timeout(30000)});
          const text=await response.text();
          log?.info('request',{path:new URL(url).pathname,status:response.status,attempt:attempt+1,duration_ms:this.now()-started});
          const remainHeader=response.headers.get('x-esi-error-limit-remain'),resetHeader=response.headers.get('x-esi-error-limit-reset');
          const remain=remainHeader===null?NaN:Number(remainHeader),reset=resetHeader===null?NaN:Number(resetHeader);
          if(Number.isFinite(remain)&&remain<=Math.max(10,this.limit*2)&&Number.isFinite(reset)&&reset>0) {
            this.cooldown=Math.max(this.cooldown,this.now()+(reset+1)*1000);
            log?.info('error_budget_cooldown',{remaining:remain,until:new Date(this.cooldown).toISOString()});
          }
          if(response.status===420||response.status===429) {
            const raw=response.headers.get('retry-after');
            const seconds=raw&&/^\d+(\.\d+)?$/.test(raw) ? Number(raw)*1000 : raw ? Date.parse(raw)-this.now() : 0;
            const wait=Math.max(Number.isFinite(seconds)?seconds:0,Math.min(60000*2**this.limits++,300000));
            this.cooldown=Math.max(this.cooldown,this.now()+wait); log?.info('cooldown',{until:new Date(this.cooldown).toISOString()});
          }
          if(!response.ok) { const error=new Error(`HTTP ${response.status} ${new URL(url).pathname}: ${text.slice(0,160)}`); error.status=response.status; throw error; }
          let data;
          try {data=JSON.parse(text);} catch(cause) {
            const path=new URL(url).pathname;
            log?.info('invalid_json',{path,http_status:response.status,bytes:Buffer.byteLength(text),empty:!text.trim()});
            const error=new Error(`Invalid JSON response ${path} (HTTP ${response.status}, ${Buffer.byteLength(text)} bytes)`,{cause});
            error.code='INVALID_JSON_RESPONSE';
            // Keep this separate from error.status: HTTP 200 malformed bodies still need retrying.
            error.httpStatus=response.status;error.responseBytes=Buffer.byteLength(text);error.emptyResponse=!text.trim();throw error;
          }
          log?.payload('response',data);
          return {data,pages:Number(response.headers.get('x-pages')||1),modified:response.headers.get('last-modified'),expires:response.headers.get('expires')};
        },signal);
        return result;
      } catch(error) {
        signal?.throwIfAborted();
        const retryable=!error.status || [408,420,429,500,502,503,504].includes(error.status);
        if(!retrySafe||!retryable||attempt===3) throw error;
        log?.info('retry',{attempt:attempt+1,message:error.message});
      }
    }
    throw new Error('Retry exhausted');
  }
  dispatch(fn,signal) { return new Promise((resolve,reject)=>{this.queue.push({fn,signal,resolve,reject});this.pump();}); }
  pump() {
    if(this.wake) return;
    while(this.queue[0]?.signal?.aborted) this.queue.shift().reject(new DOMException('Cancelled','AbortError'));
    if(!this.queue.length||this.active>=this.limit) return;
    const wait=Math.max(this.next,this.cooldown)-this.now();
    if(wait>0) { this.wake=setTimeout(()=>{this.wake=null;this.pump();},Math.min(wait,1000));return; }
    const task=this.queue.shift(); this.active++; this.next=this.now()+this.interval;
    Promise.resolve().then(task.fn).then(task.resolve,task.reject).finally(()=>{this.active--;this.pump();});
    this.pump();
  }
}

export async function mapPool(rows,callback,concurrency=8) {
  let cursor=0; let failure;
  await Promise.all(Array.from({length:Math.min(concurrency,rows.length)},async()=>{
    while(cursor<rows.length&&!failure) { const index=cursor++; try {await callback(rows[index],index);} catch(error) {failure=error;} }
  }));
  if(failure) throw failure;
}
