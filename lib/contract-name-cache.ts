type NamedId = { id: number; name: string };
type Lookup = { inventory_types?: NamedId[] };

// Process-local, bounded cache. Restarting clears it; network errors are never cached.
export function createContractNameCache(load: (names: string[]) => Promise<Lookup>, now = Date.now) {
  const cache=new Map<string,{expires:number;data:Lookup}>(),pending=new Map<string,Promise<Lookup>>();
  return async (names: string[]): Promise<Lookup> => {
    const unique=[...new Set(names)].sort(),key=JSON.stringify(unique),entry=cache.get(key);
    if(entry && entry.expires>now())return entry.data;
    cache.delete(key);
    const existing=pending.get(key);if(existing)return existing;
    const request=(async()=>{
      const data=await load(unique);
      if(!data || typeof data!=='object' || Array.isArray(data) || (data.inventory_types!==undefined && (!Array.isArray(data.inventory_types) || data.inventory_types.some(row=>!row || !Number.isSafeInteger(row.id) || row.id<=0 || typeof row.name!=='string'))))throw new Error('Invalid ESI name response');
      for(const [k,v] of cache)if(v.expires<=now())cache.delete(k);
      if(cache.size>=128)cache.delete(cache.keys().next().value!);
      cache.set(key,{expires:now()+10*60*1000,data});return data;
    })();
    pending.set(key,request);
    try{return await request;}finally{pending.delete(key);}
  };
}
