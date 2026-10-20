"use client";
import {useEffect,useState} from 'react';
import type {Activity,FeedMeta} from './navigation-types';
export type MapEnvironment={systems:Record<number,Activity>;jumps:FeedMeta;kills:FeedMeta;incursions:FeedMeta&{ids:number[]|null};sovereignty?:(FeedMeta&{rows:{system_id:number;faction_id?:number;alliance_id?:number;corporation_id?:number}[]|null;names?:{id:number;name:string;category:string}[];namesError?:string|null})};
export function useMapEnvironment(enabled=true){
  const [value,setValue]=useState<MapEnvironment|null>(null);
  useEffect(()=>{
    if(!enabled)return;
    const abort=new AbortController();let busy=false;
    async function refresh(){
      if(busy||document.hidden)return;busy=true;
      try{const r=await fetch('/api/navigation/environment',{signal:abort.signal,cache:'no-store'}),body=await r.json();if(!r.ok)throw new Error('环境资料获取失败');if(!body.systems||!body.jumps||!body.kills||!body.incursions)throw new Error('环境资料格式错误');if(!abort.signal.aborted)setValue(body);}
      catch{if(!abort.signal.aborted)setValue(previous=>{const failed={modified:null,fetched:null,stale:true,error:'环境资料获取失败'};return previous?{...previous,jumps:{...previous.jumps,stale:true,error:failed.error},kills:{...previous.kills,stale:true,error:failed.error},incursions:{...previous.incursions,stale:true,error:failed.error},...(previous.sovereignty?{sovereignty:{...previous.sovereignty,stale:true,error:failed.error}}:{})}:{systems:{},jumps:failed,kills:failed,incursions:{...failed,ids:null}};});}
      finally{busy=false;}
    }
    void refresh();const timer=window.setInterval(()=>void refresh(),300000),visible=()=>{if(!document.hidden)void refresh();};document.addEventListener('visibilitychange',visible);
    return()=>{abort.abort();window.clearInterval(timer);document.removeEventListener('visibilitychange',visible);};
  },[enabled]);
  return value;
}
