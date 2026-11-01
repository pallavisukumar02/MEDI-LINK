'use strict';
/*
 * Stock and expiry monitoring (lib/monitor.js) and the alert plumbing around it:
 *   reorder levels and defaults, expiry tiers (tightest only), expired lots, dedupe across runs, re-alert after
 *   recovery, LOW -> OUT, auto-resolve, acknowledge; per-hospital email routing + one digest per hospital per run;
 *   GET /me/stock, /me/notifications, the three actions and who may use them; licence reminders once per tier;
 *   coverdb.nearExpiry; audit fixes F6 (duplicate batch rows), F12 (notifications read-only), F13 (photo merges),
 *   F14 (IT setup link emailed / not claimed), F21 (safety margin: approver or admin).
 * All data is the synthetic seed (H5 = ravi / meera / kiran, H1 = asha, H4 = hari, H3 = lata).
 */
require('./helpers/env')();
const cds = require('@sap/cds');
const T = cds.test(__dirname + '/..');
T.axios.defaults.validateStatus = () => true;
const config = require('../srv/lib/config');
const notify = require('../srv/lib/notify');
const monitor = require('../srv/lib/monitor');
const ws = require('../srv/lib/ws');

const as = user => ({ auth: { username: user, password: 'demo' } });
const get = (url, user) => T.axios.get(url, as(user));
const act = (user, id, body = {}) => T.axios.post(`/me/actions/${id}`, body, as(user));
const db = fn => cds.tx(fn);
const run = ids => db(() => monitor.run(ids));
const day = n => new Date(Date.now() + n * 86400000).toISOString().slice(0, 10);
const tick = () => new Promise(r => setTimeout(r, 80));
const openRows = h => db(() => SELECT.from('medilink.Notifications').where({ hospital_ID: h, dedupeKey: { '!=': null } }));
const openOf = async (h, ref) => (await openRows(h)).find(r => r.ref === ref);
const withEnv = async (env, fn) => {
  const old = Object.fromEntries(Object.keys(env).map(k => [k, process.env[k]]));
  Object.assign(process.env, env); config.reload();
  try { return await fn(); } finally { for (const [k, v] of Object.entries(old)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } config.reload(); }
};
const SMTP = { SMTP_HOST: 'smtp.example.test', SMTP_PORT: '587', ALERT_EMAIL_FROM: 'medilink@example.test', ALERT_EMAIL_TO: 'ops@example.test' };
let sent = [];
beforeAll(() => notify.setMailer({ sendMail: async m => { sent.push(m); return { messageId: 'x' }; } }));
beforeEach(() => { sent = []; });
afterAll(() => notify.setMailer(undefined));

