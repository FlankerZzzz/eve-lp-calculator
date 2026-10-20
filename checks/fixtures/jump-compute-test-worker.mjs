import {parentPort,threadId} from 'node:worker_threads';
parentPort.on('message',({id,input})=>{
  if(input.crash){process.exit(1);return;}
  parentPort.postMessage({type:'started',id});const started=performance.now();
  while(performance.now()-started<(input.spinMs??0)){/* CPU isolation fixture */}
  parentPort.postMessage({type:'result',id,result:{status:200,body:{threadId,value:input.value}},computeMs:performance.now()-started});
});
parentPort.postMessage({type:'ready'});
