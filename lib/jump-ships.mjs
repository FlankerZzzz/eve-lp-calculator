// ESI Dogma values are base hull attributes, before pilot skills or fittings.
export const JUMP_ATTRIBUTES = Object.freeze({drive:861,fuelType:866,range:867,fuelAmount:868,capacitor:898});

export function extractJumpShip(type,group,{sdeType,sdeDogma}={}) {
  if(!Number.isSafeInteger(type?.type_id)||type.type_id<=0)throw new Error('Invalid type ID');
  if(group?.category_id!==6||type?.group_id!==group.group_id||type.published!==true)return null;
  const attrs=new Map((type.dogma_attributes??[]).map(a=>[a.attribute_id,a.value]));
  const range=attrs.get(JUMP_ATTRIBUTES.range);
  if(!Number.isFinite(range)||range<=0)return null;
  // Never turn a missing fuel attribute into zero or silently use a TQ default.
  const fuelType=attrs.get(JUMP_ATTRIBUTES.fuelType),fuelAmount=attrs.get(JUMP_ATTRIBUTES.fuelAmount);
  const issues=[];
  if(attrs.get(JUMP_ATTRIBUTES.drive)!==1)issues.push('jump-drive-flag-not-1');
  if(!Number.isSafeInteger(fuelType)||fuelType<=0)issues.push('missing-fuel-type');
  if(!Number.isFinite(fuelAmount)||fuelAmount<=0)issues.push('missing-fuel-consumption');
  const baseline=new Map((sdeDogma?.dogmaAttributes??[]).map(a=>[a.attributeID,a.value]));
  return {type_id:type.type_id,name_zh:type.name,name_en:sdeType?.name?.en??null,
    group_id:group.group_id,group_name_zh:group.name,
    base_range_ly:range,fuel_type_id:Number.isSafeInteger(fuelType)&&fuelType>0?fuelType:null,
    base_fuel_units_per_ly:Number.isFinite(fuelAmount)&&fuelAmount>0?fuelAmount:null,
    base_capacitor_fraction:attrs.get(JUMP_ATTRIBUTES.capacitor)??null,
    source:'ESI-serenity',in_standard_sde:Boolean(sdeType),issues,
    sde_comparison:Object.fromEntries(Object.entries(JUMP_ATTRIBUTES).map(([key,id])=>[key,{esi:attrs.get(id)??null,sde:baseline.get(id)??null}]))};
}

export function jumpShipsCsv(ships) {
  const keys=['type_id','name_zh','name_en','group_id','group_name_zh','base_range_ly','fuel_type_id','fuel_name_zh','base_fuel_units_per_ly','base_capacitor_fraction','source','in_standard_sde'];
  const quote=value=>`"${String(value??'').replaceAll('"','""')}"`;
  return '\uFEFF'+[keys.map(quote).join(','),...ships.map(ship=>keys.map(key=>quote(ship[key])).join(','))].join('\r\n')+'\r\n';
}
