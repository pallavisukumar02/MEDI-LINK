'use strict';
/*
 * Onboarding + ingestion integration: connector pairing, token-authenticated POST /ingest (privacy gate),
 * sheet upload with messy headers, SAP sandbox puller (offline fixture), stale-feed detection,
 * encrypted local token store, disconnect + consent rows in the audit log. No SAP credentials.
 */
require('./helpers/env')();
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const cds = require('@sap/cds');
const T = cds.test(__dirname + '/..');
T.axios.defaults.validateStatus = () => true;

const as = user => ({ auth: { username: user, password: 'demo' } });
const post = (url, body, user, cfg = {}) => T.axios.post(url, body, { ...as(user), ...cfg });
const get = (url, user) => T.axios.get(url, as(user));
const hash = mrn => crypto.createHash('sha256').update(`test-salt:${mrn}`).digest('hex');
const state = {};

describe('connector pairing and POST /ingest', () => {
  test('licence for an in-house DB hospital returns a pairing code and IT setup link', async () => {
    const r = await post('/onboarding/licence', { licenceNo: 'KA-BLR-20B-1003', itContact: 'it@lakeside.example' }, 'lata');
    expect(r.status).toBe(200);
    expect(r.data).toMatchObject({ next: 'WAIT_FOR_IT', hospitalId: 'H3' });
    expect(r.data.pairingCode).toMatch(/^[A-F0-9]{10}$/);
    expect(r.data.message).toMatch(/Waiting for your IT team/);
    const page = await T.axios.get(new URL(r.data.itSetupLink).pathname + '?hospital=H3');
    expect(page.status).toBe(200);
    expect(page.data).toMatch(/read-only connector/);
    state.code = r.data.pairingCode;
  });

  test('pairing code exchanges once for an ingest token', async () => {
    const bad = await T.axios.post('/connector/pair', { pairingCode: 'NOPE' });
    expect(bad.status).toBe(401);
    const ok = await T.axios.post('/connector/pair', { pairingCode: state.code });
    expect(ok.status).toBe(200);
    expect(ok.data.token).toMatch(/^[a-f0-9]{64}$/);
    expect(ok.data.hospitalId).toBe('H3');
    state.token = ok.data.token;
    const again = await T.axios.post('/connector/pair', { pairingCode: state.code });
    expect(again.status).toBe(401); // single use
  });

  test('/ingest requires a valid token and refuses un-hashed patient refs', async () => {
    expect((await T.axios.post('/ingest', {})).status).toBe(401);
    expect((await T.axios.post('/ingest', {}, { headers: { Authorization: 'Bearer ' + 'a'.repeat(64) } })).status).toBe(401);
    const H = { headers: { Authorization: 'Bearer ' + state.token } };
    const leak = await T.axios.post('/ingest', { bookings: [{ bookingId: 'X1', patientRef: 'MRN-0001 Ramesh', generic: 'Carboplatin', strength: '450 mg/45 mL', units: 2, scheduledDate: '2030-01-01' }] }, H);
    expect(leak.status).toBe(422);
    expect(leak.data.error.code).toBe('PATIENT_REF_NOT_HASHED');
    const today = new Date().toISOString().slice(0, 10);
    const ok = await T.axios.post('/ingest', {
      lots: [{ lotRef: 'H3-CARB-B', generic: 'Carboplatin', strength: '450 mg/45 mL', form: 'Injection', brand: 'Carbokem', mfr: 'Sunrise Oncology Ltd (synthetic)', batch: 'SOL24C150', qty: 14, expiry: '2027-05-10', storage: 'AMBIENT', sealed: true }],
      bookings: [{ bookingId: 'LOC-1', patientRef: hash('MRN-1'), generic: 'Carboplatin', strength: '450 mg/45 mL', form: 'Injection', units: 2, scheduledDate: today, intent: 'curative' }],
    }, H);
    expect(ok.status).toBe(200);
    expect(ok.data).toMatchObject({ hospitalId: 'H3', source: 'CONNECTOR', lots: 1, bookings: 1, skipped: 0 });
  });
});