describe('assess (pure)', () => {
  const today = '2026-11-01';
  const drugs = { A: { ID: 'A', genericName: 'Alpha', strength: '1 mg', reorderLevel: 5 }, B: { ID: 'B', genericName: 'Beta', strength: '2 mg', reorderLevel: null }, C: { ID: 'C', genericName: 'Gamma', strength: '3 mg', reorderLevel: 2 } };
  const lot = (ID, drug_ID, quantity, days, extra = {}) => ({ ID, hospital_ID: 'X', drug_ID, quantity, expiryDate: new Date(Date.parse(today) + days * 86400000).toISOString().slice(0, 10), sealed: true, quarantined: false, batchNo: ID, ...extra });
  const ctx = lots => ({ lots, drugs, isFlagged: l => l.batchNo === 'FLAGGED' });

  test('tiers: only the tightest reached; outside every tier = no alert', () => {
    expect([100, 91, 90, 85, 60, 31, 30, 20, 8, 7, 5, 1].map(d => monitor.tierOf(d))).toEqual([null, null, 90, 90, 60, 60, 30, 30, 30, 7, 7, 7]);
    expect(monitor.tierOf(20, [30, 7])).toBe(30);
    expect(monitor.expiryTiers()).toEqual([90, 60, 30, 7]);
  });

  test('reorder level: hospital level beats the drug default; neither = not watched; on hand = usable units only', () => {
    const rows = monitor.assess(ctx([
      lot('a1', 'A', 3, 200), lot('a2', 'A', 9, 200, { sealed: false }), lot('a3', 'A', 9, 200, { quarantined: true }), lot('a4', 'A', 9, 200, { batchNo: 'FLAGGED' }),
      lot('b1', 'B', 0, 200), lot('c1', 'C', 3, 200),
    ]), 'X', { C: 4 }, [], today);
    const by = Object.fromEntries(rows.map(r => [r.drugId, r]));
    expect(by.A).toMatchObject({ onHand: 3, threshold: 5, thresholdSource: 'default', status: 'low' });
    expect(by.B).toMatchObject({ onHand: 0, threshold: null, thresholdSource: null, status: 'untracked' });
    expect(by.C).toMatchObject({ onHand: 3, threshold: 4, thresholdSource: 'hospital', status: 'low' });
    expect(monitor.conditions('X', rows).filter(c => c.dedupeKey.startsWith('STOCK:')).map(c => c.ref).sort()).toEqual(['A', 'C']);
    expect(by.A.lots).toEqual([]); // no expiry problem
  });

  test('out of stock, expiring tiers, expired lots; worst first', () => {
    const rows = monitor.assess(ctx([
      lot('a85', 'A', 10, 85), lot('a25', 'A', 2, 25), lot('a5', 'A', 1, 5), lot('a120', 'A', 4, 120),
      lot('cx', 'C', 3, -3), lot('cq', 'C', 3, -3, { quarantined: true }), lot('c0', 'C', 0, -9), lot('ct', 'C', 2, 0),
    ]), 'X', {}, ['B'], today);
    expect(rows.map(r => [r.drugId, r.status, r.severity])).toEqual([['C', 'out', 'HIGH'], ['A', 'ok', 'HIGH'], ['B', 'untracked', null]]);
    const [c, a] = rows;
    expect(a.lots.map(l => [l.lotId, l.tier, l.status, l.nearExpiry, l.spare, l.severity])).toEqual([['a5', 7, 'expiring', true, 1, 'HIGH'], ['a25', 30, 'expiring', true, 2, 'MEDIUM'], ['a85', 90, 'expiring', false, 0, 'LOW']]);
    expect(c.lots.map(l => [l.lotId, l.tier, l.daysLeft])).toEqual([['cx', 0, -3], ['ct', 0, 0]]); // quarantined or empty expired lots are not alerted
    const conds = monitor.conditions('X', rows);
    expect(conds.find(x => x.ref === 'cx')).toMatchObject({ kind: 'EXPIRED', severity: 'HIGH', tier: 0, dedupeKey: 'LOT:X:cx', message: expect.stringMatching(/Take it off the shelf and quarantine it\.$/) });
    expect(conds.find(x => x.ref === 'a25').message).toMatch(/offer it as surplus to nearby hospitals\.$/);
    expect(conds.find(x => x.ref === 'a85').message).toMatch(/expires on .*\. Use it first\.$/);
    expect(conds.find(x => x.ref === 'C')).toMatchObject({ kind: 'OUT_OF_STOCK', severity: 'HIGH', message: 'Gamma 3 mg is out of stock (reorder level 2). Reorder now.' });
  });
});

describe('surplus suggestion', () => {
  test('a near-expiry lot needed for the hospital\'s own bookings is not offered as surplus', () => {
    const lot = { ID: 'n1', hospital_ID: 'X', drug_ID: 'A', quantity: 4, expiryDate: '2026-11-11', sealed: true, quarantined: false, batchNo: 'N1' };
    const ctx = { lots: [lot], drugs: { A: { ID: 'A', genericName: 'Alpha', strength: '1 mg', reorderLevel: 2 } }, isFlagged: () => false,
      bookings: [{ ID: 'b1', hospital_ID: 'X', drug_ID: 'A', doseUnits: 4, scheduledDate: '2026-11-03' }], hospitals: [{ ID: 'X', coverWindowDays: 14, safetyMarginPct: 20 }] };
    const rows = monitor.assess(ctx, 'X', {}, [], '2026-11-01');
    expect(rows[0].lots[0]).toMatchObject({ tier: 30, nearExpiry: true, spare: 0 });
    expect(monitor.conditions('X', rows).find(c => c.ref === 'n1').message).toBe('Batch N1 of Alpha 1 mg (4 vials) expires on 11 Nov 2026. Use it first.');
  });
});

