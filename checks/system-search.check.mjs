import test from 'node:test';
import assert from 'node:assert/strict';
import {indexSystemNames} from '../lib/system-search-index.mjs';
import {createSystemSearch,normalizeSystemQuery} from '../lib/system-search.mjs';
const systems=[{id:1,nameZh:'吉他',nameEn:'Jita'},{id:2,nameZh:'安帕纳克',nameEn:'Amarr'},{id:3,nameZh:'伊恩-奥斯塔',nameEn:'New Caldari'},{id:4,nameZh:'OMV-4W',nameEn:'OMV-4W'},{id:5,nameZh:'吉塔',nameEn:'Other'}];
test('server indexes once without mutation; all pickers share Chinese, English, full pinyin and initials',()=>{
  const indexed=indexSystemNames(systems);assert.equal(indexSystemNames(systems),indexed);assert.equal(systems[0].searchPinyin,undefined);
  const search=createSystemSearch(indexed);
  for(const query of ['吉他','JITA','ji ta','jǐ tā','ｊｉｔａ','jt','1'])assert.equal(search.find(query)[0].id,1,query);
  for(const query of ['安帕纳克','anpanake','a p n k','APNK'])assert.equal(search.find(query)[0].id,2,query);
  assert.equal(search.find('yienaosita')[0].id,3);assert.equal(search.find('new caldari')[0].id,3);assert.equal(search.find('omv4w')[0].id,4);
  assert.equal(search.exact('apnk').id,2);assert.equal(search.exact('jita').id,1,'literal English name wins over a pinyin alias');assert.equal(search.exact('jt'),null,'ambiguous initials cannot silently select a route point');assert.equal(createSystemSearch(indexed),search);
  assert.deepEqual(search.find(''),[]);assert.deepEqual(search.find('不存在'),[]);assert.equal(search.find('j',1).length,1);
});
test('direct Chinese/English/ID remain available for older catalogues without pinyin fields',()=>{
  const search=createSystemSearch(systems);assert.equal(search.exact('Jita').id,1);assert.equal(search.exact('4').id,4);assert.equal(normalizeSystemQuery('Lǜ-色'), 'lv色');
});
