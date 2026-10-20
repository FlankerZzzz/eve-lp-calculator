const errorBrand=Symbol.for('eve.jump-compute.error');
export class JumpComputeError extends Error{
  constructor(message,status=503,code='JUMP_BUSY',retryAfter=2){super(message);this[errorBrand]=true;this.status=status;this.code=code;this.retryAfter=retryAfter;}
}
/** @returns {error is JumpComputeError} */
export function isJumpComputeError(error){return error instanceof Error&&error[errorBrand]===true;}
const busy=()=>new JumpComputeError('当前旗舰计算繁忙，请稍后重试。');
const cancelled=()=>new JumpComputeError('已取消计算。',499,'JUMP_CANCELLED',0);

// Bounded jobs AND HTTP waiters. Only in-flight identical requests are shared;
// completed routes are never reused without reading current server snapshots.
export class JumpComputePool{
  constructor({size=4,maxQueue=8,maxPerSource=6,maxWaiters=48,queueMs=10000,taskMs=45000,startupMs=5000,createWorker}={}){
    if(!Number.isInteger(size)||size<1||!Number.isInteger(maxQueue)||maxQueue<0||typeof createWorker!=='function')throw new Error('Invalid compute pool configuration');
    Object.assign(this,{size,maxQueue,maxPerSource,maxWaiters,queueMs,taskMs,startupMs,createWorker});
    this.jobs=new Map();this.bindings=new Map();this.owners=new Map();this.sources=new Map();this.slots=new Set();this.queue=[];this.serial=0;this.closed=false;
  }
  stats(){return {workers:this.slots.size,active:[...this.slots].filter(s=>s.state==='busy').length,queued:this.queue.length,starting:[...this.slots].filter(s=>s.state==='starting').length,jobs:this.jobs.size,waiters:[...this.bindings.values()].reduce((n,b)=>n+b.waiters.size,0)};}
  submit(key,input,{source,owner,requestId,signal}={}){
    if(this.closed)return Promise.reject(busy());
    if(signal?.aborted)return Promise.reject(cancelled());
    const alias=JSON.stringify([owner,requestId]);let binding=this.bindings.get(alias),job=this.jobs.get(key);
    if(binding&&(binding.job.key!==key||binding.source!==source))return Promise.reject(new JumpComputeError('任务标识已被使用，请重新计算。',409,'JUMP_REQUEST_CONFLICT',0));
    if(this.stats().waiters>=this.maxWaiters)return Promise.reject(busy());
    if(binding?.waiters.size>=2)return Promise.reject(new JumpComputeError('相同请求正在计算，请等待完成。',429,'JUMP_ALREADY_RUNNING'));
    if(!binding){
      const owned=[...(this.owners.get(owner)??[])].map(id=>this.bindings.get(id));
      if(owned.some(b=>b.job.key!==key)||owned.length>=2)return Promise.reject(new JumpComputeError('已有旗舰计算正在进行，请等待完成或先取消。',429,'JUMP_ALREADY_RUNNING'));
      if((this.sources.get(source)??0)>=this.maxPerSource)return Promise.reject(new JumpComputeError('当前来源的计算请求较多，请稍后重试。',429,'JUMP_RATE_LIMIT'));
      if(!job&&this.jobs.size>=this.size+this.maxQueue)return Promise.reject(busy());
      if(!job){
        job={key,input,id:++this.serial,created:performance.now(),started:null,bindings:new Set(),slot:null,finished:false};
        job.queueTimer=setTimeout(()=>this.fail(job,new JumpComputeError('等待计算超时，请稍后重试。',503,'JUMP_QUEUE_TIMEOUT')),this.queueMs);
        this.jobs.set(key,job);this.queue.push(job);
      }
      binding={alias,source,owner,job,waiters:new Set()};this.bindings.set(alias,binding);job.bindings.add(binding);
      if(!this.owners.has(owner))this.owners.set(owner,new Set());this.owners.get(owner).add(alias);this.sources.set(source,(this.sources.get(source)??0)+1);
    }
    const promise=new Promise((resolve,reject)=>{
      const waiter={resolve,reject,signal,abort:null};
      waiter.abort=()=>{
        if(!binding.waiters.delete(waiter))return;signal?.removeEventListener('abort',waiter.abort);reject(cancelled());
        if(!binding.waiters.size){this.removeBinding(binding);if(!binding.job.bindings.size)this.drop(binding.job);}
      };
      binding.waiters.add(waiter);signal?.addEventListener('abort',waiter.abort,{once:true});
      if(signal?.aborted)waiter.abort();
    });
    this.pump();return promise;
  }
  cancel(owner,requestId){
    const binding=this.bindings.get(JSON.stringify([owner,requestId]));if(!binding)return false;
    for(const w of binding.waiters){w.signal?.removeEventListener('abort',w.abort);w.reject(cancelled());}binding.waiters.clear();this.removeBinding(binding);
    if(!binding.job.bindings.size)this.drop(binding.job);return true;
  }
  removeBinding(binding){
    this.bindings.delete(binding.alias);binding.job.bindings.delete(binding);
    const owned=this.owners.get(binding.owner);owned?.delete(binding.alias);if(!owned?.size)this.owners.delete(binding.owner);
    const count=(this.sources.get(binding.source)??1)-1;if(count)this.sources.set(binding.source,count);else this.sources.delete(binding.source);
  }
  removeJob(job){
    if(job.finished)return false;job.finished=true;this.jobs.delete(job.key);clearTimeout(job.queueTimer);clearTimeout(job.taskTimer);
    const index=this.queue.indexOf(job);if(index>=0)this.queue.splice(index,1);return true;
  }
  finish(job,result,computeMs){
    if(!this.removeJob(job))return;
    for(const binding of [...job.bindings]){
      for(const w of binding.waiters){w.signal?.removeEventListener('abort',w.abort);w.resolve({...result,timing:{queueMs:Math.max(0,(job.started??job.created)-job.created),computeMs}});}this.removeBinding(binding);
    }
    const slot=job.slot;if(slot&&!slot.dead){slot.job=null;slot.state='idle';slot.worker.unref?.();}
    this.pump();
  }
  fail(job,error){
    if(!this.removeJob(job))return;
    for(const binding of [...job.bindings]){for(const w of binding.waiters){w.signal?.removeEventListener('abort',w.abort);w.reject(error);}this.removeBinding(binding);}
    if(job.slot)this.retire(job.slot);this.pump();
  }
  drop(job){if(!this.removeJob(job))return;if(job.slot)this.retire(job.slot);this.pump();}
  retire(slot){
    if(slot.dead)return slot.termination;slot.dead=true;slot.state='terminating';clearTimeout(slot.startupTimer);
    // Keep the slot reserved until termination completes: cancellation storms
    // cannot temporarily spawn more threads than the configured pool size.
    slot.termination=Promise.resolve().then(()=>slot.worker.terminate()).catch(()=>{}).finally(()=>{this.slots.delete(slot);this.pump();});
    return slot.termination;
  }
  start(slot,job){
    clearTimeout(slot.startupTimer);clearTimeout(job.queueTimer);slot.state='busy';slot.job=job;job.slot=slot;job.started=performance.now();slot.worker.ref?.();
    job.taskTimer=setTimeout(()=>this.fail(job,new JumpComputeError('旗舰计算超时，请分段或手动规划。',503,'JUMP_TASK_TIMEOUT')),this.taskMs);
    try{slot.worker.postMessage({id:job.id,input:job.input});}catch{this.fail(job,new JumpComputeError('计算线程暂不可用，请重试。',503,'JUMP_WORKER_FAILED'));}
  }
  pump(){
    if(this.closed)return;
    for(const slot of this.slots)if(!slot.dead&&slot.state==='idle'&&this.queue.length)this.start(slot,this.queue.shift());
    while(this.queue.length&&this.slots.size<this.size){
      const job=this.queue.shift();let worker;
      try{worker=this.createWorker();}catch{this.fail(job,new JumpComputeError('无法启动计算线程，请稍后重试。',503,'JUMP_WORKER_FAILED'));continue;}
      const slot={worker,job,state:'starting',dead:false};this.slots.add(slot);job.slot=slot;
      const failed=()=>{if(slot.dead)return;const current=slot.job;if(current)this.fail(current,new JumpComputeError('计算线程已恢复，请重新计算。',503,'JUMP_WORKER_FAILED'));else this.retire(slot);};
      worker.on('error',failed);worker.on('exit',failed);
      worker.on('message',message=>{
        if(slot.dead)return;
        if(message?.type==='ready'&&slot.state==='starting')this.start(slot,slot.job);
        else if(message?.type==='result'&&slot.state==='busy'&&message.id===slot.job?.id){
          if(!message.result||!Number.isInteger(message.result.status)||message.result.status<200||message.result.status>599||!message.result.body||!Number.isFinite(message.computeMs)||message.computeMs<0){failed();return;}
          this.finish(slot.job,message.result,message.computeMs);
        }
      });
      slot.startupTimer=setTimeout(failed,this.startupMs);
    }
  }
  async close(){
    this.closed=true;for(const job of [...this.jobs.values()])this.fail(job,busy());
    await Promise.all([...this.slots].map(slot=>this.retire(slot)));
  }
}

export class JumpSourceLimiter{
  constructor({burst=12,perSecond=1,maxSources=4096,now=()=>performance.now()}={}){Object.assign(this,{burst,perSecond,maxSources,now});this.rows=new Map();}
  take(source){
    const now=this.now(),old=this.rows.get(source),tokens=old?Math.min(this.burst,old.tokens+(now-old.at)*this.perSecond/1000):this.burst;
    this.rows.delete(source);if(this.rows.size>=this.maxSources)this.rows.delete(this.rows.keys().next().value);
    this.rows.set(source,{at:now,tokens:tokens>=1?tokens-1:tokens});
    if(tokens<1)throw new JumpComputeError('请求过于频繁，请稍后重试。',429,'JUMP_RATE_LIMIT',Math.ceil((1-tokens)/this.perSecond));
  }
}