describe('monitoring runs', () => {
  test('nearExpiry lists usable lots inside the window, soonest first (expired and far lots left out)', async () => {
    const list = await db(() => require('../srv/lib/coverdb').nearExpiry('H5', 60));
    expect(list.map(l => [l.lotId, l.daysToExpiry])).toEqual([['H5-BORT2-X', 5], ['H5-RITU500-X', 25], ['H5-CARB-A', 45]]);
    for (const l of list) expect(l.surplus).toBeGreaterThanOrEqual(0);
  });

  test('first run: each condition alerts once; one digest per hospital, to that hospital\'s own people only', async () => {
    expect((await act('ravi', 'set-alert-email', { email: ' Ravi.H5@Example.org ' })).data).toMatchObject({ ok: true, result: { email: 'ravi.h5@example.org' } });
    const admin = as('admin');
    expect((await T.axios.post('/auth/users/meera/email', { email: 'meera.h5@example.org' }, admin)).data).toMatchObject({ username: 'meera', email: 'meera.h5@example.org' });
    await T.axios.post('/auth/users/kiran/email', { email: 'kiran.h5@example.org' }, admin);
    await T.axios.post('/auth/users/kiran/disable', null, admin); // disabled people get nothing
    await act('asha', 'set-alert-email', { email: 'asha.h1@example.org' });
    expect((await act('ravi', 'set-alert-email', { email: 'not-an-email' })).data.code).toBe('INVALID_EMAIL');
    expect((await T.axios.post('/auth/users/meera/email', { email: 'x' }, as('ravi'))).status).toBe(403);

    const events = [];
    const listen = (e, d) => events.push([e, d]);
    ws.listeners.add(listen);
    const raised = await withEnv(SMTP, async () => { const r = await run(); await tick(); return r; });
    ws.listeners.delete(listen);

    const h5 = raised.filter(r => r.hospital_ID === 'H5');
    expect(h5.map(r => `${r.kind}:${r.ref}:${r.severity}:${r.tier ?? ''}`).sort()).toEqual([
      'EXPIRED:H5-TRAS-X:HIGH:0', 'EXPIRING:H5-BORT2-X:HIGH:7', 'EXPIRING:H5-CARB-A:LOW:60', 'EXPIRING:H5-GEMC1G-X:LOW:90', 'EXPIRING:H5-RITU500-X:MEDIUM:30',
      'LOW_STOCK:D-5FU500:MEDIUM:', 'OUT_OF_STOCK:D-TRAS440:HIGH:',
    ]);
    expect(raised.some(r => r.hospital_ID === 'H1')).toBe(false); // H1 has not sent stock yet
    expect(events.filter(([e, d]) => e === 'alert' && d.hospitalId === 'H5' && d.notificationId).length).toBe(7);

    const hospitals = [...new Set(raised.map(r => r.hospital_ID))].sort();
    const mailHospital = m => /\((H\d+)\)$/.exec(m.subject)[1];
    expect(sent.map(mailHospital).sort()).toEqual(hospitals); // exactly one email per hospital with new alerts
    const h5mail = sent.find(m => mailHospital(m) === 'H5');
    expect(h5mail.to.split(', ').sort()).toEqual(['meera.h5@example.org', 'ravi.h5@example.org']);
    expect(h5mail.subject).toBe('MediLink: 7 new alerts (H5)');
    expect(h5mail.text).toMatch(/^MediLink found 7 new alerts for your hospital:\n- /);
    for (const r of h5) expect(h5mail.text).toContain(`- ${r.message}`);
    for (const m of sent.filter(x => x !== h5mail)) expect(m.to).toBe(`admin.${mailHospital(m).toLowerCase()}@example.org`); // no staff email there yet
    expect(sent.map(m => m.to).join()).not.toMatch(/asha|kiran/);
  });

  test('second run: nothing new, nothing sent', async () => {
    const before = (await openRows('H5')).length;
    const raised = await withEnv(SMTP, async () => { const r = await run(); await tick(); return r; });
    expect(raised).toEqual([]);
    expect(sent).toEqual([]);
    expect((await openRows('H5')).length).toBe(before);
  });

  test('a lot first seen inside 30 days alerts once for tier 30; tighter tiers and expiry alert again; a correction is quiet', async () => {
    const { ingestSnapshot } = require('../srv/lib/ingest');
    const row = { lotRef: 'H4-RITU-T', drugId: 'D-RITU500', brandName: 'Rituvia', manufacturer: 'Nandi Biologics (synthetic)', batchNo: 'RITU24T020', quantity: 3, expiryDate: day(20), sealed: true };
    await db(() => ingestSnapshot('H4', 'SHEET', { lots: [row] }, { actor: 'test', merge: true }));
    const first = await openOf('H4', 'H4-RITU-T');
    expect(first).toMatchObject({ kind: 'EXPIRING', tier: 30, dedupeKey: 'LOT:H4:H4-RITU-T' });
    const all = await db(() => SELECT.from('medilink.Notifications').where('ref =', 'H4-RITU-T'));
    expect(all.length).toBe(1); // not 90, 60 and 30

    await db(() => UPDATE('medilink.Lots').set({ expiryDate: day(5) }).where({ ID: 'H4-RITU-T' }));
    expect((await run(['H4'])).map(r => [r.ref, r.tier])).toEqual([['H4-RITU-T', 7]]);
    const old = await db(() => SELECT.one.from('medilink.Notifications').where({ ID: first.ID }));
    expect(old.dedupeKey).toBeNull();
    expect(old.resolvedAt).toBeTruthy();

    await db(() => UPDATE('medilink.Lots').set({ expiryDate: day(-1) }).where({ ID: 'H4-RITU-T' }));
    expect((await run(['H4'])).map(r => [r.kind, r.ref, r.tier])).toEqual([['EXPIRED', 'H4-RITU-T', 0]]);

    await db(() => UPDATE('medilink.Lots').set({ expiryDate: day(20) }).where({ ID: 'H4-RITU-T' })); // expiry date corrected
    expect(await run(['H4'])).toEqual([]);
    expect(await openOf('H4', 'H4-RITU-T')).toMatchObject({ kind: 'EXPIRING', tier: 30 });
  });

  test('low stock alerts again only after it recovered; LOW -> OUT escalates; OUT -> LOW is quiet; gone = resolved', async () => {
    const qty = q => db(() => UPDATE('medilink.Lots').set({ quantity: q }).where({ ID: 'H5-5FU500-1' }));
    const low1 = await openOf('H5', 'D-5FU500');
    expect(low1.kind).toBe('LOW_STOCK');
    await qty(20);
    expect(await run(['H5'])).toEqual([]);
    expect(await openOf('H5', 'D-5FU500')).toBeUndefined();
    await qty(5);
    const again = await run(['H5']);
    expect(again.map(r => [r.kind, r.ref])).toEqual([['LOW_STOCK', 'D-5FU500']]);
    expect(again[0].ID).not.toBe(low1.ID);
    await qty(0);
    expect((await run(['H5'])).map(r => [r.kind, r.severity])).toEqual([['OUT_OF_STOCK', 'HIGH']]);
    expect((await db(() => SELECT.one.from('medilink.Notifications').where({ ID: again[0].ID }))).resolvedAt).toBeTruthy();
    await qty(3);
    expect(await run(['H5'])).toEqual([]);
    expect(await openOf('H5', 'D-5FU500')).toMatchObject({ kind: 'LOW_STOCK', severity: 'MEDIUM', message: expect.stringMatching(/running low: 3 left \(reorder level 8\)/) });

    await db(() => DELETE.from('medilink.Lots').where({ ID: 'H5-BORT2-X' }));
    expect(await run(['H5'])).toEqual([]);
    expect(await openOf('H5', 'H5-BORT2-X')).toBeUndefined();
    const audit = (await get('/audit/Entries?$orderby=seq', 'admin')).data.filter(e => e.action === 'STOCK_ALERTS');
    expect(audit.length).toBeGreaterThan(0);
  });

  test('the scheduled sync cycle checks stock and expiry after the cover recompute', async () => {
    const r = await T.axios.post('/odata/v4/admin/runJobs', {}, as('admin'));
    expect(r.status).toBe(200);
    const out = JSON.parse(r.data.value);
    expect(Object.keys(out).slice(0, 5)).toEqual(['sync', 'recompute', 'monitor', 'stale', 'licences']);
    expect(out.monitor).toBe(0); // everything was already alerted
  });

  test('licence reminders: one per tier (not one a day), closed when renewed', async () => {
    const sync = require('../srv/lib/sync');
    const watch = (now = new Date()) => db(() => sync.licenceWatch(now));
    const valid = d => db(() => UPDATE('medilink.Licences').set({ validTill: d }).where({ ID: 'LIC-H2' }));
    await valid(day(20));
    expect(await watch()).toEqual(['LIC-H2']);
    expect(await watch()).toEqual([]);
    expect(await watch(new Date(Date.now() + 86400000))).toEqual([]); // next day: still one reminder
    expect((await openOf('H2', 'LIC:LIC-H2')).tier).toBe(30);
    await valid(day(5));
    expect(await watch()).toEqual(['LIC-H2']);
    expect((await openOf('H2', 'LIC:LIC-H2')).tier).toBe(7);
    await valid('2029-12-31');
    expect(await watch()).toEqual([]);
    expect(await openOf('H2', 'LIC:LIC-H2')).toBeUndefined();
    expect((await db(() => SELECT.from('medilink.Notifications').where({ kind: 'LICENCE_EXPIRY', hospital_ID: 'H2' }))).length).toBe(2);
  });
});

