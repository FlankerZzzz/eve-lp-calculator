import {normalizeJumpRequest} from '../../../../../lib/jump-auto-request.mjs';
import {jumpComputeService,readJumpRequestBody} from '../../../../../lib/jump-compute-service.mjs';
import {isJumpComputeError} from '../../../../../lib/jump-compute-pool.mjs';

const headers={'cache-control':'no-store'};
function failure(error:unknown){
  if(isJumpComputeError(error))return Response.json({error:error.message,code:error.code},{status:error.status,headers:{...headers,...(error.retryAfter?{'retry-after':String(error.retryAfter)}:{})}});
  return Response.json({error:'计算服务暂不可用，请稍后重试。',code:'JUMP_WORKER_FAILED'},{status:503,headers});
}
export async function POST(request:Request){
  try{
    const identity=jumpComputeService.admit(request),body=await readJumpRequestBody(request);
    let input;
    try{input=normalizeJumpRequest(body);}catch(error){return Response.json({error:error instanceof Error?error.message:'自动计算参数无效。'},{status:400,headers});}
    const result=await jumpComputeService.calculate(input,{...identity,signal:request.signal});
    return Response.json(result.body,{status:result.status,headers:{...headers,...(result.status===503?{'retry-after':'2'}:{}),...(result.timing?{'server-timing':`jump_queue;dur=${result.timing.queueMs.toFixed(1)}, jump_compute;dur=${result.timing.computeMs.toFixed(1)}`}:{})}});
  }catch(error){return failure(error);}
}
export async function DELETE(request:Request){
  try{const identity=jumpComputeService.admit(request,{cancel:true});jumpComputeService.cancel(identity);return Response.json({cancelled:true},{headers});}
  catch(error){return failure(error);}
}
