// Per-process, single-flight shared caches: never one upstream request per user.
// Endpoint timestamps remain separate. Failure never becomes a fabricated zero.
export function createNavigationFeed({base='',fetcher=fetch,now=Date.now}={}) {
  const origin=(base||'https://ali-esi.evepc.163.com').replace(/\/$/,'');
  const caches=new Map();
  async function load(kind) {
    let slot=caches.get(kind);if(!slot){slot={value:null,until:0,pending:null,error:null};caches.set(kind,slot);}
    if(slot.pending)return slot.pending;
    if(now()<slot.until)return {...slot.value,rows:slot.value?.rows??null,error:slot.error,stale:!!slot.error||!!slot.value?.stale};
    slot.pending=(async()=>{
      try {
        const path=kind==='incursions'?'/incursions/':`/universe/${kind}/`;
        const response=await fetcher(`${origin}/latest${path}?datasource=serenity`,{cache:'no-store',signal:AbortSignal.timeout(10000),headers:{accept:'application/json'}});
        if(!response.ok){const retry=Number(response.headers.get('retry-after'));slot.until=now()+Math.min(300000,Math.max(60000,Number.isFinite(retry)?retry*1000:0));throw new Error(`晨曦接口 HTTP ${response.status}`);}
        const rows=await response.json();
        if(!Array.isArray(rows))throw new Error('晨曦接口数据格式错误');
        for(const row of rows){
          if(kind==='incursions') {if(!Array.isArray(row.infested_solar_systems)||row.infested_solar_systems.some(id=>!Number.isSafeInteger(id)))throw new Error('入侵星系数据格式错误');}
          else {const fields=kind==='system_jumps'?['ship_jumps']:['ship_kills','pod_kills','npc_kills'];if(!Number.isSafeInteger(row.system_id)||fields.some(key=>!Number.isSafeInteger(row[key])||row[key]<0))throw new Error('活动统计数据格式错误');}
        }
        const modified=response.headers.get('last-modified'),modifiedMs=Date.parse(modified||'');
        if(!Number.isFinite(modifiedMs))throw new Error('晨曦接口缺少有效更新时间');
        const expiry=Date.parse(response.headers.get('expires')||''),maximum=kind==='incursions'?300000:3600000;
        // Recheck expired upstream batches at most once per minute.
        slot.until=now()+Math.max(60000,Math.min(maximum,Number.isFinite(expiry)?expiry-now():maximum));
        slot.value={rows,modified:new Date(modifiedMs).toISOString(),fetched:new Date(now()).toISOString(),stale:now()-modifiedMs>maximum+60000};slot.error=null;
        return slot.value;
      } catch(error) {
        slot.error=error instanceof Error?error.message:'统计查询失败';slot.until=Math.max(slot.until,now()+60000);
        return {...slot.value,rows:slot.value?.rows??null,error:slot.error,stale:true};
      } finally {slot.pending=null;}
    })();return slot.pending;
  }
  return {load};
}

export function activityForSystems(jumps,kills,ids) {
  const j=new Map((jumps.rows||[]).map(row=>[row.system_id,row])),k=new Map((kills.rows||[]).map(row=>[row.system_id,row]));
  return Object.fromEntries(ids.map(id=>[id,{
    jumps:jumps.rows?(j.get(id)?.ship_jumps??0):null,
    ships:kills.rows?(k.get(id)?.ship_kills??0):null,
    pods:kills.rows?(k.get(id)?.pod_kills??0):null,
    npcs:kills.rows?(k.get(id)?.npc_kills??0):null,
  }]));
}
