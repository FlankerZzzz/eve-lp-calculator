import {readNavigationCaches,navigationFeedValue} from './navigation-store.mjs';
import {validateJumpCatalog} from './jump-catalog.mjs';
import {navigationGraph} from './navigation.mjs';
import {avoidPolicy} from './navigation-avoid.mjs';
import {calculateJumpRequest} from './jump-auto-request.mjs';

const kinds=['map','jump','incursions'];
const revision=rows=>JSON.stringify(kinds.map(kind=>{const r=rows[kind];return [r?.version,r?.modified,r?.fetched,r?.error];}));
export function createJumpComputation({read=()=>readNavigationCaches(kinds)}={}){
  let cached=null;
  return input=>{
    let rows;
    try{
      rows=read();
      if(!rows.map?.payload||!rows.map.version||!rows.jump?.payload||!rows.jump.version)throw new Error('missing');
      const version=JSON.stringify([rows.map.version,rows.jump.version]);
      if(cached?.version!==version){
        const map=JSON.parse(rows.map.payload),extra=JSON.parse(rows.jump.payload);
        if(map.schema!==1)throw new Error('schema');
        const catalog=validateJumpCatalog({...extra,systems:map.systems,gates:map.gates,source:map.source,serenityVerified:map.serenityVerified});
        cached={version,catalog,graph:navigationGraph(catalog)};
      }
    }catch(error){
      const detail=error instanceof Error&&error.message.startsWith('跳跃基础资料校验失败：')?error.message:'跳跃基础资料不可用，请重新加载后计算。';
      return {status:503,body:{error:detail,code:'JUMP_DATA_UNAVAILABLE'}};
    }
    let feed;
    try{feed=navigationFeedValue(rows.incursions);}catch{feed={rows:null,modified:null,stale:true,error:'地理缓存不可用，请检查同步任务'};}
    const result=calculateJumpRequest({...cached,feed},input);
    // No completed-result cache. Re-read after work so an expired feed or a
    // changed map/station/invasion snapshot cannot be published as current.
    if(result.status===200){
      try{if(revision(read())!==revision(rows))return {status:503,body:{error:'导航资料已更新，请重新计算。',code:'JUMP_SNAPSHOT_CHANGED'}};}
      catch{return {status:503,body:{error:'导航资料暂不可用，请稍后重试。',code:'JUMP_DATA_UNAVAILABLE'}};}
      const error=avoidPolicy(input.avoid,result.body.incursions).error;
      if(error)return {status:400,body:{error}};
    }
    return result;
  };
}