describe('experience API', () => {
  test('GET /me/stock: per drug on hand / level / status / text, lots with batch, brand, qty, days left, tier; worst first', async () => {
    const r = await get('/me/stock', 'ravi');
    expect(r.status).toBe(200);
    const s = r.data;
    expect(s.hospital).toEqual({ id: 'H5', name: 'Banashankari Care Hospital, Banashankari' });
    expect(s.summary).toMatchObject({ out: 1, low: 1, expiring: 3, expired: 1, text: '1 out of stock, 1 low, 3 expiring soon, 1 expired', emptyText: null });
    expect(s.drugs[0]).toMatchObject({ drugId: 'D-TRAS440', drug: 'Trastuzumab 440 mg', onHand: 0, threshold: 2, thresholdSource: 'default', status: 'out', severity: 'HIGH', text: 'Out of stock. Reorder level 2.' });
    expect(s.drugs[0].lots[0]).toMatchObject({ lotId: 'H5-TRAS-X', batchNo: 'NB24T019', brandName: 'Herzuma-S', qty: 1, daysLeft: -3, tier: 0, status: 'expired', text: expect.stringMatching(/^Expired on .*\. Take it off the shelf and quarantine it\.$/) });
    const fu = s.drugs.find(d => d.drugId === 'D-5FU500');
    expect(fu).toMatchObject({ onHand: 3, threshold: 8, thresholdSource: 'hospital', status: 'low', text: '3 left, at or below the reorder level of 8.' });
    expect(fu.actions[0]).toMatchObject({ id: 'set-reorder-level', method: 'POST', path: '/me/actions/set-reorder-level', body: { drugId: 'D-5FU500' }, fields: [{ name: 'minUnits', type: 'number', default: 8, min: 0 }] });
    const ritu = s.drugs.find(d => d.drugId === 'D-RITU500');
    expect(ritu.lots).toEqual([expect.objectContaining({ batchNo: 'RITU24S025', qty: 2, daysLeft: 25, tier: 30, nearExpiry: true, spare: 2, text: expect.stringMatching(/^Expires in 25 days \(.*\)\. Use it first, or offer the 2 vials you can spare as surplus to nearby hospitals\.$/) })]);
    const sev = { HIGH: 3, MEDIUM: 2, LOW: 1 };
    const order = s.drugs.map(d => sev[d.severity] || 0);
    expect([...order].sort((a, b) => b - a)).toEqual(order);
    expect(s.drugs.find(d => d.status === 'ok' && !d.lots.length)).toMatchObject({ text: expect.stringMatching(/^\d+ in stock\. Reorder level \d+\.$/), lots: [] });

    expect((await get('/me/stock', 'admin')).data.code).toBe('CHOOSE_HOSPITAL');
    expect((await get('/me/stock?hospital=H5', 'admin')).data.drugs[0].actions[0].body).toEqual({ drugId: 'D-TRAS440', hospital: 'H5' });
    expect((await get('/me/stock?hospital=H99', 'admin')).status).toBe(404);
    expect((await get('/me/stock?hospital=H5', 'meera')).status).toBe(200); // approver of H5
    const other = await get('/me/stock?hospital=H5', 'asha');
    expect([other.status, other.data.code]).toEqual([403, 'FORBIDDEN_HOSPITAL']);
    expect((await get('/me/stock', 'bpa')).data.code).toBe('NO_HOSPITAL');
    expect((await T.axios.get('/me/stock')).status).toBe(401);
  });

  test('GET /me/home: the new alerts (with an acknowledge button) and a stock summary', async () => {
    const h = (await get('/me/home', 'ravi')).data;
    expect(h.stockSummary).toMatchObject({ out: 1, low: 1, expiring: 3, expired: 1 });
    const kinds = h.alerts.map(a => a.kind);
    expect(kinds).toEqual(expect.arrayContaining(['OUT_OF_STOCK', 'LOW_STOCK', 'EXPIRED', 'EXPIRING']));
    const reds = h.alerts.filter(a => a.severity === 'red').length;
    expect(h.alerts.slice(0, reds).every(a => a.severity === 'red')).toBe(true);
    const expired = h.alerts.find(a => a.kind === 'EXPIRED');
    expect(expired).toMatchObject({ severity: 'red', lotId: 'H5-TRAS-X', notificationId: expect.any(String), message: expect.stringMatching(/^Batch NB24T019 of Trastuzumab 440 mg \(1 vial\) expired on /) });
    expect(expired.actions).toEqual([expect.objectContaining({ id: 'ack-alert', label: 'Got it', path: '/me/actions/ack-alert', body: { notificationId: expired.notificationId }, fields: [] })]);
    expect(h.alerts.find(a => a.kind === 'OUT_OF_STOCK')).toMatchObject({ drugId: 'D-TRAS440', severity: 'red' });
    expect((await get('/me/home', 'admin')).data.stockSummary).toBeNull();
  });

  test('acknowledge hides an alert from home, keeps it in the inbox; another hospital can neither read nor ack it', async () => {
    const id = (await get('/me/home', 'ravi')).data.alerts.find(a => a.kind === 'EXPIRED').notificationId;
    const stranger = await act('asha', 'ack-alert', { notificationId: id });
    expect([stranger.status, stranger.data.code]).toEqual([404, 'NOT_FOUND']);
    expect((await get('/me/notifications?status=all', 'asha')).data.notifications.some(n => n.hospitalId !== 'H1')).toBe(false);
    expect((await act('bpa', 'ack-alert', { notificationId: id })).status).toBe(403); // technical user, no hospital
    expect((await act('ravi', 'ack-alert', { notificationId: 'nope' })).data.code).toBe('INVALID_INPUT');

    const ok = await act('meera', 'ack-alert', { notificationId: id });
    expect(ok.status).toBe(200);
    expect(ok.data.message).toBe('Done. This alert is hidden from your home screen and stays in your alerts list.');
    expect((await act('ravi', 'ack-alert', { notificationId: id })).status).toBe(200); // twice is fine
    expect((await get('/me/home', 'ravi')).data.alerts.some(a => a.notificationId === id)).toBe(false);

    const open = (await get('/me/notifications', 'ravi')).data;
    expect(open.status).toBe('open');
    expect(open.notifications.some(n => n.id === id)).toBe(false);
    expect(open.notifications.every(n => n.hospitalId === 'H5' && n.open)).toBe(true);
    expect(open.notifications[0]).toMatchObject({ id: expect.any(String), kind: expect.any(String), colour: expect.stringMatching(/red|amber/), message: expect.any(String), actions: [expect.objectContaining({ id: 'ack-alert' })] });
    expect(open.alertEmail).toMatchObject({ email: 'ravi.h5@example.org', text: "Your hospital's alerts are emailed to ravi.h5@example.org.", action: { id: 'set-alert-email', fields: [{ name: 'email', default: 'ravi.h5@example.org', required: false }] } });
    const all = (await get('/me/notifications?status=all', 'ravi')).data;
    expect(all.notifications.find(n => n.id === id)).toMatchObject({ open: false, ackedBy: 'meera', ackedAt: expect.any(String), actions: [] });
    expect(all.notifications.some(n => n.resolvedAt)).toBe(true); // resolved alerts stay in the history
    const everyone = (await get('/me/notifications?status=all', 'admin')).data.notifications;
    expect(new Set(everyone.map(n => n.hospitalId)).size).toBeGreaterThan(1);
    expect((await get('/audit/Entries?$orderby=seq', 'admin')).data.some(e => e.action === 'ALERT_ACKNOWLEDGED')).toBe(true);
  });

  test('set-reorder-level: pharmacist, approver or admin of that hospital; checked at once', async () => {
    const r = await act('ravi', 'set-reorder-level', { drugId: 'D-PACL260', minUnits: 10 });
    expect(r.data).toMatchObject({ ok: true, message: 'Reorder level for Paclitaxel 260 mg set to 10.', result: { hospitalId: 'H5', drugId: 'D-PACL260', minUnits: 10 } });
    expect((await get('/me/home', 'ravi')).data.alerts.find(a => a.kind === 'LOW_STOCK' && a.drugId === 'D-PACL260')).toBeTruthy();
    expect((await act('meera', 'set-reorder-level', { drugId: 'D-PACL260', minUnits: 5 })).status).toBe(200);
    expect(await openOf('H5', 'D-PACL260')).toBeUndefined();
    expect((await get('/me/stock', 'ravi')).data.drugs.find(d => d.drugId === 'D-PACL260')).toMatchObject({ threshold: 5, thresholdSource: 'hospital', status: 'ok' });

    const cross = await act('asha', 'set-reorder-level', { drugId: 'D-PACL260', minUnits: 1, hospital: 'H5' });
    expect([cross.status, cross.data.code]).toEqual([403, 'FORBIDDEN_HOSPITAL']);
    expect((await act('admin', 'set-reorder-level', { drugId: 'D-PACL260', minUnits: 6 })).data.code).toBe('CHOOSE_HOSPITAL');
    expect((await act('admin', 'set-reorder-level', { drugId: 'D-PACL260', minUnits: 6, hospital: 'H5' })).status).toBe(200);
    for (const minUnits of [-1, 2.5, 'lots']) expect((await act('ravi', 'set-reorder-level', { drugId: 'D-PACL260', minUnits })).data.code).toMatch(/INVALID_REORDER_LEVEL|INVALID_INPUT/);
    expect((await act('ravi', 'set-reorder-level', { drugId: 'D-NOPE', minUnits: 1 })).status).toBe(404);
    expect((await act('bpa', 'set-reorder-level', { drugId: 'D-PACL260', minUnits: 1 })).status).toBe(403);
    const row = await db(() => SELECT.one.from('medilink.StockThresholds').where({ hospital_ID: 'H5', drug_ID: 'D-PACL260' }));
    expect(row).toMatchObject({ minUnits: 6, updatedBy: 'admin' });
    expect((await get('/audit/Entries?$orderby=seq', 'admin')).data.filter(e => e.action === 'REORDER_LEVEL_SET').length).toBe(3);
  });

  test('F21: only the approver (or admin) changes the safety margin', async () => {
    const pharm = await T.axios.post('/odata/v4/settings/setSafetyMargin', { pct: 0 }, as('ravi'));
    expect(pharm.status).toBe(403);
    expect((await T.axios.post('/odata/v4/settings/setSafetyMargin', { pct: 25 }, as('meera'))).data).toMatchObject({ hospitalId: 'H5', safetyMarginPct: 25 });
    await T.axios.post('/odata/v4/settings/setSafetyMargin', { pct: 20 }, as('meera'));
  });

  test('F12: notifications are read-only over OData (no moving or rewriting rows)', async () => {
    const mine = (await get('/odata/v4/cover/Notifications', 'ravi')).data.value;
    expect(mine.length).toBeGreaterThan(0);
    expect(mine.every(n => n.hospital_ID === 'H5')).toBe(true);
    const n = mine[0];
    const patch = await T.axios.patch(`/odata/v4/cover/Notifications(${n.ID})`, { hospital_ID: 'H2', message: 'forged' }, as('ravi'));
    expect(patch.status).toBeGreaterThanOrEqual(400);
    expect(patch.status).toBeLessThan(500);
    expect(await db(() => SELECT.one.from('medilink.Notifications').where({ ID: n.ID }))).toMatchObject({ hospital_ID: 'H5', message: n.message });
  });

  test('recipients: own people with an email, else the hospital admin email, else ALERT_EMAIL_TO; clearing an email works', async () => {
    expect(await db(() => notify.recipients('H2'))).toEqual(['admin.h2@example.org']);
    const nina = { username: 'nina.x', role: 'pharmacist', hospital: 'H2', password: 'long-enough-1' };
    expect((await T.axios.post('/auth/users', { ...nina, email: 'not mail' }, as('admin'))).data.code).toBe('INVALID_EMAIL');
    expect((await T.axios.post('/auth/users', { ...nina, email: 'Nina.H2@Example.org' }, as('admin'))).data).toMatchObject({ username: 'nina.x', email: 'nina.h2@example.org' });
    expect(await db(() => notify.recipients('H2'))).toEqual(['nina.h2@example.org']);
    await withEnv({ ALERT_EMAIL_TO: 'ops@example.test, ops2@example.test' }, async () => {
      await db(() => UPDATE('medilink.Hospitals').set({ adminEmail: null }).where({ ID: 'H3' }));
      expect(await db(() => notify.recipients('H3'))).toEqual(['ops@example.test', 'ops2@example.test']);
      expect(await db(() => notify.recipients(null))).toEqual(['ops@example.test', 'ops2@example.test']);
      await db(() => UPDATE('medilink.Hospitals').set({ adminEmail: 'admin.h3@example.org' }).where({ ID: 'H3' }));
    });
    await withEnv({ ALERT_EMAIL_TO: '' }, async () => expect(await db(() => notify.recipients(null))).toEqual([]));
    expect((await act('ravi', 'set-alert-email', {})).data).toMatchObject({ ok: true, message: "We won't email you alerts any more.", result: { email: null } });
    expect(await db(() => notify.recipients('H5'))).toEqual(['meera.h5@example.org']);
  });
});

