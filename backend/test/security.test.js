'use strict';
/*
 * Security model: every service is guarded, MediLink accounts know every role used in @requires/@restrict,
 * row-level restrictions follow $user.hospital, every profile signs in with MediLink accounts (couriers use a link).
 */
require('./helpers/env')();
const path = require('path');
const cds = require('@sap/cds');
const T = cds.test(__dirname + '/..');
T.axios.defaults.validateStatus = () => true;
const pkg = require('../package.json');
const { ROLES } = require('../srv/lib/accounts');
const as = user => ({ auth: { username: user, password: 'demo' } });

let model;
beforeAll(async () => { model = await cds.load(path.join(__dirname, '..', 'srv')); });

const rolesIn = def => {
  const out = new Set();
  const req = def['@requires']; (Array.isArray(req) ? req : req ? [req] : []).forEach(r => out.add(r));
  for (const r of def['@restrict'] || []) (Array.isArray(r.to) ? r.to : r.to ? [r.to] : []).forEach(x => out.add(x));
  return out;
};

test('every service has @requires', () => {
  const services = Object.values(model.definitions).filter(d => d.kind === 'service');
  expect(services.length).toBeGreaterThanOrEqual(15);
  for (const s of services) expect([s.name, s['@requires']]).toEqual([s.name, expect.anything()]);
});

test('MediLink accounts know every role used in the model', () => {
  const used = new Set();
  for (const d of Object.values(model.definitions)) for (const r of rolesIn(d)) used.add(r);
  used.delete('authenticated-user'); used.delete('any');
  expect([...used].sort()).toEqual([...ROLES].sort());
});

test('every profile signs in with MediLink accounts, never mocked users', () => {
  expect(pkg.cds.requires.auth).toEqual({ kind: 'custom', impl: 'srv/auth.js' });
  expect(cds.env.requires.auth).toMatchObject({ kind: 'custom', impl: 'srv/auth.js' });
  expect(cds.env.requires.auth.users).toBeUndefined();
});

test('unauthenticated calls are refused; health stays public', async () => {
  expect((await T.axios.get('/odata/v4/cover/board(window=14,hospital=null)')).status).toBe(401);
  expect((await T.axios.get('/audit/verify')).status).toBe(401);
  expect((await T.axios.get('/health')).status).toBe(200);
});

test('row-level restrictions: a pharmacist sees only their own hospital', async () => {
  const lots = (await T.axios.get('/odata/v4/cover/Lots', as('ravi'))).data.value;
  expect(lots.length).toBeGreaterThan(0);
  expect(lots.every(l => l.hospital_ID === 'H5')).toBe(true);
  expect((await T.axios.get("/odata/v4/cover/board(window=14,hospital='H2')", as('ravi'))).status).toBe(403);
});

test('only parties to a shipment can toggle its route', async () => {
  const t = 'a0000000-0000-4000-8000-000000000001'; // H2 -> H3, partner P1
  const r = await T.axios.post('/odata/v4/routes/setRouteClosed', { transfer: t, closed: true }, as('asha'));
  expect(r.status).toBe(403);
  expect(r.data.error.message).toMatch(/NOT_A_PARTY/);
  expect((await T.axios.post('/odata/v4/routes/setRouteClosed', { transfer: t, closed: true }, as('courier2'))).status).toBe(401); // no courier accounts
  expect((await T.axios.post('/odata/v4/routes/setRouteClosed', { transfer: t, closed: true }, as('meera'))).status).toBe(403); // approvers don't drive routes
  expect((await T.axios.post('/odata/v4/routes/setRouteClosed', { transfer: t, closed: true, note: 'demo' }, as('lata'))).status).toBe(200);
});

test('no city-wide GPS / temperature feed: ReceiptService.ConditionLogs is gone (audit F2)', async () => {
  expect((await T.axios.get('/odata/v4/receipt/ConditionLogs', as('asha'))).status).toBe(404);
  expect((await T.axios.get('/odata/v4/receipt/Incoming', as('lata'))).data.value.every(x => x.receiver_ID === 'H3')).toBe(true);
});
