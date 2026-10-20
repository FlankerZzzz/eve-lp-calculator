"use client";
import {useEffect,useRef,useState} from 'react';
import type {LocalAvoid} from './navigation-types';
import {AVOID_STORAGE,DEFAULT_AVOID,parseAvoid,toggleAvoid} from '../../lib/navigation-avoid.mjs';
import {DEFAULT_NAVIGATION_PREFERENCES,readNavigationPreferences,navigationPreferenceCookie} from '../../lib/navigation-preferences.mjs';
import type {Mode} from './navigation-types';
export type NavigationPreferences={gateMode:Mode;history:boolean;gateLines:boolean;npcStationsOnly:boolean;modes:Mode[]};
export function useNavigationAvoid(mode:'regular'|'jump'){
  const [avoid,setState]=useState<LocalAvoid>({...DEFAULT_AVOID,avoidIncursions:DEFAULT_NAVIGATION_PREFERENCES.avoidIncursions}),[ready,setReady]=useState(false),[storageError,setStorageError]=useState('');
  const [preferences,setPreferenceState]=useState<NavigationPreferences>({...DEFAULT_NAVIGATION_PREFERENCES,gateMode:'secure',modes:['secure']});
  const writable=useRef(true),cookieWritable=useRef(true);
  useEffect(()=>{
    let restored:LocalAvoid={...DEFAULT_AVOID,avoidIncursions:DEFAULT_NAVIGATION_PREFERENCES.avoidIncursions};
    const legacyFlags:Partial<LocalAvoid>={};
    try{
      const raw=localStorage.getItem(AVOID_STORAGE[mode]),legacy=!raw&&mode==='regular'?localStorage.getItem('eve-navigation-avoid-v1'):null;
      if(raw||legacy){const value=JSON.parse(raw||legacy!);restored=parseAvoid(value,!!legacy);for(const key of ['avoidList','avoidIncursions'] as const)if(typeof value[key]==='boolean')legacyFlags[key]=value[key];}
    }catch{writable.current=false;setStorageError('本地名单无法读取，原内容未覆盖。修改名单后将保存新配置。');}
    try{
      const saved=readNavigationPreferences(document.cookie,mode)??{...DEFAULT_NAVIGATION_PREFERENCES,...legacyFlags};
      setPreferenceState(saved as NavigationPreferences);restored={...restored,avoidList:saved.avoidList,avoidIncursions:saved.avoidIncursions};
    }catch{cookieWritable.current=false;setStorageError('导航偏好 Cookie 无法读取，原内容未覆盖。修改设置后可重新保存。');}
    setState(restored);setReady(true);
  },[mode]);
  useEffect(()=>{if(!ready||!writable.current)return;try{localStorage.setItem(AVOID_STORAGE[mode],JSON.stringify(avoid));}catch{setStorageError('浏览器禁止本地存储，屏蔽名单仅在本次页面中有效。');}},[avoid,ready,mode]);
  useEffect(()=>{
    if(!ready||!cookieWritable.current)return;
    try{
      const saved={...preferences,avoidList:avoid.avoidList,avoidIncursions:avoid.avoidIncursions};
      document.cookie=navigationPreferenceCookie(mode,saved,location.protocol==='https:');
      if(JSON.stringify(readNavigationPreferences(document.cookie,mode))!==JSON.stringify(saved))throw new Error('Cookie 未写入');
    }catch{setStorageError('浏览器禁止保存 Cookie，导航偏好仅在本次页面中有效。');}
  },[preferences,avoid.avoidList,avoid.avoidIncursions,ready,mode]);
  function setPreferences(update:Partial<NavigationPreferences>){cookieWritable.current=true;setPreferenceState(value=>({...value,...update}));}
  function setAvoid(update:LocalAvoid|((value:LocalAvoid)=>LocalAvoid)){writable.current=true;cookieWritable.current=true;setState(update);}
  function toggle(id:number){if(!avoid.avoid.includes(id)&&avoid.avoid.length>=500){setStorageError('屏蔽名单最多 500 个星系');return;}setAvoid(value=>value.avoid.includes(id)||value.avoid.length<500?toggleAvoid(value,id):value);}
  return {avoid,setAvoid,toggle,ready,storageError,preferences,setPreferences};
}