describe('audit fixes around stock feeds', () => {
  test('F6: a lot listed twice is summed, not a database error; an opened part keeps its own row', async () => {
    const { ingestSnapshot } = require('../srv/lib/ingest');
    const base = { generic: 'Oxaliplatin', strength: '100 mg', form: 'Powder for injection', brand: 'Oxaliva', mfr: 'Deccan Biogenerics (synthetic)', batch: 'OXAL24D777', expiry: day(300) };
    const r = await db(() => ingestSnapshot('H4', 'CONNECTOR', { lots: [{ ...base, qty: 3 }, { ...base, qty: 2, expiry: day(250) }, { ...base, qty: 1, sealed: false }] }));
    expect(r).toMatchObject({ lots: 2, skipped: 0 });
    const lots = await db(() => SELECT.from('medilink.Lots').where({ hospital_ID: 'H4', source: 'CONNECTOR' }).orderBy('ID'));
    expect(lots.map(l => [l.ID.endsWith('-opened'), l.quantity, l.sealed, l.expiryDate])).toEqual([[false, 5, true, day(250)], [true, 1, false, day(300)]]);

    const sheet = ['Item Name,Strength,Form,Brand,Mfr,Batch No,Qty,ExpDt,Store,Sealed?',
      'Oxaliplatin,100 mg,Powder for injection,Oxaliva,Deccan Biogenerics (synthetic),OXAL24D888,4,01/2028,Room,Y',
      'Oxaliplatin,100 mg,Powder for injection,Oxaliva,Deccan Biogenerics (synthetic),OXAL24D888,6,01/2028,Room,Y'].join('\n');
    const up = await act('hari', 'upload-sheet', { csv: sheet });
    expect(up.status).toBe(200);
    expect(up.data.result).toMatchObject({ saved: 1 });
    expect((await db(() => SELECT.one.from('medilink.Lots').where({ hospital_ID: 'H4', batchNo: 'OXAL24D888' }))).quantity).toBe(10);
  });

  test('one open alert per condition is enforced by the database; a clash never fails the stock update', async () => {
    const { ingestSnapshot } = require('../srv/lib/ingest');
    // a row holding the key the next check will want, e.g. written by a parallel check a moment earlier
    await db(() => INSERT.into('medilink.Notifications').entries({ ID: cds.utils.uuid(), hospital_ID: 'H4', kind: 'TEST', message: 'synthetic clash', dedupeKey: 'LOT:H4:H4-CLASH', createdAt: new Date().toISOString() }));
    const row = { lotRef: 'H4-CLASH', drugId: 'D-RITU500', batchNo: 'RITU24C001', quantity: 2, expiryDate: day(15), sealed: true };
    const r = await db(() => ingestSnapshot('H4', 'SHEET', { lots: [row] }, { actor: 'test', merge: true }));
    expect(r).toMatchObject({ lots: 1, skipped: 0 });
    expect(await db(() => SELECT.one.from('medilink.Lots').where({ ID: 'H4-CLASH' }))).toMatchObject({ quantity: 2 });
    expect((await db(() => SELECT.from('medilink.Notifications').where({ dedupeKey: 'LOT:H4:H4-CLASH' }))).length).toBe(1);
    await db(() => DELETE.from('medilink.Notifications').where({ kind: 'TEST' })); // clash gone: the next check alerts normally
    expect((await run(['H4'])).map(r => r.ref)).toEqual(['H4-CLASH']);
  });

  test('F13: confirming a photo of one register page adds its rows and keeps the rest of the sheet stock', async () => {
    const before = await db(() => SELECT.from('medilink.Lots').columns('ID').where({ hospital_ID: 'H4', source: 'SHEET' }));
    const previewId = cds.utils.uuid();
    const rows = [{ generic: 'Cisplatin', strength: '50 mg/50 mL', form: 'Injection', brandName: 'Cisplanova', manufacturer: 'Medora Labs (synthetic)', batchNo: 'CISP24P001', quantity: 4, expiryDate: '03/2028' }];
    await db(() => INSERT.into('medilink.PhotoPreviews').entries({ ID: previewId, hospital_ID: 'H4', rows: JSON.stringify(rows), createdAt: new Date().toISOString() }));
    const r = await act('hari', 'confirm-photo', { previewId });
    expect(r.status).toBe(200);
    const after = await db(() => SELECT.from('medilink.Lots').columns('ID', 'batchNo').where({ hospital_ID: 'H4', source: 'SHEET' }));
    expect(after.length).toBe(before.length + 1);
    expect(after.map(l => l.ID)).toEqual(expect.arrayContaining(before.map(l => l.ID)));
  });

  test('one digest per ingest: a sheet with several new problems sends one email to that hospital', async () => {
    await act('hari', 'set-alert-email', { email: 'hari.h4@example.org' });
    const sheet = ['Item Name,Strength,Form,Brand,Mfr,Batch No,Qty,ExpDt,Store,Sealed?',
      'Cyclophosphamide,500 mg,Powder for injection,Cyclomed,Kaveri Pharma (synthetic),CYCL24E001,2,' + day(-2).split('-').reverse().join('/') + ',Room,Y',
      'Cyclophosphamide,500 mg,Powder for injection,Cyclomed,Kaveri Pharma (synthetic),CYCL24E002,1,' + day(6).split('-').reverse().join('/') + ',Room,Y'].join('\n');
    await withEnv(SMTP, async () => { expect((await act('hari', 'upload-sheet', { csv: sheet })).status).toBe(200); await tick(); });
    expect(sent.length).toBe(1);
    expect(sent[0]).toMatchObject({ to: 'hari.h4@example.org', subject: expect.stringMatching(/^MediLink: \d+ new alerts \(H4\)$/) });
    expect(sent[0].text).toMatch(/CYCL24E001[\s\S]*quarantine/);
  });

  test('F14: the IT contact is stored; the setup link is emailed when SMTP is set up, otherwise the text does not claim it was sent', async () => {
    const r = await withEnv(SMTP, async () => { const x = await T.axios.post('/onboarding/licence', { licenceNo: 'KA-BLR-20B-1003', itContact: 'it@lakeside.example' }, as('lata')); await tick(); return x; });
    expect(r.data.message).toMatch(/We emailed your IT team \(it@lakeside\.example\) a setup link .*Waiting for your IT team\.$/);
    expect(sent).toEqual([expect.objectContaining({ to: 'it@lakeside.example', subject: 'MediLink connector setup for Lakeside Oncology Centre, Koramangala', text: expect.stringContaining('/connector/setup?hospital=H3') })]);
    expect(sent[0].text).not.toContain(r.data.pairingCode); // the code stays on the pharmacist's screen
    expect((await db(() => SELECT.one.from('medilink.Hospitals').columns('itContact').where({ ID: 'H3' }))).itContact).toBe('it@lakeside.example');

    sent = [];
    const phone = await T.axios.post('/onboarding/licence', { licenceNo: 'KA-BLR-20B-1003', itContact: '+91 80 5550 1234' }, as('lata'));
    await tick();
    expect(phone.data.message).toMatch(/Give your IT team the setup link and the pairing code shown here/);
    expect(phone.data.message).not.toMatch(/emailed|We sent/);
    expect(sent).toEqual([]);
  });
});
