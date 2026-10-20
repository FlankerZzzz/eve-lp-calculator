import test from 'node:test';
import assert from 'node:assert/strict';
import {navigationGraph,findGateRoute,calculateNavigation,validateNavigationRequest} from '../lib/navigation.mjs';
import {createNavigationFeed,activityForSystems} from '../lib/navigation-activity.mjs';
const system=(id,security=.9,regionId=1)=>({id,security,regionId,nameZh:`星系${id}`});
const graph=()=>navigationGraph({systems:[system(1),system(2,.3),system(3),system(4),system(5),system(6,-.1),system(7)],gates:[[1,2],[2,5],[1,3],[3,4],[4,5],[2,6],[6,5]]});
const req=(override={})=>({points:[1,5],modes:['secure','shortest','insecure'],avoid:[],triglavian:[],edencom:[],avoidTriglavian:false,avoidEdencom:false,avoidIncursions:false,...override});
test('navigation preferences: shortest BFS-equivalent, high-sec detour, low/null preference',()=>{
  const g=graph();assert.deepEqual(findGateRoute(g,1,5,'shortest'),[1,2,5]);
  assert.deepEqual(findGateRoute(g,1,5,'secure'),[1,3,4,5]);
  assert.deepEqual(findGateRoute(g,1,5,'insecure'),[1,2,5]);
  assert.equal(findGateRoute(g,1,7,'secure'),null);assert.deepEqual(findGateRoute(g,1,1,'shortest'),[1]);
});
test('navigation high/low boundary uses displayed security; preferences are not strict prohibitions',()=>{
  const g=navigationGraph({systems:[system(1,.5),system(2,.45),system(3,.449),system(4,.2)],gates:[[1,2],[2,4],[1,3],[3,4]]});
  assert.deepEqual(findGateRoute(g,1,4,'secure'),[1,2,4]);assert.deepEqual(findGateRoute(g,1,4,'insecure'),[1,3,4]);
});
test('navigation respects avoid list, refuses blocked endpoints and waypoints; does not silently relax',()=>{
  const g=graph();assert.deepEqual(findGateRoute(g,1,5,'shortest',new Set([2])),[1,3,4,5]);
  assert.equal(findGateRoute(g,1,5,'shortest',new Set([2,3])),null);
  assert.throws(()=>calculateNavigation(g,req({avoid:[1]})),/已被规避/);
  assert.throws(()=>calculateNavigation(g,req({points:[1,2,5],avoid:[2]})),/已被规避/);
  assert.ok(calculateNavigation(g,req({avoid:[2,3]})).every(r=>r.error));
});
test('ordered waypoints and repeated systems retain each leg; same-origin has zero jumps',()=>{
  const g=graph(),r=calculateNavigation(g,req({points:[1,4,1,5],modes:['shortest']}))[0];
  assert.deepEqual(r.ids,[1,3,4,3,1,2,5]);assert.equal(r.jumps,6);assert.deepEqual(r.legs.map(l=>l.jumps),[2,2,2]);
  assert.equal(calculateNavigation(g,req({points:[1,1]}))[0].jumps,0);
});
test('special avoid toggles are conditional, manual EDENCOM and live incursions enforced',()=>{
  const g=graph();assert.deepEqual(calculateNavigation(g,req({triglavian:[2],edencom:[3]}))[1].ids,[1,2,5]);
  assert.deepEqual(calculateNavigation(g,req({triglavian:[2],avoidTriglavian:true}))[1].ids,[1,3,4,5]);
  assert.deepEqual(calculateNavigation(g,req({edencom:[2],avoidEdencom:true}))[1].ids,[1,3,4,5]);
  assert.deepEqual(calculateNavigation(g,req({avoidIncursions:true}),[2])[1].ids,[1,3,4,5]);
  const p=navigationGraph({systems:[system(1),system(2,.2,10000070),system(3)],gates:[[1,2],[2,3]]});
  assert.ok(calculateNavigation(p,req({points:[1,3],avoidTriglavian:true}))[0].error);
});
test('request validation bounds work, rejects invalid IDs and switches, cannot choose arbitrary URL',()=>{
  const g=graph();assert.deepEqual(validateNavigationRequest(req(),g),req());
  for(const bad of [null,[],req({points:[1]}),req({points:Array(13).fill(1)}),req({points:[1,'5']}),req({modes:[]}),req({modes:['wrong']}),req({modes:['secure','secure']}),req({avoid:[999]}),req({avoid:Array(501).fill(2)}),req({avoidIncursions:'false'})])assert.throws(()=>validateNavigationRequest(bad,g));
});
test('Dijkstra agrees with exhaustive simple paths for each preference on random small graphs',()=>{
  let seed=73;const random=()=>{seed=(seed*1664525+1013904223)>>>0;return seed/2**32;};
  for(let trial=0;trial<40;trial++) {
    const systems=Array.from({length:7},(_,id)=>system(id,[.8,.3,-.1][Math.floor(random()*3)])),gates=[];
    for(let a=0;a<7;a++)for(let b=a+1;b<7;b++)if(random()<.32)gates.push([a,b]);
    const g=navigationGraph({systems,gates});
    for(const mode of ['secure','shortest','insecure']){
      let best=Infinity;const penalty=8;
      const walk=(id,seen,cost)=>{if(cost>=best)return;if(id===6){best=cost;return;}for(const next of g.adjacent.get(id)){if(seen.has(next))continue;const high=systems[next].security>=.45,extra=(mode==='secure'&&!high)||(mode==='insecure'&&high);walk(next,new Set([...seen,next]),cost+1+(extra?penalty:0));}};walk(0,new Set([0]),0);
      const route=findGateRoute(g,0,6,mode);if(best===Infinity){assert.equal(route,null);continue;}
      const cost=route.slice(1).reduce((v,id)=>{const high=systems[id].security>=.45;return v+1+(((mode==='secure'&&!high)||(mode==='insecure'&&high))?penalty:0);},0);assert.equal(cost,best);
    }
  }
});
const date=Date.UTC(2026,9,12,12),headers=(offset=0)=>({'last-modified':new Date(date+offset).toUTCString(),expires:new Date(date+3600000+offset).toUTCString()});
test('activity single-flight shares one upstream request among concurrent users and respects expiry',async()=>{
  let calls=0,clock=date+1000;const feed=createNavigationFeed({now:()=>clock,fetcher:async()=>{calls++;await new Promise(r=>setTimeout(r,5));return Response.json([{system_id:1,ship_jumps:10}],{headers:headers()});}});
  const rows=await Promise.all(Array.from({length:20},()=>feed.load('system_jumps')));assert.equal(calls,1);assert.equal(rows[0].rows[0].ship_jumps,10);
  await feed.load('system_jumps');assert.equal(calls,1);clock+=3600000;await feed.load('system_jumps');assert.equal(calls,2);
});
test('activity failures are unavailable, backoff avoids storms; partial endpoint failures do not zero counts',async()=>{
  let calls=0;const feed=createNavigationFeed({now:()=>date,fetcher:async()=>{calls++;return new Response('',{status:503});}});
  const failure=await feed.load('system_kills');assert.equal(failure.rows,null);assert.match(failure.error,/503/);await feed.load('system_kills');assert.equal(calls,1);
  const rows=activityForSystems({rows:[{system_id:1,ship_jumps:7}]},failure,[1,2]);assert.equal(rows[1].jumps,7);assert.equal(rows[2].jumps,0);assert.equal(rows[1].ships,null);
});
test('activity carries stale batches through cache hits and preserves timestamps on refresh failure',async()=>{
  let clock=date+7200000,fail=false;const feed=createNavigationFeed({now:()=>clock,fetcher:async()=>fail?new Response('',{status:429}):Response.json([{system_id:1,ship_jumps:9}],{headers:headers()})});
  const old=await feed.load('system_jumps');assert.equal(old.stale,true);assert.equal((await feed.load('system_jumps')).stale,true);
  clock+=61000;fail=true;const failed=await feed.load('system_jumps');assert.equal(failed.rows[0].ship_jumps,9);assert.equal(failed.modified,old.modified);assert.equal(failed.stale,true);
});
test('invalid upstream statistics and absent timestamps are rejected instead of fabricated zeros',async()=>{
  for(const response of [()=>Response.json([{system_id:1,ship_jumps:-1}],{headers:headers()}),()=>Response.json([{system_id:1,ship_jumps:2}]),()=>Response.json({}),()=>Response.json([{infested_solar_systems:['1']}],{headers:headers()})]){
    const f=createNavigationFeed({now:()=>date,fetcher:async()=>response()});assert.equal((await f.load(response.toString().includes('infested')?'incursions':'system_jumps')).rows,null);
  }
});
