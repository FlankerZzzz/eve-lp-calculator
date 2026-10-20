"use client";
import {useCallback,useMemo,useState} from 'react';
import {measureSystemDistance,oneJumpReach,sortJumpReach,formatJumpReachList} from '../../../lib/jump-tools.mjs';
import type {JumpReachOverlay,DistanceMapOverlay,StarSystem} from '../star-map';

export type JumpToolContext={
  graph:{systems:Map<number,StarSystem>;adjacent:Map<number,number[]>}|null;
  ship:{id:number;groupId:number;baseRange:number;baseFuel:number;shipFuelBonus?:number}|null;
  skills:{calibration:number;conservation:number;shipSkill:number};
  blocked:Set<number>;incursions?:unknown;avoidIncursions:boolean;
  npcStationsOnly:boolean;stations?:Record<number,{id:number;typeId:number}[]>;now:number;
};
type ReachRow={id:number;distance:number;fuel:number};
type ReachResult={origin:number;range:number;fuelPerLy:number;rows:ReachRow[]};
type Measurement={from:number;to:number;distance:number};

// Headless by design: entry buttons and panel placement are a separate decision.
// Inputs are system IDs resolved by the existing SystemPicker. No plan setters,
// requests or storage writes: queries cannot append/erase route legs or change A/B.
export function useJumpTools(context:JumpToolContext){
  const [distanceInput,setDistanceInput]=useState<{from:number;to:number;request:number}|null>(null);
  const [reachInput,setReachInput]=useState<{origin:number;request:number}|null>(null);
  const [active,setActive]=useState<'reach'|'distance'|null>(null);
  const [direction,setDirection]=useState<'asc'|'desc'>('asc');
  const {graph,ship,skills,blocked,incursions,avoidIncursions,npcStationsOnly,stations,now}=context;
  const distance=useMemo<{result:Measurement|null;error:string}>(()=>{
    if(!distanceInput)return {result:null,error:''};
    try{return {result:measureSystemDistance(graph,distanceInput.from,distanceInput.to),error:''};}
    catch(error){return {result:null,error:error instanceof Error?error.message:'无法计算星系距离'};}
  },[graph,distanceInput]);
  const reach=useMemo<{result:ReachResult|null;error:string}>(()=>{
    if(!reachInput)return {result:null,error:''};
    try{return {result:oneJumpReach(graph,reachInput.origin,ship,skills,{blocked,incursions,avoidIncursions,npcStationsOnly,stations,now}),error:''};}
    catch(error){return {result:null,error:error instanceof Error?error.message:'无法计算一跳可达星系'};}
  },[graph,ship,skills,blocked,incursions,avoidIncursions,npcStationsOnly,stations,now,reachInput]);
  const rows=useMemo<ReachRow[]>(()=>sortJumpReach(reach.result?.rows??[],direction),[reach.result,direction]);
  const reachText=useMemo(()=>graph?formatJumpReachList(graph,rows,direction):'',[graph,rows,direction]);
  // Star selection is camera/inspector state only; it never cancels a calculation.
  // Sorting never changes camera identity. Re-querying the same system does.
  const reachOverlay=useMemo<JumpReachOverlay|null>(()=>active==='reach'&&reach.result&&reachInput?{
    origin:reach.result.origin,range:reach.result.range,
    candidates:reach.result.rows.map(row=>row.id),request:reachInput.request
  }:null,[active,reach.result,reachInput]);
  const distanceOverlay=useMemo<DistanceMapOverlay|null>(()=>active==='distance'&&distance.result&&distanceInput?{
    ...distance.result,request:distanceInput.request
  }:null,[active,distance.result,distanceInput]);
  const measure=useCallback((from:number,to:number)=>{setDistanceInput(previous=>({from,to,request:(previous?.request??0)+1}));setActive('distance');},[]);
  const showReach=useCallback((origin:number)=>{setReachInput(previous=>({origin,request:(previous?.request??0)+1}));setActive('reach');},[]);
  const cancelEffects=useCallback(()=>setActive(null),[]);
  const clearCalculations=useCallback(()=>{setActive(null);setDistanceInput(null);setReachInput(null);setDirection('asc');},[]);
  const closeDistance=useCallback(()=>{setDistanceInput(null);setActive(value=>value==='distance'?null:value);},[]);
  const closeReach=useCallback(()=>{setReachInput(null);setActive(value=>value==='reach'?null:value);},[]);
  return {measure,distance:distance.result,distanceError:distance.error,closeDistance,distanceOverlay,active,cancelEffects,clearCalculations,
    showReach,reach:reach.result,reachError:reach.error,rows,reachText,direction,setDirection,reachOverlay,closeReach};
}
