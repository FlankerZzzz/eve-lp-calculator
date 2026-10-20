import {DatabaseSync} from 'node:sqlite';
import {resolve} from 'node:path';

// Read-only and short-lived connections: neither schema creation nor ESI fallback in web.
export function readNavigationCache(kind,filename=process.env.V2_SQLITE_PATH||'docker-data/v2/eve-v2.db'){
  const db=new DatabaseSync(resolve(filename),{readOnly:true});
  try{db.exec('PRAGMA busy_timeout=3000;');return db.prepare('SELECT * FROM navigation_cache WHERE kind=?').get(kind)??null;}
  finally{db.close();}
}
// One SELECT gives compute workers a consistent, read-only set of snapshots.
export function readNavigationCaches(kinds,filename=process.env.V2_SQLITE_PATH||'docker-data/v2/eve-v2.db'){
  if(!Array.isArray(kinds)||!kinds.length||kinds.length>8||kinds.some(kind=>typeof kind!=='string'))throw new Error('Invalid navigation cache selection');
  const db=new DatabaseSync(resolve(filename),{readOnly:true});
  try{db.exec('PRAGMA busy_timeout=1000;');return Object.fromEntries(db.prepare(`SELECT * FROM navigation_cache WHERE kind IN (${kinds.map(()=>'?').join(',')})`).all(...kinds).map(row=>[row.kind,row]));}
  finally{db.close();}
}
export function navigationFeedValue(row,now=Date.now()){
  const fetched=Date.parse(row?.fetched??''),modified=Date.parse(row?.modified??'');
  const statistics=['system_jumps','system_kills'].includes(row?.kind);
  const current=Number.isFinite(fetched)&&fetched<=now+60000&&now-fetched<=75*60000;
  // An hourly cache can contain a slightly older official batch. Keep its real window.
  const windowCurrent=!statistics||(Number.isFinite(modified)&&modified<=now+60000&&now-modified<=125*60000);
  const expiry=Number.isFinite(fetched)&&windowCurrent?Math.min(fetched+75*60000,statistics?modified+125*60000:Infinity):NaN;
  return {rows:row?.payload?JSON.parse(row.payload):null,modified:row?.modified??null,fetched:row?.fetched??null,
    fresh_until:Number.isFinite(expiry)?new Date(expiry).toISOString():null,
    stale:!row?.payload||!!row?.error||!current||!windowCurrent,error:row?.error??(row?.payload?null:'尚未同步，请在同步管理运行星系地理缓存')};
}
