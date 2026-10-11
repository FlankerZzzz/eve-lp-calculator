import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { createReadStream, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { transaction, setState } from './database.mjs';

function validateSdeType(row) {
  if(!Number.isSafeInteger(row._key)||row._key<0)throw new Error('Invalid type ID');
  if(typeof row.published!=='boolean')throw new Error(`Type ${row._key}: published must be a boolean`);
  if(row._key===0&&(row.name?.en!=='#System'||row.groupID!==0||row.published!==false))throw new Error('Unexpected SDE type 0; cannot treat as a system placeholder');
}

export async function readSdeMember(archive,member,callback) {
  const child=spawn('python3',[fileURLToPath(new URL('./zip-reader.py',import.meta.url)),archive,member],{stdio:['ignore','pipe','pipe']});
  let stderr=''; child.stderr.on('data',chunk=>{stderr+=chunk;});
  const completion=new Promise((resolve,reject)=>{child.on('error',reject);child.on('close',code=>code===0?resolve():reject(new Error(`SDE ${member}: ${stderr}`)));});
  // Attach immediately so a child failure cannot become an unhandled rejection.
  completion.catch(()=>{});
  let line=0;
  try {
    for await(const text of createInterface({input:child.stdout,crlfDelay:Infinity})) {
      line++; if(!text.trim()) continue;
      try {await callback(JSON.parse(text));} catch(error) {throw new Error(`${member}:${line}: ${error.message}`,{cause:error});}
    }
    await completion;
  } catch(error) {child.kill();await completion.catch(()=>{});throw error;}
}

export async function readSdeTypeIndex(archive,expectedSha256) {
  if(typeof expectedSha256!=='string'||!/^[a-f0-9]{64}$/.test(expectedSha256))throw new Error('SDE baseline hash is missing; import SDE first');
  if(statSync(archive).size>200*1024*1024)throw new Error('SDE ZIP exceeds 200 MiB');
  const hash=createHash('sha256');for await(const chunk of createReadStream(archive))hash.update(chunk);
  if(hash.digest('hex')!==expectedSha256)throw new Error('SDE archive differs from the imported baseline; import this version first');
  const index=new Map();
  await readSdeMember(archive,'types.jsonl',row=>{
    validateSdeType(row);
    if(index.has(row._key))throw new Error(`Duplicate type ${row._key}`);
    index.set(row._key,row.published);
  });
  return index;
}

export async function importSde(db,archive,log) {
  if(statSync(archive).size>200*1024*1024) throw new Error('SDE ZIP exceeds 200 MiB');
  const hash=createHash('sha256'); for await(const chunk of createReadStream(archive)) hash.update(chunk);
  const types=new Map(),blueprints=[],metadata=[],skippedTypes=[],skippedRecipes=[];
  log.info('sde_parse_start');
  await readSdeMember(archive,'_sde.jsonl',row=>metadata.push(row));
  await readSdeMember(archive,'types.jsonl',row=>{
    validateSdeType(row);
    if(types.has(row._key)) throw new Error(`Duplicate type ${row._key}`);
    types.set(row._key,row);
    if(row.published!==true) skippedTypes.push(row._key);
  });
  const products=new Map();
  await readSdeMember(archive,'blueprints.jsonl',row=>{
    const id=row.blueprintTypeID??row._key,activity=row.activities?.manufacturing;
    if(!activity) return;
    if(!types.has(id)) throw new Error(`Blueprint type missing: ${id}`);
    if(types.get(id).published!==true) {skippedRecipes.push({id,reason:'unpublished-blueprint'});return;}
    if(activity.products?.length!==1) throw new Error(`Blueprint ${id}: expected one product`);
    for(const reference of [...activity.products,...(activity.materials??[])]) {
      if(!types.has(reference.typeID)) throw new Error(`Blueprint ${id}: missing reference ${reference.typeID}`);
      if(!Number.isInteger(reference.quantity)||reference.quantity<1) throw new Error(`Blueprint ${id}: invalid material/product quantity`);
    }
    const unpublished=[...activity.products,...(activity.materials??[])].filter(x=>types.get(x.typeID).published!==true);
    if(unpublished.length) {skippedRecipes.push({id,reason:'unpublished-reference',type_ids:unpublished.map(x=>x.typeID)});return;}
    const product=activity.products[0];
    if(products.has(product.typeID)) throw new Error(`Product ${product.typeID} has multiple published blueprints: ${products.get(product.typeID)}, ${id}`);
    if(!Number.isInteger(activity.time)||activity.time<0) throw new Error(`Blueprint ${id}: invalid time`);
    const materialIds=(activity.materials??[]).map(x=>x.typeID);
    if(new Set(materialIds).size!==materialIds.length) throw new Error(`Blueprint ${id}: duplicate material`);
    products.set(product.typeID,id);blueprints.push({id,activity});
  });
  log.info('sde_validated',{types:types.size-skippedTypes.length,recipes:blueprints.length,skipped_types:skippedTypes.length,skipped_recipes:skippedRecipes.length});
  log.payload('sde_unpublished_types',skippedTypes);log.payload('sde_skipped_recipes',skippedRecipes);
  const now=new Date().toISOString();let protectedItems=0,protectedRecipes=0;
  const item=db.prepare(`INSERT INTO items(type_id,name_zh,name_en,group_id,volume,packaged_volume,source,published,updated_at) VALUES(?,?,?,?,?,?,'SDE',1,?)
    ON CONFLICT(type_id) DO UPDATE SET name_zh=excluded.name_zh,name_en=excluded.name_en,group_id=excluded.group_id,volume=excluded.volume,packaged_volume=excluded.packaged_volume,source='SDE',published=1,updated_at=excluded.updated_at WHERE items.sync_protected='N'`);
  const recipe=db.prepare(`INSERT INTO recipes(blueprint_id,product_type_id,product_quantity,manufacturing_time,updated_at) VALUES(?,?,?,?,?) ON CONFLICT(blueprint_id) DO UPDATE SET product_type_id=excluded.product_type_id,product_quantity=excluded.product_quantity,manufacturing_time=excluded.manufacturing_time,updated_at=excluded.updated_at WHERE recipes.sync_protected='N'`);
  transaction(db,()=>{
    for(const row of types.values()) if(row.published===true) {const result=item.run(row._key,row.name?.zh??null,row.name?.en??null,row.groupID??null,row.volume??null,row.packagedVolume??null,now);if(!result.changes)protectedItems++;}
    for(const {id,activity} of blueprints) {
      if(!recipe.run(id,activity.products[0].typeID,activity.products[0].quantity,activity.time,now).changes){protectedRecipes++;continue;}
      db.prepare('DELETE FROM recipe_materials WHERE blueprint_id=?').run(id);
      const insert=db.prepare('INSERT INTO recipe_materials(blueprint_id,material_type_id,quantity) VALUES(?,?,?)');
      for(const material of activity.materials??[]) insert.run(id,material.typeID,material.quantity);
      db.prepare("UPDATE items SET blueprint_id=? WHERE type_id=? AND sync_protected='N'").run(id,activity.products[0].typeID);
    }
    const violations=db.prepare('PRAGMA foreign_key_check').all();if(violations.length)throw new Error(`SDE foreign key violations: ${JSON.stringify(violations)}`);
    setState(db,'sde',{metadata,sha256:hash.digest('hex'),imported_at:now,types:types.size-skippedTypes.length,recipes:blueprints.length});
  });
  const result={types:types.size-skippedTypes.length,recipes:blueprints.length,protected_items:protectedItems,protected_recipes:protectedRecipes,skipped_types:skippedTypes.length,skipped_recipes:skippedRecipes.length};
  log.info('sde_published',result);return result;
}
