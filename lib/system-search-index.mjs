import {pinyin} from 'pinyin-pro';
const cache=new WeakMap();
// Server-only transliteration: keep the dictionary out of the browser bundle.
export function indexSystemNames(systems){
  if(cache.has(systems))return cache.get(systems);
  const result=systems.map(s=>{const syllables=pinyin(s.nameZh,{toneType:'none',type:'array',nonZh:'consecutive',v:true});return {...s,searchPinyin:syllables.join(''),searchInitials:syllables.map(part=>/^[a-z]+$/i.test(part)?part[0]:part).join('')};});
  cache.set(systems,result);return result;
}
