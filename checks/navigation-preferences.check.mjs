import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {DEFAULT_NAVIGATION_PREFERENCES,NAVIGATION_COOKIE,parseNavigationPreferences,readNavigationPreferences,navigationPreferenceCookie} from '../lib/navigation-preferences.mjs';
test('first-use navigation defaults enable invasion and blacklist avoidance and prefer highsec',()=>{
  assert.equal(DEFAULT_NAVIGATION_PREFERENCES.avoidIncursions,true);assert.equal(DEFAULT_NAVIGATION_PREFERENCES.avoidList,true);
  assert.equal(DEFAULT_NAVIGATION_PREFERENCES.gateMode,'secure');assert.deepEqual(DEFAULT_NAVIGATION_PREFERENCES.modes,['secure']);
  assert.equal(DEFAULT_NAVIGATION_PREFERENCES.history,true);assert.equal(DEFAULT_NAVIGATION_PREFERENCES.gateLines,true);assert.equal(DEFAULT_NAVIGATION_PREFERENCES.npcStationsOnly,false);
});
test('cookies round-trip all switches, including explicitly false values and empty regular selections',()=>{
  const prefs=parseNavigationPreferences({gateMode:'insecure',history:false,gateLines:false,npcStationsOnly:true,avoidList:false,avoidIncursions:false,modes:[]});
  const cookie=navigationPreferenceCookie('jump',prefs);
  assert.deepEqual(readNavigationPreferences(cookie,'jump'),prefs);
  assert.match(cookie,/Path=\//);assert.match(cookie,/Max-Age=31536000/);assert.match(cookie,/SameSite=Lax; Secure$/);
  assert.doesNotMatch(navigationPreferenceCookie('regular',prefs,false),/; Secure/);
  assert.equal(readNavigationPreferences('','jump'),null);
});
test('regular and flagship cookies are independent and safely URL-encoded',()=>{
  assert.notEqual(NAVIGATION_COOKIE.regular,NAVIGATION_COOKIE.jump);
  const jump=navigationPreferenceCookie('jump',{gateMode:'shortest',modes:['insecure']}).split(';')[0];
  const regular=navigationPreferenceCookie('regular',{gateMode:'secure',modes:['secure','shortest']}).split(';')[0];
  assert.equal(readNavigationPreferences(jump+'; '+regular,'jump').gateMode,'shortest');
  assert.deepEqual(readNavigationPreferences(jump+'; '+regular,'regular').modes,['secure','shortest']);
  assert.equal(readNavigationPreferences('other_'+jump,'jump'),null);assert.throws(()=>readNavigationPreferences('', 'unknown'));
});
test('preference parser rejects corrupt settings and unsupported versions without coercing strings',()=>{
  for(const value of [null,[],{version:2},{gateLines:'false'},{avoidIncursions:0},{history:null},{gateMode:'unsafe'},{modes:'secure'},{modes:['unknown']},{modes:['secure','secure','secure','secure']}])assert.throws(()=>parseNavigationPreferences(value));
  assert.throws(()=>readNavigationPreferences(NAVIGATION_COOKIE.jump+'=%E0%A4%A','jump'));
  assert.throws(()=>readNavigationPreferences(NAVIGATION_COOKIE.jump+'=not-json','jump'));
  assert.throws(()=>readNavigationPreferences(NAVIGATION_COOKIE.jump+'='+'x'.repeat(3501),'jump'));
});
test('large local blocked lists never enter cookies; parser drops unknown data and deduplicates modes',()=>{
  const cookie=navigationPreferenceCookie('jump',{avoid:Array.from({length:500},(_,i)=>30000000+i),origin:30000001,modes:['secure','secure']});
  assert.ok(cookie.length<1000);assert.doesNotMatch(decodeURIComponent(cookie),/30000000|origin|"avoid":/);
  assert.deepEqual(readNavigationPreferences(cookie,'jump').modes,['secure']);
});
test('page preferences are restored before saving and malformed storage is preserved until user changes it',()=>{
  const hook=readFileSync(new URL('../app/navigation/use-navigation-avoid.ts',import.meta.url),'utf8');
  assert.match(hook,/readNavigationPreferences\(document.cookie,mode\)/);
  assert.match(hook,/if\(!ready\|\|!cookieWritable.current\)return/);
  assert.match(hook,/cookieWritable.current=false/);assert.match(hook,/legacyFlags\[key\]=value\[key\]/);
  assert.match(hook,/document.cookie=navigationPreferenceCookie/);assert.match(hook,/localStorage.setItem\(AVOID_STORAGE\[mode\]/);
});
test('regular modes use cookie preferences; flagship no longer consumes saved manual gate mode',()=>{
  const page=readFileSync(new URL('../app/navigation/page.tsx',import.meta.url),'utf8');
  assert.match(page,/gateLines,modes:enabled\}=preferences/);assert.match(page,/useState<Mode>\('secure'\)/);
  const jump=readFileSync(new URL('../app/navigation/jump/page.tsx',import.meta.url),'utf8');
  assert.match(jump,/\{npcStationsOnly,history,gateLines\}=preferences/);
  assert.match(jump,/const gateMode='shortest'/);
  assert.match(jump,/JSON.stringify\(\{\.\.\.nextPlan,shipId:ship.id,skills,npcStationsOnly,avoid\}\)/);
  assert.doesNotMatch(jump,/jump-gate-mode|过门路径偏好/);
});
