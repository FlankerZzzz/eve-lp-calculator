import { getState, setState, transaction } from './database.mjs';
import { filterLpRankingRows, lpFlagMap } from './lp-policy.mjs';

const windows=[30,15,7,3,1];
const cutoff=(date,days)=>{const d=new Date(`${date}T00:00:00Z`);d.setUTCDate(d.getUTCDate()-(days-1));return d.toISOString().slice(0,10);};
const key=row=>`${row.corporation_id}:${row.offer_id}`;
const name=row=>row?.name_zh??row?.name_en??`物品 ${row?.type_id}`;
const group=(rows,getKey)=>{const map=new Map();for(const row of rows){const k=getKey(row);if(!map.has(k))map.set(k,[]);map.get(k).push(row);}return map;};
function execution(levels,quantity,fallback) {
  let remaining=quantity,filled=0,value=0;
  for(const row of levels??[]) {const n=Math.min(remaining,row.volume);filled+=n;value+=n*row.price;remaining-=n;if(remaining<=0)break;}
  const price=filled>0?value/filled:0;
  return {price:price||fallback,coverage:price?Math.min(1,filled/quantity):fallback>0?1:0};
}
// Same signature, tax and depth rules as the legacy ranking worker. No high-sec prefilter.
export function calculateRankingOffer(offer) {
  const materialCost=offer.materials.reduce((n,m)=>n+m.quantity*(m.sell_execution_price||m.sell_price||0),0);
  const materialsCovered=offer.materials.every(m=>m.quantity<=0||(m.sell_execution_coverage??(m.sell_price>0?1:0))>=1);
  const outputCovered=(offer.buy_execution_coverage??(offer.buy_price>0?1:0))>=1;
  const revenueQuantity=offer.revenue_quantity||offer.quantity;
  const maxProfit=offer.sell_price>0&&materialsCovered?offer.sell_price*revenueQuantity*.97-offer.isk_cost-materialCost:null;
  const buy=offer.buy_execution_price||offer.buy_price;
  const minProfit=buy>0&&outputCovered&&materialsCovered?buy*revenueQuantity*.97-offer.isk_cost-materialCost:null;
  return {...offer,material_total:materialCost,max_profit:maxProfit,min_profit:minProfit,lp_ratio:offer.lp_cost>0&&minProfit!==null?minProfit/offer.lp_cost:0};
}
export function rankingSignature(offer) {
  const materials=offer.materials.map(m=>`${m.material_kind||''}:${m.type_id}:${m.quantity}`).sort().join('|');
  return `${offer.type_id}:${offer.quantity}:${offer.lp_cost}:${offer.isk_cost}:${offer.product_type_id||0}:${materials}`;
}
export function selectRankingRows(offers,field) {
  const unique=new Map();
  for(const offer of offers) {
    if(!(offer[field]>0))continue;
    const signature=rankingSignature(offer),previous=unique.get(signature);
    if(!previous||offer[field]>previous[field])unique.set(signature,offer);
  }
  return [...unique.values()].sort((a,b)=>b[field]-a[field]).slice(0,100);
}
export function rebuildV2Rankings(db) {
  // Do not replace migrated snapshots with partial initial market data.
  for(const taskModule of ['catalog','orders','history'])if(!db.prepare('SELECT last_success FROM tasks WHERE module=?').get(taskModule)?.last_success)throw new Error(`榜单等待 ${taskModule} 首次同步完成`);
  return transaction(db,()=>{
    const revision=getState(db,'lp_policy_revision',0);
    const flags=lpFlagMap(db);
    const items=new Map(db.prepare('SELECT type_id,name_zh,name_en FROM items').all().map(row=>[row.type_id,row]));
    const quotes=new Map(db.prepare('SELECT * FROM quote_cache').all().map(row=>[row.type_id,row]));
    const recipes=new Map(db.prepare('SELECT * FROM recipes').all().map(row=>[row.blueprint_id,row]));
    const requirements=group(db.prepare('SELECT * FROM lp_requirements ORDER BY material_type_id').all(),key);
    const materials=group(db.prepare('SELECT * FROM recipe_materials ORDER BY material_type_id').all(),row=>row.blueprint_id);
    const levels=group(db.prepare('SELECT * FROM depth_cache ORDER BY type_id,side,level').all(),row=>`${row.type_id}:${row.side}`);
    const anchor=db.prepare('SELECT MAX(date) AS date FROM history').get().date??new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Shanghai'}).format(new Date());
    const history=group(db.prepare('SELECT * FROM history WHERE date>=? ORDER BY type_id,date').all(cutoff(anchor,30)),row=>row.type_id);
    const histories=new Map();
    for(const [id,rows] of history) {
      const prices={};for(const days of windows){const included=rows.filter(row=>row.date>=cutoff(anchor,days)),volume=included.reduce((n,row)=>n+row.volume,0);prices[days]=days===1?rows.at(-1).average:volume?included.reduce((n,row)=>n+row.average*row.volume,0)/volume:0;}
      const byDate=new Map(rows.map(row=>[row.date,row.volume]));
      const daily=Array.from({length:30},(_,i)=>({trade_date:cutoff(anchor,30-i),volume:byDate.get(cutoff(anchor,30-i))??0}));
      histories.set(id,{prices,daily,volume:Math.floor(rows.reduce((n,row)=>n+row.volume,0)/30)});
    }
    const empty={prices:Object.fromEntries(windows.map(w=>[w,0])),daily:[],volume:0};
    const offers=db.prepare("SELECT * FROM lp_exchange WHERE is_blocked='N' ORDER BY corporation_name_zh,corporation_id,offer_id").all().map(row=>{
      const recipe=recipes.get(row.type_id),output=recipe?.product_type_id??row.type_id,quantity=row.quantity*(recipe?.product_quantity??1);
      const quote=quotes.get(output)??{buy_price:0,sell_price:0};
      const h=histories.get(output)??empty,buy=execution(levels.get(`${output}:buy`),quantity,quote.buy_price);
      const required=[...(requirements.get(key(row))??[]).map(m=>({...m,material_kind:'兑换材料'})),...(materials.get(row.type_id)??[]).map(m=>({...m,quantity:m.quantity*row.quantity,material_kind:'制造材料'}))].map(m=>{
        const id=m.material_type_id,q=quotes.get(id)??{buy_price:0,sell_price:0},sell=execution(levels.get(`${id}:sell`),m.quantity,q.sell_price);
        return {corporation_id:row.corporation_id,offer_id:row.offer_id,type_id:id,quantity:m.quantity,item_name:name(items.get(id)),material_kind:m.material_kind,buy_price:q.buy_price,sell_price:q.sell_price,sell_available_volume:(levels.get(`${id}:sell`)??[]).reduce((n,l)=>n+l.volume,0),sell_execution_price:sell.price,sell_execution_coverage:sell.coverage,historical_prices:(histories.get(id)??empty).prices};
      });
      return calculateRankingOffer({...row,corporation_name:row.corporation_name_zh,faction_name:row.faction_name_zh,item_name:name(items.get(row.type_id)),is_blueprint:recipe?1:0,product_type_id:recipe?.product_type_id??null,product_name:recipe?name(items.get(output)):null,revenue_quantity:quantity,buy_price:quote.buy_price,sell_price:quote.sell_price,buy_execution_price:buy.price,buy_execution_coverage:buy.coverage,historical_price:h.prices[30],history_30:h.prices[30],history_15:h.prices[15],history_7:h.prices[7],history_3:h.prices[3],history_1:h.prices[1],daily_volume:h.volume,historical_prices:h.prices,daily_volumes:h.daily,materials:required});
    });
    // Defensive writer filter, in addition to the source query and public snapshot reader.
    const visible=filterLpRankingRows(offers,flags);
    const lists={popular:selectRankingRows(visible,'daily_volume'),highRatio:selectRankingRows(visible,'lp_ratio')};
    const now=new Date().toISOString(),date=new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
    db.exec('DELETE FROM ranking_cache');
    const insert=db.prepare('INSERT INTO ranking_cache VALUES(?,?,?,?,?)');
    for(const [kind,rows] of Object.entries(lists))rows.forEach((row,index)=>insert.run(kind,index+1,date,now,JSON.stringify(row)));
    const result={offers:visible.length,popular:lists.popular.length,highRatio:lists.highRatio.length,policy_revision:revision,history_complete:Boolean(db.prepare("SELECT last_success FROM tasks WHERE module='history'").get()?.last_success)};
    setState(db,'rankings',{...result,calculated_at:now});return result;
  });
}
