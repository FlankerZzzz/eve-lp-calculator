// Standalone research export: no live database access, migrations or sync jobs.
import {mkdir,readFile,writeFile,rename} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {createHash} from 'node:crypto';
import {createReadStream} from 'node:fs';
import {readSdeMember} from './sde.mjs';
import {RequestPool,mapPool} from './request.mjs';
import {extractJumpShip,jumpShipsCsv} from '../../lib/jump-ships.mjs';

const args=process.argv.slice(2),positional=args.filter(arg=>!arg.startsWith('--'));
if(args.some(arg=>arg.startsWith('--')&&arg!=='--refresh')||positional.length>2)throw new Error('Usage: export-jump-ships.mjs [sde.zip] [output-directory] [--refresh]');
const archive=resolve(positional[0]??'docker-data/v2/sde.zip');
const root=resolve(positional[1]??`docker-data/v2/jump-ships-${new Date().toISOString().slice(0,10)}`);
const refresh=args.includes('--refresh');
const base='https://ali-esi.evepc.163.com/latest';
const pool=new RequestPool({concurrency:3,rate:3});
await mkdir(join(root,'raw'),{recursive:true});
async function save(path,data) {
  const tmp=`${path}.${process.pid}.tmp`;
  await writeFile(tmp,JSON.stringify(data,null,2)+'\n');await rename(tmp,path);
}
async function load(kind,id,language='zh') {
  const path=join(root,'raw',`${kind}-${id}${language==='zh'?'':'-'+language}.json`);
  if(!refresh)try {return JSON.parse(await readFile(path,'utf8'));}catch(error){if(error.code!=='ENOENT')throw error;}
  const section=kind==='effects'?'dogma':'universe';
  const {data}=await pool.request(`${base}/${section}/${kind}/${id}/?datasource=serenity&language=${language}`);
  const result={fetched_at:new Date().toISOString(),data};await save(path,result);return result;
}
const metadata=[],sdeTypes=new Map(),sdeDogma=new Map(),attributeDefs=new Map();
await readSdeMember(archive,'_sde.jsonl',row=>metadata.push(row));
await readSdeMember(archive,'types.jsonl',row=>sdeTypes.set(row._key,row));
await readSdeMember(archive,'typeDogma.jsonl',row=>sdeDogma.set(row._key,row));
await readSdeMember(archive,'dogmaAttributes.jsonl',row=>attributeDefs.set(row._key,row));
const hash=createHash('sha256');for await(const chunk of createReadStream(archive))hash.update(chunk);
const category=await load('categories',6),groups=[];
if(category.data.category_id!==6||!Array.isArray(category.data.groups))throw new Error('Invalid ship category response');
await mapPool(category.data.groups,async id=>{
  const group=(await load('groups',id)).data;
  if(group.group_id!==id||group.category_id!==6||!Array.isArray(group.types))throw new Error(`Invalid ship group ${id}`);
  groups.push(group);
},3);
groups.sort((a,b)=>a.group_id-b.group_id);
const typeGroups=new Map();
for(const group of groups)for(const id of group.types) {
  if(typeGroups.has(id))throw new Error(`Duplicate ship type ${id}`);
  typeGroups.set(id,group);
}
console.log(JSON.stringify({event:'ship_catalog',groups:groups.length,types:typeGroups.size}));
const ships=[],failures=[],rawShips={};let completed=0;
await mapPool([...typeGroups],async([id,group])=>{
  try {
    const result=await load('types',id);
    if(result.data.type_id!==id)throw new Error(`Unexpected type ID ${result.data.type_id}`);
    const ship=extractJumpShip(result.data,group,{sdeType:sdeTypes.get(id),sdeDogma:sdeDogma.get(id)});
    if(ship){ship.fetched_at=result.fetched_at;ships.push(ship);rawShips[id]=result.data;console.log(JSON.stringify({event:'jump_ship',id,name:ship.name_zh,range:ship.base_range_ly,fuel:ship.base_fuel_units_per_ly}));}
  }catch(error){failures.push({type_id:id,message:error.message,status:error.status??null});console.error(JSON.stringify({event:'failed',id,message:error.message}));}
  if(++completed%50===0)console.log(JSON.stringify({event:'progress',completed,total:typeGroups.size}));
},3);
const fuels=new Map();
await mapPool([...new Set(ships.map(s=>s.fuel_type_id).filter(Boolean))],async id=>fuels.set(id,(await load('types',id)).data),3);
for(const ship of ships){ship.fuel_name_zh=fuels.get(ship.fuel_type_id)?.name??null;ship.fuel_name_en=sdeTypes.get(ship.fuel_type_id)?.name?.en??null;}
await mapPool(ships.filter(s=>!s.name_en),async ship=>{
  const {data}=await load('types',ship.type_id,'en');
  if(data.type_id!==ship.type_id)throw new Error('Invalid English-name response');
  ship.name_en=data.name;
},3);
// Keep skill/effect evidence for the next phase; do not invent a universal fuel formula.
const skillAttributeIds=[182,183,184,1285,1289,1290];
const skillIds=new Set([3456,21610,21611]);
for(const raw of Object.values(rawShips))for(const a of raw.dogma_attributes)if(skillAttributeIds.includes(a.attribute_id)&&Number.isSafeInteger(a.value)&&a.value>0)skillIds.add(a.value);
const rawSkills={},effects={},evidenceFailures=[];
await mapPool([...skillIds],async id=>{
  try{rawSkills[id]=(await load('types',id)).data;}catch(error){evidenceFailures.push({kind:'skill',id,message:error.message});}
},3);
const effectIds=[...new Set([...Object.values(rawShips),...Object.values(rawSkills)].flatMap(t=>(t.dogma_effects??[]).map(e=>e.effect_id)))];
console.log(JSON.stringify({event:'skill_evidence',skills:skillIds.size,effects:effectIds.length}));
let effectsCompleted=0;
await mapPool(effectIds,async id=>{
  try{
    const {data}=await load('effects',id);
    if(data.effect_id!==id)throw new Error('Unexpected effect ID');
    effects[id]=data;
  }catch(error){evidenceFailures.push({kind:'effect',id,message:error.message});}
  if(++effectsCompleted%50===0)console.log(JSON.stringify({event:'effect_progress',completed:effectsCompleted,total:effectIds.length}));
},3);
ships.sort((a,b)=>a.group_id-b.group_id||a.type_id-b.type_id);
const relevantAttributes=new Set(ships.flatMap(s=>rawShips[s.type_id].dogma_attributes.map(a=>a.attribute_id)));
const report={schema_version:1,generated_at:new Date().toISOString(),datasource:'serenity',
  complete:failures.length===0&&evidenceFailures.length===0&&ships.every(s=>s.issues.length===0),
  attributes_basis:'base hull values; no pilot skill, fitting or jump-portal passenger fuel applied',
  sde:{metadata,sha256:hash.digest('hex')},scan:{groups:groups.length,types:typeGroups.size,completed,failures,complete:failures.length===0},
  ships,raw_ships:rawShips,raw_skills:rawSkills,effects,evidence_failures:evidenceFailures,groups,attribute_definitions:[...relevantAttributes].map(id=>attributeDefs.get(id)).filter(Boolean)};
