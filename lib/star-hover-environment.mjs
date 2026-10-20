const clock=new Intl.DateTimeFormat('zh-CN',{timeZone:'Asia/Shanghai',hour:'2-digit',minute:'2-digit',hour12:false});
const day=new Intl.DateTimeFormat('zh-CN',{timeZone:'Asia/Shanghai',month:'2-digit',day:'2-digit'});
export const RECENT_GEOGRAPHY_TITLE='最近一小时的地理数据';
export function npcStationLabel(system){return Number.isSafeInteger(system?.npcStationCount)&&system.npcStationCount>=0?`${system.npcStationCount.toLocaleString('zh-CN')} 个`:'未核实';}
export function feedWindowLabel(meta){
  const end=Date.parse(meta?.modified??'');if(!Number.isFinite(end))return '时间未知';
  const start=end-3600000,a=day.format(start),b=day.format(end);
  return `${a} ${clock.format(start)}–${a===b?'':b+' '}${clock.format(end)}`;
}
export function feedIsCurrent(meta,maximum,now=Date.now()){
  if(meta?.fresh_until){const expiry=Date.parse(meta.fresh_until);return !meta.error&&!meta.stale&&Number.isFinite(expiry)&&now<=expiry;}
  const time=Date.parse(meta?.modified??'');return !!meta&&!meta.error&&!meta.stale&&Number.isFinite(time)&&time<=now+60000&&now-time<=maximum+60000;
}
export function starHoverEnvironment(id,environment,now=Date.now()){
  const inc=environment?.incursions,known=feedIsCurrent(inc,300000,now)&&Array.isArray(inc.ids),invasion=known?inc.ids.includes(id):null;
  const activity=environment?.systems?.[id];
  const metrics=[['jumps','过门次数','jumps'],['ships','舰船击毁数','kills'],['pods','太空舱击毁数','kills'],['npcs','NPC击毁数量','kills']].map(([key,label,feed])=>{
    const raw=activity?.[key],meta=environment?.[feed],valid=Number.isSafeInteger(raw)&&raw>=0;
    return {key,label,value:valid?raw.toLocaleString('zh-CN'):'—',stale:valid&&!feedIsCurrent(meta,3600000,now)};
  });
  return {invasion,status:invasion===null?'入侵：待核实':invasion?'入侵：是':'入侵：未在名单',metrics,
    jumpsWindow:feedWindowLabel(environment?.jumps),killsWindow:feedWindowLabel(environment?.kills),
    statisticsStale:metrics.some(m=>m.stale),statisticsUnavailable:metrics.every(m=>m.value==='—')};
}
