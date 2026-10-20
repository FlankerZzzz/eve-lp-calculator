export function normalizeSystemQuery(value){return String(value??'').normalize('NFKC').toLowerCase().replace(/[üǖǘǚǜ]/g,'v').normalize('NFD').replace(/\p{M}/gu,'').replace(/[\s'’·_-]+/g,'');}
export function systemSearchKeys(s){return [...new Set([s.nameZh,s.nameEn,String(s.id),s.searchPinyin,s.searchInitials].filter(Boolean).map(normalizeSystemQuery))];}
const cache=new WeakMap();
export function createSystemSearch(systems){
  if(cache.has(systems))return cache.get(systems);
  const index=systems.map(system=>({system,keys:systemSearchKeys(system),direct:[system.nameZh,system.nameEn,String(system.id)].map(normalizeSystemQuery)}));
  const search={exact(value){const query=normalizeSystemQuery(value);if(!query)return null;const direct=index.filter(row=>row.direct.includes(query)),matches=direct.length?direct:index.filter(row=>row.keys.includes(query));return matches.length===1?matches[0].system:null;},
    find(value,limit=7){const query=normalizeSystemQuery(value);if(!query)return [];
      return index.map((row,order)=>({system:row.system,order,rank:row.direct.includes(query)?0:row.keys.includes(query)?1:row.keys.some(k=>k.startsWith(query))?2:row.keys.some(k=>k.includes(query))?3:4})).filter(row=>row.rank<4).sort((a,b)=>a.rank-b.rank||a.order-b.order).slice(0,limit).map(row=>row.system);
    }};
  cache.set(systems,search);return search;
}
