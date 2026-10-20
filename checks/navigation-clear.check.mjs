import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';

const page=readFileSync(new URL('../app/navigation/page.tsx',import.meta.url),'utf8');
const map=readFileSync(new URL('../app/navigation/star-map.tsx',import.meta.url),'utf8');
const clear=page.match(/const clearNavigation=useCallback\(\(\)=>\{([\s\S]*?)\},\[\]\)/)?.[1];

test('regular clear removes every navigation point and result, invalidating pending requests first',()=>{
  assert.ok(clear);
  const sequence={current:4},keys={current:12},state={},order=[];
  const abort=kind=>({current:{abort(){order.push(kind);assert.equal(sequence.current,5);}}});
  const routeAbort=abort('route'),activityAbort=abort('activity');
  const setters=['Points','Bundle','Activities','Submitted','Loading','LoadingActivity','Error','ActivityError','Selected','Menu','MapTarget'];
  const run=new Function('sequence','keys','routeAbort','activityAbort',...setters.map(s=>'set'+s),clear);
  run(sequence,keys,routeAbort,activityAbort,...setters.map(s=>value=>{order.push(s);state[s]=value;}));
  assert.deepEqual(order.slice(0,2),['route','activity']);
  assert.equal(routeAbort.current,null);assert.equal(activityAbort.current,null);
  assert.deepEqual(state.Points,[{key:13,text:'',id:null},{key:14,text:'',id:null}]);
  for(const name of ['Bundle','Activities','Selected','Menu','MapTarget'])assert.equal(state[name],null);
  for(const name of ['Submitted','Error','ActivityError'])assert.equal(state[name],'');
  for(const name of ['Loading','LoadingActivity'])assert.equal(state[name],false);
  assert.doesNotMatch(clear,/setPreferences|setAvoid|setDimension|setColorMode|setRouteViewRequest|\.reset\(|\.focus\(/);
  assert.match(page,/if\(token!==sequence.current\)return;setBundle/);
  assert.match(page,/if\(token===sequence.current\)setActivities/);
});

test('drafts and empty intermediate slots can be cleared; empty initial form is disabled',()=>{
  const expression=page.match(/const hasCalculation=(.*);/)?.[1];
  assert.ok(expression);
  const active=new Function('points','bundle','loading',`return ${expression}`);
  const empty=[{key:1,text:'',id:null},{key:2,text:'',id:null}];
  assert.equal(active(empty,null,false),false);
  assert.equal(active([{...empty[0],text:'draft'},empty[1]],null,false),true);
  assert.equal(active([{...empty[0],id:1},empty[1]],null,false),true);
  assert.equal(active([...empty,{key:3,text:'',id:null}],null,false),true);
  assert.equal(active(empty,{routes:[]},false),true);
  assert.equal(active(empty,null,true),true);
  assert.match(page,/hasCalculation=\{hasCalculation\} onClearCalculation=\{clearNavigation\} clearCalculationLabel="清除导航"/);
  assert.match(page,/desktop===false&&<button type="button" disabled=\{!hasCalculation\} onClick=\{clearNavigation\}>清除导航/);
});

test('removing route overlays does not restore the previous overview camera',()=>{
  const branch=map.match(/if\(wasFocused&&!focus\)\{(.*)\}\n      else if\(refit&&policy.fitRoutes/)?.[1];
  assert.ok(branch);
  const run=new Function('routes',`let overview={};${branch};return overview;`);
  // Camera/reset bindings are deliberately absent: clearing must not touch either.
  assert.equal(run([]),null);
  assert.match(map,/compass.setCalculation\(extraCallbacks.current.hasCalculation,extraCallbacks.current.clearCalculationLabel\)/);
  assert.match(map,/clearCalculationLabel='清除计算'/);
});
