import {feedIsCurrent} from './star-hover-environment.mjs';
export const AVOID_STORAGE={regular:'eve-navigation-avoid-v2',jump:'eve-jump-navigation-avoid-v1'};
export const DEFAULT_AVOID={avoid:[],avoidList:true,avoidIncursions:false};
export function parseAvoid(value,legacy=false){
  if(!value||typeof value!=='object'||!Array.isArray(value.avoid)||value.avoid.length>500||value.avoid.some(id=>!Number.isSafeInteger(id)||id<=0))throw new Error('屏蔽名单格式无效');
  for(const key of ['avoidList','avoidIncursions'])if(value[key]!==undefined&&typeof value[key]!=='boolean')throw new Error('规避开关格式无效');
  return {avoid:[...new Set(value.avoid)],avoidList:legacy?true:value.avoidList??true,avoidIncursions:value.avoidIncursions??false};
}
export function toggleAvoid(config,id){
  if(!Number.isSafeInteger(id)||id<=0)throw new Error('星系 ID 无效');
  if(config.avoid.includes(id))return {...config,avoid:config.avoid.filter(n=>n!==id)};
  if(config.avoid.length>=500)throw new Error('屏蔽名单最多 500 个星系');
  return {...config,avoid:[...config.avoid,id]};
}
export function avoidPolicy(config,incursions,now=Date.now()){
  const blocked=new Set(config.avoidList?config.avoid:[]);
  const error=config.avoidIncursions&&(!Array.isArray(incursions?.ids)||!feedIsCurrent(incursions,75*60000,now))?'入侵名单不可用或已过期，请刷新或关闭入侵规避。':'';
  if(config.avoidIncursions&&!error)for(const id of incursions.ids)blocked.add(id);
  return {blocked,error};
}
