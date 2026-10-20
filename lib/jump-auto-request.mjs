import {parseAvoid,avoidPolicy} from './navigation-avoid.mjs';
import {automaticJumpPlan,AutomaticJumpUnreachableError} from './jump-auto-planner.mjs';

export function normalizeJumpRequest(body){
  const id=value=>Number.isSafeInteger(value)&&value>0;
  if(!body||typeof body!=='object'||Array.isArray(body)||!id(body.origin)||!id(body.destination)||!id(body.shipId)||!Array.isArray(body.waypoints)||body.waypoints.length>10||body.waypoints.some(value=>!id(value))||!body.skills||[body.skills.calibration,body.skills.conservation,body.skills.shipSkill].some(n=>!Number.isInteger(n)||n<0||n>5))throw new Error('自动计算参数无效，请检查舰船、技能和点位。');
  if(body.npcStationsOnly!==undefined&&typeof body.npcStationsOnly!=='boolean')throw new Error('NPC 站落点开关格式错误');
  const avoid=parseAvoid(body.avoid);
  // Only authoritative request fields enter the queue/key, never client-supplied
  // range, stations, ship data, data versions, priority or worker configuration.
  return {origin:body.origin,destination:body.destination,waypoints:[...body.waypoints],shipId:body.shipId,skills:{calibration:body.skills.calibration,conservation:body.skills.conservation,shipSkill:body.skills.shipSkill},npcStationsOnly:body.npcStationsOnly??false,avoid:{...avoid,avoid:[...avoid.avoid].sort((a,b)=>a-b)}};
}

export function calculateJumpRequest({catalog,graph,feed},input){
  let incursions;
  try{
    const ship=catalog.ships.find(row=>row.id===input.shipId);
    if(!ship)throw new Error('请选择有效舰船');
    const valid=Array.isArray(feed.rows)&&feed.rows.every(row=>Array.isArray(row?.infested_solar_systems)&&row.infested_solar_systems.every(id=>Number.isSafeInteger(id)&&id>0));
    incursions={...feed,ids:valid?feed.rows.flatMap(row=>row.infested_solar_systems):null,stale:feed.stale||!valid};
    const policy=avoidPolicy(input.avoid,incursions);
    if(policy.error)throw new Error(policy.error);
    const legs=automaticJumpPlan(graph,{origin:input.origin,destination:input.destination,waypoints:input.waypoints,ship,skills:input.skills,incursions,avoidIncursions:input.avoid.avoidIncursions,npcStationsOnly:input.npcStationsOnly,stations:catalog.stations,blocked:policy.blocked});
    return {status:200,body:{legs,incursions,complete:true}};
  }catch(error){
    if(error instanceof AutomaticJumpUnreachableError)return {status:200,body:{legs:error.legs,incursions,complete:false,interruptionAt:error.interruptionAt,message:error.message}};
    return {status:400,body:{error:error instanceof Error?error.message:'无法自动计算，请检查点位与规避设置。'}};
  }
}
