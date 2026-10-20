import {readSdeMember} from './sde.mjs';
import {buildStarMap} from '../../lib/star-map.mjs';
import {mkdir,writeFile,rename} from 'node:fs/promises';
import {resolve,dirname} from 'node:path';
const archive=resolve(process.argv[2]||'docker-data/v2/sde.zip');
const output=resolve(process.argv[3]||'docker-data/v2/star-map.json');
const rows={};
for(const member of ['mapSolarSystems.jsonl','mapRegions.jsonl','mapConstellations.jsonl','mapStargates.jsonl','npcStations.jsonl','_sde.jsonl']) {
  rows[member]=[];
  await readSdeMember(archive,member,row=>rows[member].push(row));
}
const map=buildStarMap(rows['mapSolarSystems.jsonl'],rows['mapRegions.jsonl'],rows['mapStargates.jsonl'],rows['_sde.jsonl'],rows['mapConstellations.jsonl'],rows['npcStations.jsonl']);
await mkdir(dirname(output),{recursive:true});
const temp=`${output}.${process.pid}.tmp`;
await writeFile(temp,JSON.stringify(map));
await rename(temp,output);
console.log(JSON.stringify({systems:map.systems.length,connections:map.gates.length,bytes:Buffer.byteLength(JSON.stringify(map))}));
