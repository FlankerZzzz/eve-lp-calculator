import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';

// Execute the actual page callbacks with controlled network promises and setters.
const page = await readFile(new URL('../app/page.tsx', import.meta.url), 'utf8');
const start = page.indexOf('  const loadOptions = useCallback(');
const end = page.indexOf('\n  useEffect(() => {', start);
const callbacks = ts.transpileModule(page.slice(start, end), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
}).outputText;
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
const response = data => ({ ok: true, json: async () => data });
const options = response({ factions: [], corporations: [], counts: {} });
const ranking = response({ popular: [], highRatio: [] });
function harness(fetch) {
  const state = { databaseState: 'CHECKING' };
  const env = {
    fetch, useCallback: fn => fn, offersRequestRef: { current: 0 }, optionsRequestRef: { current: null },
    corporationId: null, factionId: null, windowDays: 30, tax: 0, showBoosterBlueprints: false, showHighSecOnly: false,
  };
  for (const key of ['Loading', 'PopularOffers', 'HighRatioOffers', 'DetailOffers', 'ImplantSets', 'Status', 'DatabaseState']) {
    env[`set${key}`] = value => { state[key[0].toLowerCase() + key.slice(1)] = value; };
  }
  const make = overrides => {
    const values = { ...env, ...overrides };
    return new Function(...Object.keys(values), `${callbacks}; return {loadOptions, loadOffers};`)(...Object.values(values));
  };
  return { state, ...make(), make };
}

test('offers failure confirms connectivity once and preserves its data error', async () => {
  let probes = 0;
  const h = harness(async url => {
    if (url === '/api/data/options') { probes++; return options; }
    throw new Error('兑换请求失败');
  });
  await h.loadOffers();
  assert.equal(h.state.databaseState, 'ONLINE');
  assert.equal(h.state.status, '兑换请求失败');
  assert.equal(probes, 1);
  assert.equal(h.state.loading, false);
});

test('both endpoints failing goes offline; ranking and detail successes restore online without reload', async () => {
  let failing = true;
  const h = harness(async () => { if (failing) throw new Error('network'); return ranking; });
  await h.loadOffers();
  assert.equal(h.state.databaseState, 'OFFLINE');
  failing = false;
  await h.loadOffers();
  assert.equal(h.state.databaseState, 'ONLINE');
  h.state.databaseState = 'OFFLINE';
  const detail = h.make({ corporationId: 1, fetch: async () => response({ offers: [], total: 0 }) });
  await detail.loadOffers();
  assert.equal(h.state.databaseState, 'ONLINE');
});

test('older success, failure and aborted responses cannot overwrite current data or loading', async () => {
  for (const outcome of ['success', 'failure', 'abort']) {
    const old = deferred(), current = deferred();
    let calls = 0;
    const h = harness(() => ++calls === 1 ? old.promise : current.promise);
    const controller = new AbortController();
    const first = h.loadOffers(controller.signal);
    const second = h.loadOffers();
    if (outcome === 'abort') controller.abort();
    if (outcome === 'failure') old.reject(new Error('stale')); else old.resolve(ranking);
    await first;
    assert.equal(h.state.loading, true);
    assert.equal(h.state.databaseState, 'CHECKING');
    assert.equal(calls, 2);
    current.resolve(ranking);
    await second;
    assert.equal(h.state.databaseState, 'ONLINE');
    assert.equal(h.state.loading, false);
  }
});

test('bootstrap and repeated failures share one probe, and late probe failure cannot override recovery', async () => {
  const probe = deferred();
  let probes = 0, recovered = false;
  const h = harness(async url => {
    if (url === '/api/data/options') { probes++; return probe.promise; }
    if (recovered) return ranking;
    throw new Error('offers failed');
  });
  const bootstrap = h.loadOptions().catch(() => {});
  const first = h.loadOffers();
  await Promise.resolve();
  const second = h.loadOffers();
  await Promise.resolve();
  assert.equal(probes, 1);
  recovered = true;
  await h.loadOffers();
  probe.reject(new Error('old connectivity failure'));
  await Promise.all([bootstrap, first, second]);
  assert.equal(h.state.databaseState, 'ONLINE');
  assert.equal(h.state.loading, false);
});

test('malformed successful HTTP responses do not count as a successful offers load', async () => {
  const h = harness(async url => url === '/api/data/options' ? options : response({}));
  await h.loadOffers();
  assert.equal(h.state.status, '兑换数据格式错误');
  assert.equal(h.state.databaseState, 'ONLINE');
});

test('a response that becomes stale while JSON is parsing cannot replace a newer corporation result', async () => {
  const body = deferred();
  const h = harness(async () => ({ ok: true, json: () => body.promise }));
  const old = h.loadOffers();
  await Promise.resolve();
  const detail = h.make({ corporationId: 42, fetch: async () => response({ offers: [{ offer_id: 42 }], total: 1 }) });
  await detail.loadOffers();
  const status = h.state.status;
  body.resolve({ popular: [{ offer_id: 1 }], highRatio: [] });
  await old;
  assert.equal(h.state.status, status);
  assert.deepEqual(h.state.detailOffers, [{ offer_id: 42 }]);
  assert.deepEqual(h.state.popularOffers, []);
  assert.equal(h.state.databaseState, 'ONLINE');
});
