// Keep authoritative coordinates in metres; only the render layer uses lightyears.
export const METRES_PER_LIGHTYEAR = 9_460_000_000_000_000;
export function distanceLightyears(a, b) {
  return Math.hypot(a.x-b.x,a.y-b.y,a.z-b.z)/METRES_PER_LIGHTYEAR;
}
export function renderPosition(system) {
  // EVE universe coordinates are left-handed; invert Z for Three.js.
  return [system.x/METRES_PER_LIGHTYEAR,system.y/METRES_PER_LIGHTYEAR,-system.z/METRES_PER_LIGHTYEAR];
}
export function securityBand(security) {
  // EVE's displayed 0.5 boundary starts at raw 0.45.
  return security >= 0.45 ? 'high' : security > 0 ? 'low' : 'null';
}
export function buildStarMap(systemRows, regionRows, gateRows, metadata, constellationRows=[],stationRows=null) {
  const regions=new Map(regionRows.map(r=>[r._key,r]));
  const constellations=new Map(constellationRows.map(r=>[r._key,r]));
  const stationCounts=new Map(),stationIds=new Set();
  for(const row of stationRows??[]){
    if(!Number.isSafeInteger(row._key)||row._key<=0||!Number.isSafeInteger(row.solarSystemID)||stationIds.has(row._key))throw new Error('Invalid or duplicate NPC station');
    stationIds.add(row._key);stationCounts.set(row.solarSystemID,(stationCounts.get(row.solarSystemID)??0)+1);
  }
  const systems=[],ids=new Set();
  for(const row of systemRows) {
    if(row._key<30_000_000||row._key>30_999_999)continue;
    if(!Number.isSafeInteger(row._key)||ids.has(row._key))throw new Error('Invalid or duplicate map system ID');
    if(!row.position||!['x','y','z'].every(axis=>Number.isFinite(row.position[axis]))||!Number.isFinite(row.securityStatus))throw new Error(`Invalid coordinates/security: ${row._key}`);
    const region=regions.get(row.regionID);
    if(!region||!row.name?.en)throw new Error(`Missing map name/region: ${row._key}`);
    const constellation=constellations.get(row.constellationID);
    if(constellationRows.length&&(!constellation?.name?.en||constellation.regionID!==row.regionID))throw new Error(`Missing or inconsistent map constellation: ${row._key}`);
    ids.add(row._key);
    systems.push({id:row._key,nameZh:row.name.zh||row.name.en,nameEn:row.name.en,regionId:row.regionID,regionName:region.name?.zh||region.name?.en||String(row.regionID),...(constellation?{constellationId:constellation._key,constellationName:constellation.name.zh||constellation.name.en}:{}),...(stationRows!==null?{npcStationCount:stationCounts.get(row._key)??0}:{}),security:row.securityStatus,...row.position});
  }
  systems.sort((a,b)=>a.id-b.id);
  const pairs=new Map();
  for(const gate of gateRows) {
    const a=gate.solarSystemID,b=gate.destination?.solarSystemID;
    if(!ids.has(a)||!ids.has(b)||a===b)continue;
    const pair=[Math.min(a,b),Math.max(a,b)];pairs.set(pair.join(':'),pair);
  }
  if(!systems.length)throw new Error('SDE contains no known-space systems');
  return {schema:1,source:'CCP 标准 SDE',scope:'新伊甸常规星系（不含虫洞与深渊）',serenityVerified:false,metadata,systems,gates:[...pairs.values()]};
}
