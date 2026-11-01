'use strict';
/*
 * PRD section 12 performance with 50 hospitals (5 demo + 45 synthetic from seed/generate.js scale()):
 *   cover board < 2 s · plan ranking < 10 s (real OR-Tools matcher, forced re-sync included) · /me/home < 1 s
 * Timings are end-to-end HTTP calls against the in-memory SQLite test server; numbers go to the console
 * (copied into the README "Performance" section).
 */
require('./helpers/env')({ MATCHER_URL: 'http://localhost:5113', MATCHER_FALLBACK_ENABLED: 'false' });
const procs = require('./helpers/procs');
const cds = require('@sap/cds');
const T = cds.test(__dirname + '/..');
T.axios.defaults.validateStatus = () => true;
const gen = require('../../seed/generate');
const ingestH1 = require('./helpers/h1');

const as = user => ({ auth: { username: user, password: 'demo' } });
const results = {};
let matcher;

async function timed(label, fn, runs = 3) {
  const ms = [];
  let last;
  for (let i = 0; i < runs; i++) { const t0 = performance.now(); last = await fn(); ms.push(performance.now() - t0); }
  results[label] = { bestMs: Math.round(Math.min(...ms)), worstMs: Math.round(Math.max(...ms)) };
  return { last, worst: Math.max(...ms) };
}

beforeAll(async () => {
  matcher = await procs.startMatcher(5113);
  if (!matcher) throw new Error('Python with ortools/fastapi/uvicorn is required for the performance test');
  await ingestH1();
  const x = gen.scale(gen.anchorDate(), 50);
  await cds.tx(async () => {
    await INSERT.into('medilink.Hospitals').entries(x.HOSPITALS);
    await INSERT.into('medilink.Licences').entries(x.LICENCES);
    await INSERT.into('medilink.Lots').entries(x.capLots);
    await INSERT.into('medilink.Bookings').entries(x.capBookings);
  });
}, 90000);
afterAll(() => {
  procs.stop(matcher);
  console.log('[perf] 50 hospitals:', JSON.stringify(results));
});

test('50 hospitals are loaded', async () => {
  const n = (await cds.tx(() => SELECT.from('medilink.Hospitals'))).length;
  const lots = (await cds.tx(() => SELECT.from('medilink.Lots'))).length;
  expect(n).toBe(50);
  expect(lots).toBeGreaterThan(600);
});

test('cover board loads under 2 s', async () => {
  const { last, worst } = await timed('coverBoard', () => T.axios.get('/odata/v4/cover/board(window=14,hospital=null)', as('asha')));
  expect(last.status).toBe(200);
  expect(last.data.value.length).toBeGreaterThan(5);
  expect(worst).toBeLessThan(2000);
});

test('plans are ranked under 10 s across 50 hospitals (OR-Tools, forced re-sync)', async () => {
  const created = await T.axios.post('/odata/v4/requests/createRequest', { drug: 'D-CARB450' }, as('asha'));
  expect(created.status).toBe(200);
  expect(created.data.ranking.engine).toBe('ortools-cp-sat');
  expect(created.data.ranking.eligible).toBeGreaterThan(20); // many synthetic hospitals hold eligible stock
  const { last, worst } = await timed('planRanking', () => T.axios.post('/odata/v4/requests/rank', { request: created.data.request }, as('asha')));
  expect(last.status).toBe(200);
  expect(last.data.plans.length).toBeGreaterThan(0);
  expect(worst).toBeLessThan(10000);
});

test('/me/home answers under 1 s', async () => {
  const { last, worst } = await timed('meHome', () => T.axios.get('/me/home', as('asha')), 5);
  expect(last.status).toBe(200);
  expect(last.data.journeys.length).toBeGreaterThan(0);
  expect(worst).toBeLessThan(1000);
  const admin = await timed('meHomeAdmin', () => T.axios.get('/me/home', as('admin')));
  expect(admin.worst).toBeLessThan(1000);
});

test('city view over 50 hospitals stays fast', async () => {
  const { last, worst } = await timed('cityView', () => T.axios.get('/me/city', as('admin')));
  expect(last.status).toBe(200);
  expect(worst).toBeLessThan(2000);
});
