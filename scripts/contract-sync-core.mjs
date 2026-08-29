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
