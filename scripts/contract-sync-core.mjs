export const CONTRACT_CLASSIFIER_VERSION = 1;

export function canonicalTypeSignature(typeIds) {
  const normalized = [...new Set(typeIds.map(Number).filter(Number.isInteger))].sort((a, b) => a - b);
  return normalized.join(",");
}

export function classifyContractItems(items) {
  const requested = items.filter(item => !item?.is_included && Number(item?.quantity) > 0);
  if (requested.length) return { valid: false, reason: "requested-items" };

  const quantities = new Map();
  for (const item of items.filter(candidate => candidate?.is_included)) {
    const typeId = Number(item.type_id);
    const quantity = Number(item.quantity);
    if (!Number.isInteger(typeId) || !Number.isInteger(quantity) || quantity < 1) {
      return { valid: false, reason: "invalid-item" };
    }
    quantities.set(typeId, (quantities.get(typeId) || 0) + quantity);
  }

  if (quantities.size !== 6) return { valid: false, reason: "not-six-types" };
  const setCounts = new Set(quantities.values());
  if (setCounts.size !== 1) return { valid: false, reason: "unequal-quantities" };
  const typeIds = [...quantities.keys()].sort((a, b) => a - b);
  return {
    valid: true,
    reason: null,
    signature: canonicalTypeSignature(typeIds),
    setCount: quantities.get(typeIds[0]),
    typeIds,
  };
}

// A blueprint contract is useful only when it contains one homogeneous batch
// of blueprint copies.  In particular, an original blueprint, a requested
// item, or copies with different runs/ME/TE cannot be compared as one price.
export function classifyBlueprintCopyContractItems(items) {
  const requested = items.filter(item => !item?.is_included && Number(item?.quantity) > 0);
  if (requested.length) return { valid: false, reason: "requested-items" };

  const included = items.filter(item => item?.is_included);
  if (!included.length) return { valid: false, reason: "empty-contract" };

  let blueprintTypeId = null;
  let runs = null;
  let materialEfficiency = null;
  let timeEfficiency = null;
  let copyCount = 0;
  for (const item of included) {
    const typeId = Number(item?.type_id);
    const quantity = Number(item?.quantity);
    const itemRuns = Number(item?.runs);
    const itemMaterialEfficiency = Number(item?.material_efficiency);
    const itemTimeEfficiency = Number(item?.time_efficiency);
    if (!Number.isInteger(typeId) || !Number.isInteger(quantity) || quantity < 1) {
      return { valid: false, reason: "invalid-item" };
    }
    if (item?.is_blueprint_copy !== true) return { valid: false, reason: "not-blueprint-copy" };
    if (!Number.isInteger(itemRuns) || itemRuns < 1 || !Number.isInteger(itemMaterialEfficiency) || !Number.isInteger(itemTimeEfficiency)) {
      return { valid: false, reason: "invalid-blueprint-attributes" };
    }
    if (blueprintTypeId !== null && blueprintTypeId !== typeId) return { valid: false, reason: "mixed-blueprint-types" };
    if (runs !== null && runs !== itemRuns) return { valid: false, reason: "mixed-runs" };
    if (materialEfficiency !== null && materialEfficiency !== itemMaterialEfficiency) return { valid: false, reason: "mixed-material-efficiency" };
    if (timeEfficiency !== null && timeEfficiency !== itemTimeEfficiency) return { valid: false, reason: "mixed-time-efficiency" };
    blueprintTypeId = typeId;
    runs = itemRuns;
    materialEfficiency = itemMaterialEfficiency;
    timeEfficiency = itemTimeEfficiency;
    copyCount += quantity;
  }

  return {
    valid: true,
    reason: null,
    blueprintTypeId,
    copyCount,
    runs,
    materialEfficiency,
    timeEfficiency,
  };
}
