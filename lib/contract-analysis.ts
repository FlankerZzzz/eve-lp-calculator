export type ContractItem = { type_id: number; quantity: number; name_zh?: string; name_en?: string; category?: string; slot?: string };
export type Quote = { sellPrice: number; buyPrice: number; sellVolume: number; buyVolume: number; historyPrice?: number | null };
type NamedType = { type_id: number; name_zh: string | null; name_en?: string | null };
export function createContractNameResolver(catalog: NamedType[]) {
  const normalize=(value: string)=>value.trim().toLowerCase().replace(/[“”"‘’'＂]/g,'"').replace(/\s+/g,' ');
  const byName=new Map<string,Map<number,NamedType>>(),byId=new Map<number,NamedType>();
  for(const row of catalog){byId.set(row.type_id,row);for(const value of [row.name_zh,row.name_en]){if(value==null)continue;const key=normalize(value),matches=byName.get(key)??new Map<number,NamedType>();matches.set(row.type_id,row);byName.set(key,matches);}}
  return (name: string) => {
    const numeric=/^[1-9]\d*$/.test(name.trim())?Number(name):null;
    const candidates=numeric!==null?(byId.has(numeric)?[byId.get(numeric)!]:[]):[...(byName.get(normalize(name))?.values()??[])];
    return {item:candidates.length===1?candidates[0]:null,candidates,ambiguous:candidates.length>1};
  };
}
export function resolveContractName(name: string, catalog: NamedType[]) { return createContractNameResolver(catalog)(name); }
export function contractPayment(contract: {payment_type?: string;unit_price?: number | null;plex_quantity?: number;set_count?: number}) {
  const currency=contract.payment_type==='PLEX'?'PLEX':'ISK';
  const value=currency==='PLEX'?Number(contract.plex_quantity)/(contract.set_count||1):contract.unit_price;
  return {currency,value:typeof value==='number'&&Number.isFinite(value)&&value>0?value:null};
}
export function mergeContractItems(items: ContractItem[]) { const merged = new Map<number, ContractItem>(); for (const item of items) { if (!Number.isSafeInteger(item.type_id) || item.type_id <= 0 || !Number.isFinite(item.quantity) || item.quantity <= 0) continue; const previous = merged.get(item.type_id); if (previous) previous.quantity += item.quantity; else merged.set(item.type_id, { ...item, quantity: item.quantity }); } return [...merged.values()]; }
export function weightedEstimate(quote: Quote) { const weighted: Array<[number, number]> = []; if (quote.sellPrice > 0 && quote.sellVolume > 0) weighted.push([quote.sellPrice, quote.sellVolume]); if (quote.buyPrice > 0 && quote.buyVolume > 0) weighted.push([quote.buyPrice, quote.buyVolume]); if (weighted.length) return weighted.reduce((sum, [price, volume]) => sum + price * volume, 0) / weighted.reduce((sum, [, volume]) => sum + volume, 0); if (quote.sellPrice > 0 && quote.buyPrice > 0) return (quote.sellPrice + quote.buyPrice) / 2; return quote.sellPrice > 0 ? quote.sellPrice : quote.buyPrice > 0 ? quote.buyPrice : quote.historyPrice && quote.historyPrice > 0 ? quote.historyPrice : null; }
const iskFormatter=new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 });
export function formatIsk(value: number | null | undefined) { if (value == null || !Number.isFinite(value)) return "暂无报价"; return `${iskFormatter.format(value)} ISK`; }

export type ContractInputIssue = { line: number; name: string; reason: string };
export class ContractTextError extends Error {
  issues: ContractInputIssue[];
  issueCount: number;
  constructor(issues: ContractInputIssue[], issueCount = issues.length) {
    super(`合同文本有 ${issueCount} 行错误，本次未进行估价。请修正后重新分析。`);
    this.name = "ContractTextError";
    this.issues = issues;
    this.issueCount = issueCount;
  }
}
export function parseContractText(text: string) {
  const items: { line: number; name: string; quantity: number; category: string; slot: string }[] = [];
  const issues: ContractInputIssue[] = [], totals = new Map<string, number>();
  let issueCount = 0;
  for (const [index, raw] of text.split(/\r?\n/).entries()) {
    const line = raw.replace(/&#x20;/gi, " ").trim();
    if (!line || /^(?:品目|物品(?:名称)?|名称|item(?:\s*name)?|name)\s+(?:数量|quantity|qty)(?:\s|$)/i.test(line)) continue;
    // Preserve empty tab columns, so a missing quantity cannot shift later fields left.
    const fields = line.split(line.includes("\t") ? /\t/ : /\s{2,}/).map(field => field.trim());
    const name = fields[0] || "", value = fields[1] || "";
    const quantity = Number(value.replace(/,/g, ""));
    let reason = !name ? "缺少物品名称" : !value ? "缺少数量" :
      !/^(?:\d+|\d{1,3}(?:,\d{3})+)$/.test(value) || quantity <= 0 ? "数量必须是正整数（可使用千位逗号）" :
      !Number.isSafeInteger(quantity) ? "数量超过可安全计算的整数范围" : "";
    const total = (totals.get(name) || 0) + quantity;
    if (!reason && !Number.isSafeInteger(total)) reason = "同名物品合并后的数量超过可安全计算的整数范围";
    if (reason) {
      issueCount++; if (issues.length < 100) issues.push({ line: index + 1, name, reason });
    } else {
      totals.set(name, total);
      items.push({ line: index + 1, name, quantity, category: fields[3] || "", slot: fields[4] || "" });
    }
  }
  if (issueCount) throw new ContractTextError(issues, issueCount);
  return items;
}
