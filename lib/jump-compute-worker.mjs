import {parentPort,workerData} from 'node:worker_threads';
import {readNavigationCaches} from './navigation-store.mjs';
import {createJumpComputation} from './jump-compute-snapshot.mjs';
const calculate=createJumpComputation({read:()=>readNavigationCaches(['map','jump','incursions'],workerData.filename)});
parentPort.on('message',({id,input})=>{
  const started=performance.now();
  try{parentPort.postMessage({type:'result',id,result:calculate(input),computeMs:performance.now()-started});}
  catch{parentPort.postMessage({type:'result',id,result:{status:503,body:{error:'计算暂不可用，请稍后重试。',code:'JUMP_WORKER_FAILED'}},computeMs:performance.now()-started});}
});
parentPort.postMessage({type:'ready'});