await save(join(root,'jump-ships.json'),report);
await writeFile(join(root,'jump-ships.csv'),jumpShipsCsv(ships));
const cell=v=>String(v??'待核实').replaceAll('|','\\|');
const lines=['# 晨曦跳跃舰船基础数据','',`生成时间：${report.generated_at}`,`扫描舰船分类 6：${groups.length} 个分组，${completed}/${typeGroups.size} 个条目；失败 ${failures.length} 个。`,
  '','以下为晨曦 ESI 明确返回 published=true 且基础跳距大于 0 的舰船。距离和燃料均为裸船基础值，未应用技能；燃料消耗单位是同位素单位/光年，不是每次起跳的固定消耗。','',
  '| 物品 ID | 舰船 | 分类 | 基础跳距（光年） | 燃料 | 基础消耗（单位/光年） |',
  '| --- | --- | --- | ---: | --- | ---: |',
  ...ships.map(s=>`| ${s.type_id} | ${cell(s.name_zh)} | ${cell(s.group_name_zh)} | ${s.base_range_ly} | ${cell(s.fuel_name_zh)} | ${cell(s.base_fuel_units_per_ly)} |`),
  '', '## 核验口径','',
  '- 晨曦 /universe/categories/6/ → /universe/groups/{group_id}/ → /universe/types/{type_id}/，不靠名称或市场订单筛选。',
  '- 属性 867：基础跳距；866：燃料物品 ID；868：每光年基础消耗；861：跳跃引擎标记；898：基础电容需求比例。',
  '- 标准 SDE 用于名称、属性定义及差异对比。实际取值以本次晨曦 ESI 返回值为准；不把国际服数值静默补到国服。',
  '- 本次是独立快照导出，不接触业务数据库，不新增数据库表，不启用新的定时任务。',
  '- 原始响应逐项保存，重跑可以复用断点。更新版本时用 --refresh；有请求失败则 scan.complete=false，不得宣称完成全量核验。',
  '',`技能/效果核验：${Object.keys(rawSkills).length} 个技能、${Object.keys(effects).length} 个效果；失败 ${evidenceFailures.length} 个。`,
  ...failures.map(f=>`- 查询失败 ${f.type_id}: ${f.message}`),...evidenceFailures.map(f=>`- 证据缺失 ${f.kind} ${f.id}: ${f.message}`)];
await writeFile(join(root,'jump-ships.md'),lines.join('\n')+'\n');
console.log(JSON.stringify({event:'complete',ships:ships.length,failures:failures.length,output:root}));
if(failures.length||evidenceFailures.length||ships.some(s=>s.issues.length))process.exitCode=1;
