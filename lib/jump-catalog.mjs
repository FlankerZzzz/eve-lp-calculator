import {shipParameters} from './jump-planner.mjs';
const record=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const id=value=>Number.isSafeInteger(value)&&value>0;
const text=value=>typeof value==='string'&&value.trim().length>0;
function invalid(message){throw new Error(`跳跃基础资料校验失败：${message}`);}

// Shared by the exporter, server cache and client. Reject a whole invalid batch;
// never silently replace missing fuel/range with defaults or publish half a list.
export function validateJumpSupplement(data){
  if(!record(data)||data.schema!==1)invalid('快照版本无效');
  if(!Array.isArray(data.ships)||!data.ships.length)invalid('舰船清单为空或格式错误');
  const seen=new Set();
  for(const s of data.ships){
    if(!record(s)||!id(s.id)||!id(s.groupId)||!id(s.fuelId))invalid('舰船、分组或燃料 ID 无效');
    if(seen.has(s.id))invalid(`重复舰船 ID ${s.id}`);seen.add(s.id);
    if(!text(s.name)||!text(s.group)||!text(s.fuelName))invalid(`舰船 ${s.id} 缺少名称或燃料名称`);
    if(!Number.isFinite(s.shipFuelBonus))invalid(`舰船 ${s.id} 耗油加成缺失或无效`);
    try{
      for(const shipSkill of [0,5]){
        const p=shipParameters(s,{calibration:5,conservation:0,shipSkill});
        if(!Number.isFinite(Math.fround(p.range))||!Number.isSafeInteger(Math.ceil(p.range*p.fuelPerLy)))throw new Error('最大航程或燃料超出安全计算范围');
      }
    }catch(error){invalid(`舰船 ${s.id}：${error.message}`);}
  }
  if(!record(data.stations))invalid('空间站清单格式错误');
  const stationIds=new Set();
  for(const [system,rows] of Object.entries(data.stations)){
    if(!id(Number(system))||String(Number(system))!==system||!Array.isArray(rows))invalid('空间站星系索引无效');
    for(const row of rows){
      if(!record(row)||!id(row.id)||!id(row.typeId)||stationIds.has(row.id))invalid('空间站 ID、类型或重复记录无效');
      stationIds.add(row.id);
    }
  }
  if(!text(data.stationSource)||!text(data.shipsVerifiedAt)||!Number.isFinite(Date.parse(data.shipsVerifiedAt)))invalid('基础资料来源或核验时间缺失');
  return data;
}
export function validateJumpCatalog(data){
  validateJumpSupplement(data);
  if(!Array.isArray(data.systems)||!data.systems.length||!Array.isArray(data.gates))invalid('星系或星门清单无效');
  const ids=new Set();
  for(const s of data.systems){
    if(!record(s)||!id(s.id)||ids.has(s.id)||!id(s.regionId)||!text(s.nameZh)||!text(s.nameEn)||!text(s.regionName)||!['x','y','z','security'].every(k=>Number.isFinite(s[k])))invalid('星系 ID、名称或坐标无效');
    ids.add(s.id);
  }
  for(const gate of data.gates)if(!Array.isArray(gate)||gate.length!==2||gate[0]===gate[1]||gate.some(n=>!ids.has(n)))invalid('星门连接无效');
  return data;
}
