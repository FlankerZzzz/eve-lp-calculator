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

export function parseContractText(text: string) {
  return text.split(/\r?\n/).map(line => line.replace(/&#x20;/gi, " ").trim()).filter(Boolean).map((line, index) => {
    const fields = line.split(/\t+|\s{2,}/).map(field => field.trim()).filter(Boolean);
    const quantity = Number((fields[1] || "").replace(/,/g, ""));
    return { line: index + 1, name: fields[0] || "", quantity, category: fields[3] || "", slot: fields[4] || "" };
  }).filter(item => item.name && Number.isSafeInteger(item.quantity) && item.quantity > 0);
}
