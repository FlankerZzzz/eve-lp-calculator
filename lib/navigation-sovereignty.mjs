const indexes=new WeakMap();
export const SOVEREIGNTY_ICON_FALLBACK=`data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 64 64"><path d="M32 5 55 14v18c0 13-12 22-23 27C21 54 9 45 9 32V14z" fill="#14313b" stroke="#7eafb9" stroke-width="2"/><path d="m21 32 7 7 15-16" fill="none" stroke="#badde0" stroke-width="3"/></svg>')}`;
// Keep the visible card label compact; source and quality remain in its tooltip.
export function sovereigntySummary(owner){
  const name=owner.name||owner.label.replace(/^主权：/,'');
  return {text:`主权：${name}`,title:`来源：晨曦主权接口；不等同于阵营战争占领状态。${owner.stale?'主权资料待更新，仅供参考。':''}${owner.namesStale?'名称缓存待更新。':''}`};
}
export function sovereigntyForSystem(id,environment){
  const feed=environment?.sovereignty;
  if(!Array.isArray(feed?.rows))return {kind:'unknown',label:'主权：待核实',name:null,icon:null,stale:true};
  let index=indexes.get(feed);
  if(!index){index={systems:new Map(feed.rows.map(r=>[r.system_id,r])),names:new Map((feed.names??[]).map(r=>[r.id,r]))};indexes.set(feed,index);}
  const row=index.systems.get(id),stale=!!feed.error||!!feed.stale;
  if(!row)return {kind:'unknown',label:'主权：未提供归属',name:null,icon:null,stale};
  const owner=row.faction_id?{kind:'faction',id:row.faction_id,title:'NPC势力'}:row.alliance_id?{kind:'alliance',id:row.alliance_id,title:'玩家联盟'}:row.corporation_id?{kind:'corporation',id:row.corporation_id,title:'玩家军团'}:null;
  if(!owner)return {kind:'unclaimed',label:'未宣称主权',name:null,icon:null,stale};
  if(!Number.isSafeInteger(owner.id)||owner.id<=0)return {kind:'unknown',label:'主权：待核实',name:null,icon:null,stale:true};
  const entity=index.names.get(owner.id),name=entity?.category===owner.kind?entity.name:null;
  return {kind:owner.kind,label:owner.title,name:name||'名称待补齐',icon:`/api/data/entity-icon?kind=${owner.kind==='corporation'?'player-corporation':owner.kind}&id=${owner.id}&size=64`,stale,namesStale:!!feed.namesError};
}
