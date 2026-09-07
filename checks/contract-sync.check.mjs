import assert from "node:assert/strict";
import check from "node:test";
import { canonicalTypeSignature, classifyBlueprintCopyContractItems, classifyContractItems } from "../scripts/contract-sync-core.mjs";

const included = (typeId, quantity = 1) => ({ is_included: true, type_id: typeId, quantity });

check("套装签名与物品输入顺序无关", () => {
  assert.equal(canonicalTypeSignature([60, 10, 50, 20, 40, 30]), "10,20,30,40,50,60");
});

check("完整六种且数量相同的合同生成套装签名与套数", () => {
  const result = classifyContractItems([60, 10, 50, 20, 40, 30].map(typeId => included(typeId, 10)));
  assert.deepEqual(result, {
    valid: true,
    reason: null,
    signature: "10,20,30,40,50,60",
    setCount: 10,
    typeIds: [10, 20, 30, 40, 50, 60],
  });
});

check("缺件、夹带第七种或六种数量不相等都会被拒绝", () => {
  assert.equal(classifyContractItems([10, 20, 30, 40, 50].map(typeId => included(typeId))).reason, "not-six-types");
  assert.equal(classifyContractItems([10, 20, 30, 40, 50, 60, 70].map(typeId => included(typeId))).reason, "not-six-types");
  assert.equal(classifyContractItems([10, 20, 30, 40, 50, 60].map((typeId, index) => included(typeId, index ? 1 : 2))).reason, "unequal-quantities");
});

check("要求买家提供物品的以物易物合同会被拒绝", () => {
  const items = [10, 20, 30, 40, 50, 60].map(included);
  items.push({ is_included: false, type_id: 99, quantity: 1 });
  assert.equal(classifyContractItems(items).reason, "requested-items");
});

check("同一物品拆成多条记录时先合并数量再判断", () => {
  const items = [included(10, 4), included(10, 6), ...[20, 30, 40, 50, 60].map(typeId => included(typeId, 10))];
  const result = classifyContractItems(items);
  assert.equal(result.valid, true);
  assert.equal(result.setCount, 10);
});

const blueprintCopy = (typeId, quantity = 1, runs = 5, materialEfficiency = 10, timeEfficiency = 20) => ({
  is_included: true, is_blueprint_copy: true, type_id: typeId, quantity, runs, material_efficiency: materialEfficiency, time_efficiency: timeEfficiency,
});

check("同属性蓝图复制品合同汇总份数并保留 runs、ME、TE", () => {
  const result = classifyBlueprintCopyContractItems([blueprintCopy(700, 2), blueprintCopy(700, 3)]);
  assert.deepEqual(result, {
    valid: true,
    reason: null,
    blueprintTypeId: 700,
    copyCount: 5,
    runs: 5,
    materialEfficiency: 10,
    timeEfficiency: 20,
  });
});

check("蓝图合同拒绝索取物品、普通物品和蓝图原件", () => {
  assert.equal(classifyBlueprintCopyContractItems([blueprintCopy(700), { is_included: false, type_id: 1, quantity: 1 }]).reason, "requested-items");
  assert.equal(classifyBlueprintCopyContractItems([{ is_included: true, type_id: 700, quantity: 1 }]).reason, "not-blueprint-copy");
  assert.equal(classifyBlueprintCopyContractItems([{ ...blueprintCopy(700), is_blueprint_copy: false }]).reason, "not-blueprint-copy");
  assert.equal(classifyBlueprintCopyContractItems([blueprintCopy(700, 1, -1)]).reason, "invalid-blueprint-attributes");
});

check("蓝图合同拒绝混合蓝图类型与不同 runs、ME、TE", () => {
  assert.equal(classifyBlueprintCopyContractItems([blueprintCopy(700), blueprintCopy(701)]).reason, "mixed-blueprint-types");
  assert.equal(classifyBlueprintCopyContractItems([blueprintCopy(700), blueprintCopy(700, 1, 6)]).reason, "mixed-runs");
  assert.equal(classifyBlueprintCopyContractItems([blueprintCopy(700), blueprintCopy(700, 1, 5, 11)]).reason, "mixed-material-efficiency");
  assert.equal(classifyBlueprintCopyContractItems([blueprintCopy(700), blueprintCopy(700, 1, 5, 10, 21)]).reason, "mixed-time-efficiency");
});
