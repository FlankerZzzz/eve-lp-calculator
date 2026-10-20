import test from 'node:test';
import assert from 'node:assert/strict';
import {extractJumpShip,jumpShipsCsv} from '../lib/jump-ships.mjs';
const group={category_id:6,group_id:4622,name:'巨像'};
const type=(override={})=>({type_id:78589,group_id:4622,name:'加百列级',published:true,
  dogma_attributes:[{attribute_id:861,value:1},{attribute_id:866,value:17889},{attribute_id:867,value:2},{attribute_id:868,value:1000},{attribute_id:898,value:.95}],...override});
test('jump ship export retains Serenity hull base values, not TQ fallback or skilled values',()=>{
  const ship=extractJumpShip(type(),group,{sdeType:{name:{en:'Example'}},sdeDogma:{dogmaAttributes:[{attributeID:867,value:3.5}]}});
  assert.equal(ship.base_range_ly,2);assert.equal(ship.base_fuel_units_per_ly,1000);
  assert.equal(ship.fuel_type_id,17889);assert.equal(ship.base_capacitor_fraction,.95);
  assert.deepEqual(ship.sde_comparison.range,{esi:2,sde:3.5});assert.deepEqual(ship.issues,[]);
});
test('jump catalog excludes skills, non-ships, unpublished and non-jump hulls',()=>{
  assert.equal(extractJumpShip(type({group_id:257}),{category_id:16,group_id:257}),null);
  assert.equal(extractJumpShip(type({published:false}),group),null);
  assert.equal(extractJumpShip(type({dogma_attributes:[]}),group),null);
  assert.equal(extractJumpShip(type({dogma_attributes:[{attribute_id:867,value:0}]}),group),null);
  assert.equal(extractJumpShip(type(),{...group,group_id:547}),null);
  assert.throws(()=>extractJumpShip(type({type_id:undefined}),group),/Invalid type ID/);
});
test('unknown fuel stays unknown with an explicit issue; no default-zero estimate',()=>{
  const ship=extractJumpShip(type({dogma_attributes:[{attribute_id:861,value:1},{attribute_id:867,value:2}]}),group);
  assert.equal(ship.fuel_type_id,null);assert.equal(ship.base_fuel_units_per_ly,null);
  assert.deepEqual(ship.issues,['missing-fuel-type','missing-fuel-consumption']);
  assert.ok(extractJumpShip(type({dogma_attributes:[{attribute_id:867,value:2}]}),group).issues.includes('jump-drive-flag-not-1'));
});
test('CSV preserves units, Chinese names and quoting for manual audit',()=>{
  const csv=jumpShipsCsv([{...extractJumpShip(type(),group),name_zh:'舰船,"名称"\n第二行'}]);
  assert.ok(csv.startsWith('\uFEFF'));assert.ok(csv.includes('base_fuel_units_per_ly'));
  assert.ok(csv.includes('"舰船,""名称""\n第二行"'));
});