describe('sheet upload fallback (FR-04)', () => {
  const csv = fs.readFileSync(path.resolve(__dirname, '../../seed/sheets/hebbal_stock_sheet.csv'), 'utf8');
  test('messy headers map by synonyms; preview first, then confirm ingests', async () => {
    const pre = await post('/sync/uploadSheet', { csv, confirm: false }, 'hari');
    expect(pre.status).toBe(200);
    const m = JSON.parse(pre.data.mapping);
    expect(m).toMatchObject({ generic: 'Item Name', expiryDate: 'ExpDt', batchNo: 'Batch No', quantity: 'Qty' });
    expect(pre.data.mappingSource).toBe('synonyms');
    expect(pre.data.ingested).toBeFalsy();
    const done = await post('/sync/uploadSheet', { csv, confirm: true }, 'hari');
    expect(done.data.ingested).toMatchObject({ hospitalId: 'H4', source: 'SHEET' });
    expect(done.data.ingested.lots).toBeGreaterThan(0);
  });
  test('unmappable sheet is refused with a machine-readable code', async () => {
    const r = await post('/sync/uploadSheet', { csv: 'foo,bar\n1,2\n' }, 'hari');
    expect(r.status).toBe(422);
    expect(r.data.error.code).toBe('SHEET_COLUMNS_UNMAPPED');
  });
  test('a pharmacist cannot upload for another hospital', async () => {
    const r = await post('/sync/uploadSheet', { csv, hospital: 'H1' }, 'hari');
    expect(r.status).toBe(403);
  });
});

describe('SAP sandbox puller, stale feeds and token store', () => {
  test('without SAP_API_HUB_KEY the SAP hospital syncs from the offline fixture', async () => {
    const r = await post('/sync/syncNow', {}, 'sunil');
    expect(r.status).toBe(200);
    expect(r.data[0]).toMatchObject({ hospitalId: 'H2', source: 'SAP_SANDBOX', mode: 'fixture' });
    expect(r.data[0].lots).toBeGreaterThan(0);
  });

  test('feed silent longer than STALE_FEED_MINUTES is greyed out and alerted (FR-07)', async () => {
    const sync = require('../srv/lib/sync');
    const later = new Date(Date.now() + 2 * 3600 * 1000);
    const stale = await cds.tx(() => sync.detectStale(later));
    expect(stale).toEqual(expect.arrayContaining(['H2', 'H3', 'H4', 'H5']));
    const h = (await get('/odata/v4/admin/Hospitals(\'H3\')', 'admin')).data;
    expect(h.feedStale).toBe(true);
    const n = (await get("/odata/v4/admin/Notifications?$filter=kind eq 'STALE_FEED'", 'admin')).data.value;
    expect(n.length).toBeGreaterThanOrEqual(4);
    await cds.tx(() => sync.detectStale(new Date())); // fresh again -> un-greyed
    expect((await get('/odata/v4/admin/Hospitals(\'H3\')', 'admin')).data.feedStale).toBe(false);
    const open = (await get("/odata/v4/admin/Notifications?$filter=kind eq 'STALE_FEED' and hospital_ID eq 'H3' and resolvedAt eq null", 'admin')).data.value;
    expect(open).toHaveLength(0); // the feed is back, so its alert is closed
  });

  test('local token store encrypts at rest (AES-256-GCM) and round-trips', async () => {
    const tokens = require('../srv/lib/tokens');
    expect(tokens.store().kind).toBe('local');
    const secret = { access_token: 'tok-' + crypto.randomBytes(8).toString('hex'), refresh_token: 'r', scope: 'stock.read' };
    await cds.tx(() => tokens.local.save('H1', 'MEDISOFT', secret));
    const row = await cds.tx(() => SELECT.one.from('medilink.TokenVault').where({ hospital_ID: 'H1' }));
    expect(row.ciphertext).not.toContain(secret.access_token);
    expect(await cds.tx(() => tokens.local.get('H1', 'MEDISOFT'))).toEqual(secret);
    await cds.tx(() => tokens.local.remove('H1', 'MEDISOFT'));
  });
});

describe('disconnect (FR-05)', () => {
  test('revokes the connector token instantly; consent and revocation are in the audit log', async () => {
    const r = await post('/onboarding/revokeAccess', {}, 'lata');
    expect(r.status).toBe(200);
    expect(r.data.revoked).toBe(true);
    const ing = await T.axios.post('/ingest', { lots: [] }, { headers: { Authorization: 'Bearer ' + state.token } });
    expect(ing.status).toBe(401);
    const st = (await get('/onboarding/status', 'lata')).data;
    expect(st.connected).toBe(false);
    expect(st.consents.every(c => c.revokedAt)).toBe(true);
    const actions = (await get('/audit/Entries?$orderby=seq', 'admin')).data.map(e => e.action);
    expect(actions).toEqual(expect.arrayContaining(['IT_HANDOFF_SENT', 'CONSENT_GRANTED', 'INGEST', 'CONSENT_REVOKED']));
    expect((await get('/audit/verify', 'admin')).data.ok).toBe(true);
  });
});
