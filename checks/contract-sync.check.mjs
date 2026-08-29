import assert from "node:assert/strict";
import check from "node:test";
import { canonicalTypeSignature, classifyContractItems } from "../scripts/contract-sync-core.mjs";

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
