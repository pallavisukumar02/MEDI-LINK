'use strict';
/*
 * Receipt (FR-25) and audit (FR-27) against the database:
 * excursion shipment cannot be accepted, quarantine keeps it out of usable stock; only the receiver may scan;
 * audit log is append-only at the DB-service level and GET /audit/verify detects tampering done behind CAP's back.
 */
require('./helpers/env')();
const cds = require('@sap/cds');
const T = cds.test(__dirname + '/..');
T.axios.defaults.validateStatus = () => true;

const as = user => ({ auth: { username: user, password: 'demo' } });
const get = (url, user) => T.axios.get(url, as(user));
const post = (url, body, user) => T.axios.post(url, body, as(user));
const COLD = 'a0000000-0000-4000-8000-000000000001'; // seeded H2 -> H3 trastuzumab, batch NB24T044, logger LOG-7781

describe('arrival scan and proof of condition', () => {
  test('excursion during transit: ACCEPT is refused, QUARANTINE is recorded with FAIL proof', async () => {
    await post('/odata/v4/delivery/telemetry', { loggerId: 'LOG-7781', lat: 12.95, long: 77.69, temperatureC: 5.1 }, 'sim');
    await post('/odata/v4/delivery/telemetry', { loggerId: 'LOG-7781', lat: 12.94, long: 77.65, temperatureC: 12.3 }, 'sim');
    expect((await post('/odata/v4/receipt/arrivalScan', { transfer: COLD, batchNo: 'NB24T044', sealIntact: true, qtyReceived: 2 }, 'sunil')).status).toBe(403); // supplier, not receiver
    const acc = await post('/odata/v4/receipt/arrivalScan', { transfer: COLD, batchNo: 'NB24T044', sealIntact: true, qtyReceived: 2, decision: 'ACCEPT' }, 'lata');
    expect(acc.status).toBe(409);
    expect(acc.data.error.code).toBe('PROOF_OF_CONDITION_FAILED');
    expect(acc.data.error.message).toMatch(/noExcursion/);
    const q = await post('/odata/v4/receipt/arrivalScan', { transfer: COLD, batchNo: 'NB24T044', sealIntact: true, qtyReceived: 2, decision: 'QUARANTINE' }, 'lata');
    expect(q.status).toBe(200);
    expect(q.data).toMatchObject({ status: 'QUARANTINED', proofOfCondition: 'FAIL' });
    const checks = JSON.parse(q.data.checks);
    expect(checks.checks).toMatchObject({ noExcursion: false, batchMatches: true, sealIntact: true });
    expect(checks.maxC).toBe(12.3);
    const lots = JSON.parse(q.data.lotIds);
    const lot = (await get(`/odata/v4/cover/Lots('${lots[0]}')`, 'lata')).data;
    expect(lot).toMatchObject({ hospital_ID: 'H3', batchNo: 'NB24T044', quarantined: true, source: 'TRANSFER' });
  });

  test('a delivered transfer cannot be scanned twice; receipt is audited', async () => {
    const again = await post('/odata/v4/receipt/arrivalScan', { transfer: COLD, batchNo: 'NB24T044', sealIntact: true, decision: 'QUARANTINE' }, 'lata');
    expect(again.data.error.code).toBe('INVALID_STATUS');
    const a = (await get('/audit/Entries?$orderby=seq', 'admin')).data.filter(e => e.action === 'ARRIVAL');
    expect(JSON.parse(a.at(-1).payload)).toMatchObject({ transfer: COLD, decision: 'QUARANTINE', proofOfCondition: 'FAIL' });
  });
});

describe('append-only, hash-chained audit log', () => {
  test('the API and the DB service both refuse to change or delete entries', async () => {
    expect((await T.axios.patch('/audit/Entries/1', { actor: 'x' }, as('admin'))).status).toBe(405);
    expect((await T.axios.delete('/audit/Entries/1', as('admin'))).status).toBe(405);
    await expect(cds.tx(() => UPDATE('medilink.AuditLog').set({ actor: 'mallory' }).where({ seq: 1 }))).rejects.toThrow(/AUDIT_APPEND_ONLY/);
    await expect(cds.tx(() => DELETE.from('medilink.AuditLog').where({ seq: 1 }))).rejects.toThrow(/AUDIT_APPEND_ONLY/);
    expect((await get('/audit/verify', 'admin')).data.ok).toBe(true);
  });

  test('pharmacists cannot read the audit log; approvers can verify', async () => {
    expect((await get('/audit/verify', 'asha')).status).toBe(403);
    expect((await get('/audit/verify', 'meera')).data.ok).toBe(true);
  });

  test('tampering behind CAP (raw SQL) is detected at the exact sequence number', async () => {
    const db = await cds.connect.to('db');
    const before = (await get('/audit/verify', 'admin')).data;
    expect(before.ok).toBe(true);
    const target = Math.max(2, Math.floor(before.count / 2));
    await db.run(`UPDATE medilink_AuditLog SET payload = '{"tampered":true}' WHERE seq = ${target}`); // bypasses the CQL guard
    const v = (await get('/audit/verify', 'admin')).data;
    expect(v).toMatchObject({ ok: false, brokenAt: target, reason: 'HASH_MISMATCH' });
  });
});
