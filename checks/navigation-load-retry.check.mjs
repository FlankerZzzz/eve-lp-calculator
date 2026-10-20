import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
const page=readFileSync(new URL('../app/navigation/page.tsx',import.meta.url),'utf8');
test('regular catalog and map failures offer independent abortable no-store retries',()=>{
  assert.match(page,/setCatalogAttempt\(n=>n\+1\)/);assert.match(page,/setMapAttempt\(n=>n\+1\)/);
  assert.match(page,/\[catalogAttempt\]/);assert.match(page,/\[desktop,data,mapAttempt\]/);
  assert.match(page,/fetch\('\/api\/navigation\/catalog',\{signal:abort.signal,cache:'no-store'\}/);
  assert.match(page,/fetch\('\/api\/data\/star-map',\{signal:abort.signal,cache:'no-store'\}/);
  assert.match(page,/if\(!abort.signal.aborted\)setSystems\(body.systems\)/);
  assert.match(page,/if\(!abort.signal.aborted\)\{setMapBusy\(false\);setData\(body\);\}/);
  assert.match(page,/disabled=\{catalogBusy\}.*重试星系列表/);
  assert.match(page,/disabled=\{mapBusy\}.*重试星图/);
});
test('retry effects do not clear user points, modes, avoidance settings or computed routes',()=>{
  const start=page.indexOf('const abort=new AbortController();setCatalogBusy(true)'),end=page.indexOf('useEffect(()=>()=>{sequence.current++',start);
  assert.ok(start>0&&end>start);
  const effects=page.slice(start,end);
  assert.doesNotMatch(effects,/setPoints|setEnabled|setAvoid|setBundle|setSubmitted|setError\(/);
  assert.match(page,/if\(!desktop\|\|data\)return/);
});
