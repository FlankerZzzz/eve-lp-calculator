import test from 'node:test';
import assert from 'node:assert/strict';
import {selectRankingLists} from '../scripts/v2/rankings.mjs';

const offer=(id,highSec,score)=>({corporation_id:id,offer_id:id,type_id:id,quantity:1,lp_cost:10,isk_cost:0,materials:[],is_high_sec:highSec?'Y':'N',daily_volume:score,lp_ratio:score});
test('both exclude rankings select their own Top 100 from all eligible offers, not the global Top 100',()=>{
  const rows=[...Array.from({length:120},(_,i)=>offer(i+1,false,1000-i)),...Array.from({length:110},(_,i)=>offer(i+200,true,500-i))];
  const lists=selectRankingLists(rows);
  for(const kind of ['popular','highRatio']){
    assert.equal(lists[kind].length,100);assert.ok(lists[kind].every(row=>row.is_high_sec==='N'));
    assert.equal(lists[`${kind}_exclude`].length,100);assert.ok(lists[`${kind}_exclude`].every(row=>row.is_high_sec==='Y'));
    assert.equal(lists[`${kind}_exclude`][0].offer_id,200);assert.equal(lists[`${kind}_exclude`].at(-1).offer_id,299);
  }
  assert.equal(rows.length,230);
});
test('exclude scope deduplicates within its own candidates and the two boards rank by different metrics',()=>{
  const nonHigh=offer(1,false,100),high={...offer(2,true,100),type_id:1},other={...offer(3,true,50),daily_volume:200};
  const lists=selectRankingLists([nonHigh,high,other]);
  assert.deepEqual(lists.highRatio.map(row=>row.corporation_id),[1,3]);
  assert.deepEqual(lists.highRatio_exclude.map(row=>row.corporation_id),[2,3]);
  assert.deepEqual(lists.popular_exclude.map(row=>row.corporation_id),[3,2]);
  assert.deepEqual(selectRankingLists([]),{popular:[],highRatio:[],popular_exclude:[],highRatio_exclude:[]});
});
