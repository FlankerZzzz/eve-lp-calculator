import {readNavigationCache,navigationFeedValue} from './navigation-store.mjs';
export const navigationFeed={async load(kind:string){
  try{return navigationFeedValue(readNavigationCache(kind));}
  catch{return {rows:null,modified:null,fetched:null,fresh_until:null,stale:true,error:'地理缓存不可用，请检查同步任务'};}
}};
