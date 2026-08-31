// 无效数据只在这里登记；原始目录保留，公开展示、榜单和市场同步统一排除。
export const HIDDEN_FACTIONS = [
  { id: 500013, name: "长青船业", reason: "非标准 LP 收益分析势力" },
  { id: 500017, name: "真理会", reason: "非标准 LP 收益分析势力" },
  { id: 500026, name: "三神裔", reason: "非标准 LP 收益分析势力" },
] as const;
export const HIDDEN_FACTION_IDS = HIDDEN_FACTIONS.map(entity => entity.id);
export const HIDDEN_FACTION_SQL = HIDDEN_FACTION_IDS.join(",");

export const HIDDEN_CORPORATIONS = [
  { id: 1000283, name: "帝国战争后备处", reason: "涂装专属兑换军团" },
  { id: 1000284, name: "合众国军事储备处", reason: "涂装专属兑换军团" },
  { id: 1000285, name: "联邦战略军需处", reason: "涂装专属兑换军团" },
  { id: 1000286, name: "共和舰队军械处", reason: "涂装专属兑换军团" },
] as const;
export const HIDDEN_CORPORATION_IDS = HIDDEN_CORPORATIONS.map(entity => entity.id);
export const HIDDEN_CORPORATION_SQL = HIDDEN_CORPORATION_IDS.join(",");

const HIDDEN_FACTION_ID_SET = new Set<number>(HIDDEN_FACTION_IDS);
const HIDDEN_CORPORATION_ID_SET = new Set<number>(HIDDEN_CORPORATION_IDS);

export function isGloballyExcludedCorporation(corporationId: number, factionId: number | null | undefined) {
  return HIDDEN_CORPORATION_ID_SET.has(corporationId) || (factionId !== null && factionId !== undefined && HIDDEN_FACTION_ID_SET.has(factionId));
}

export function visibleCorporationSql(alias = "c") {
  return `(${alias}.faction_id IS NULL OR ${alias}.faction_id NOT IN (${HIDDEN_FACTION_SQL})) AND ${alias}.corporation_id NOT IN (${HIDDEN_CORPORATION_SQL})`;
}

export function excludedCorporationSql(alias = "c") {
  return `(${alias}.faction_id IN (${HIDDEN_FACTION_SQL}) OR ${alias}.corporation_id IN (${HIDDEN_CORPORATION_SQL}))`;
}
