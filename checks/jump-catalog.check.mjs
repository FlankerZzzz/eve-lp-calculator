import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {spawnSync} from 'node:child_process';
import {validateJumpSupplement,validateJumpCatalog} from '../lib/jump-catalog.mjs';
const fixture=()=>({schema:1,shipsVerifiedAt:'2026-10-16T00:00:00Z',stationSource:'SDE',
  ships:[{id:28846,name:'游牧者级',group:'战略货舰',groupId:902,fuelId:17889,fuelName:'氢同位素',baseRange:5,baseFuel:8200,shipFuelBonus:-10}],
  stations:{'30000142':[{id:60003760,typeId:1531}]},
  systems:[{id:30000142,nameZh:'吉他',nameEn:'Jita',regionId:10000002,regionName:'伏尔戈',x:0,y:0,z:0,security:.9}],gates:[]});
test('complete catalog and supplement validate without dropping or mutating raw data',()=>{
  const data=fixture(),copy=structuredClone(data);assert.equal(validateJumpSupplement(data),data);assert.equal(validateJumpCatalog(data),data);assert.deepEqual(data,copy);
});
test('every ship validates: IDs, names, fuel, bonus, overflow and duplicate entries',()=>{
  const bad=[{id:0},{id:'28846'},{groupId:null},{fuelId:-1},{name:''},{fuelName:null},{baseRange:null},{baseRange:NaN},{baseRange:0},{baseRange:Number.MAX_VALUE},{baseFuel:0},{baseFuel:'8200'},{baseFuel:Number.MAX_VALUE},{shipFuelBonus:undefined},{shipFuelBonus:null},{shipFuelBonus:NaN},{shipFuelBonus:Infinity},{shipFuelBonus:-20},{shipFuelBonus:-101}];
  for(const change of bad){const data=fixture();Object.assign(data.ships[0],change);assert.throws(()=>validateJumpSupplement(data),/校验失败/,JSON.stringify(change));}
  const duplicate=fixture();duplicate.ships.push({...duplicate.ships[0]});assert.throws(()=>validateJumpSupplement(duplicate),/重复舰船/);
  const nonDefault=fixture();nonDefault.ships.push({...nonDefault.ships[0],id:28844,baseRange:null});assert.throws(()=>validateJumpSupplement(nonDefault),/28844/,'do not validate only the selected ship');
});
test('station references, timestamps, systems and gate edges reject malformed batches',()=>{
  const mutations=[d=>d.schema=2,d=>d.ships=[],d=>d.ships={},d=>d.stations=null,d=>d.stations['bad']=[],d=>d.stations['30000142'][0].id=0,d=>d.stations['30000142'][0].typeId=null,d=>d.stations['30000143']=[{id:60003760,typeId:1531}],d=>d.shipsVerifiedAt='invalid',d=>d.stationSource='',d=>d.systems=[],d=>d.systems[0].x=null,d=>d.systems[0].security=NaN,d=>d.systems.push({...d.systems[0]}),d=>d.gates=[[30000142,999]],d=>d.gates=[[30000142,30000142]]];
  for(const mutate of mutations){const data=fixture();mutate(data);assert.throws(()=>validateJumpCatalog(data),/校验失败/);}
});
test('export rejects invalid numeric values before publishing and preserves previous output',t=>{
  const dir=mkdtempSync(join(tmpdir(),'jump-catalog-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));
  const archive=join(dir,'sde.zip'),input=join(dir,'audit.json'),output=join(dir,'jump.json');
  const zip=spawnSync('python3',['-c','import zipfile,sys; z=zipfile.ZipFile(sys.argv[1],"w"); z.writestr("npcStations.jsonl", ""); z.close()',archive],{encoding:'utf8'});assert.equal(zip.status,0,zip.stderr);
  writeFileSync(output,'previous complete snapshot');
  const ship=fixture().ships[0];
  const audit={complete:true,datasource:'serenity',generated_at:'2026-10-16T00:00:00Z',ships:[{type_id:ship.id,name_zh:ship.name,group_name_zh:ship.group,group_id:ship.groupId,base_range_ly:null,fuel_type_id:ship.fuelId,fuel_name_zh:ship.fuelName,base_fuel_units_per_ly:ship.baseFuel}],raw_ships:{[ship.id]:{dogma_attributes:[{attribute_id:1312,value:-10}]}}};
  writeFileSync(input,JSON.stringify(audit));
  const result=spawnSync(process.execPath,[resolve('scripts/v2/export-jump-demo.mjs'),archive,input,output],{encoding:'utf8'});
  assert.notEqual(result.status,0);assert.match(result.stderr,/基础数据无效/);assert.equal(readFileSync(output,'utf8'),'previous complete snapshot');
  audit.ships[0].base_range_ly=5;writeFileSync(input,JSON.stringify(audit));
  const valid=spawnSync(process.execPath,[resolve('scripts/v2/export-jump-demo.mjs'),archive,input,output],{encoding:'utf8'});
  assert.equal(valid.status,0,valid.stderr);assert.equal(validateJumpSupplement(JSON.parse(readFileSync(output,'utf8'))).ships.length,1);
});
test('server and client use the same validator; error response is not cached and page can retry',()=>{
  const route=readFileSync(new URL('../app/api/navigation/jump/catalog/route.ts',import.meta.url),'utf8');
  assert.match(route,/validateJumpSupplement\(JSON.parse/);assert.match(route,/validateJumpCatalog\(/);assert.match(route,/status:503,headers:\{'cache-control':'no-store'\}/);
  const page=readFileSync(new URL('../app/navigation/jump/page.tsx',import.meta.url),'utf8');
  assert.match(page,/validateJumpCatalog\(body\)/);assert.match(page,/重新加载基础资料/);assert.match(page,/routeState.kind==='complete'/);
});
