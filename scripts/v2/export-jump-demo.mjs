// Read-only inputs; write a standalone map supplement, never the business DB.
import {readFile,mkdir,writeFile,rename} from 'node:fs/promises';
import {resolve,dirname} from 'node:path';
import {readSdeMember} from './sde.mjs';
import {validateJumpSupplement} from '../../lib/jump-catalog.mjs';
const archive=resolve(process.argv[2]||'docker-data/v2/sde.zip');
if(!process.argv[3])throw new Error('Usage: export-jump-demo.mjs [sde.zip] audited-jump-ships.json [output.json]');
const audit=JSON.parse(await readFile(resolve(process.argv[3]),'utf8'));
if(!audit.complete||audit.datasource!=='serenity'||!audit.ships?.length)throw new Error('Requires a complete Serenity ship audit');
const stations={};
await readSdeMember(archive,'npcStations.jsonl',row=>{
  if(!Number.isSafeInteger(row._key)||!Number.isSafeInteger(row.solarSystemID))throw new Error('Invalid station reference');
  (stations[row.solarSystemID]??=[]).push({id:row._key,typeId:row.typeID,ownerId:row.ownerID});
});
const ships=audit.ships.map(s=>{
  const attrs=audit.raw_ships?.[s.type_id]?.dogma_attributes;
  if(!Array.isArray(attrs))throw new Error(`Missing raw ship attributes: ${s.type_id}`);
  const bonus=attrs.find(a=>a.attribute_id===1312);
  return {id:s.type_id,name:s.name_zh,group:s.group_name_zh,groupId:s.group_id,
  baseRange:s.base_range_ly,fuelId:s.fuel_type_id,fuelName:s.fuel_name_zh,baseFuel:s.base_fuel_units_per_ly,
  shipFuelBonus:bonus?bonus.value:0};
});
const body=validateJumpSupplement({schema:1,generatedAt:new Date().toISOString(),shipsVerifiedAt:audit.generated_at,stationSource:'CCP 标准 SDE · 未全量核验晨曦',stations,ships});
const output=resolve(process.argv[4]||'docker-data/v2/jump-demo.json');await mkdir(dirname(output),{recursive:true});
await writeFile(output+'.tmp',JSON.stringify(body));await rename(output+'.tmp',output);
console.log(JSON.stringify({ships:ships.length,stationSystems:Object.keys(stations).length,stations:Object.values(stations).flat().length}));
