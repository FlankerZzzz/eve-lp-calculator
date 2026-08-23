// 长青船业、真理会、三神裔：仅隐藏展示并排除市场同步。
export const HIDDEN_FACTION_IDS = [500013, 500017, 500026] as const;
export const HIDDEN_FACTION_SQL = HIDDEN_FACTION_IDS.join(",");
