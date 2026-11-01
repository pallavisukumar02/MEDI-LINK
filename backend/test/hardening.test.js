'use strict';
/*
 * Bug fixes and security hardening (audit section F): disconnect stops frozen stock (F3), cancel after accept (F4),
 * repayments settle one loan once and open no reverse loan (F5), rate limits + login throttle without lockout (F7),
 * audit-log and row-level visibility (F9, F10), concurrent writes (F15, F17), onboarding fails closed (F18),
 * PKCE (F20), received-stock reconciliation (F22), daily cleanup, demo password check.
 * Ranking uses the built-in fallback (no Python needed). TRUST_PROXY=1 so a test can pose as another client IP.
 */
require('./helpers/env')({ MATCHER_URL: 'http://localhost:1', MATCHER_FALLBACK_ENABLED: 'true', TRUST_PROXY: '1' });
const crypto = require('crypto');
const cds = require('@sap/cds');
const T = cds.test(__dirname + '/..');
T.axios.defaults.validateStatus = () => true;

const as = (user, headers = {}) => ({ auth: { username: user, password: 'demo' }, headers });
const get = (url, user) => T.axios.get(url, as(user));
const post = (url, body, user, headers) => T.axios.post(url, body, as(user, headers));
const PHARM = { H2: 'sunil', H3: 'lata', H4: 'hari', H5: 'ravi' };
const inDays = n => new Date(Date.now() + n * 86400000).toISOString().slice(0, 10);
const db = fn => cds.tx(fn);

/** asha (H1) asks for qty of a drug and sends it to the first ranked supplier. */
async function pendingTransfer(drug = 'D-CISP50', qty = 1) {
  const r = await post('/odata/v4/requests/createRequest', { drug, qty, neededBy: inDays(5), allowBrandSwitch: true }, 'asha');
  expect(r.data.ranking.plans.length).toBeGreaterThan(0);
  const [t] = (await post('/odata/v4/requests/choosePlan', { request: r.data.request, rank: 1 }, 'asha')).data.value;
  return { request: r.data.request, t, supplier: PHARM[t.supplierId] };
}
const loansOf = transfer => db(() => SELECT.from('medilink.Ledger').where({ transfer_ID: transfer }));

describe('F17 / F15: concurrent writes', () => {
  test('a concurrent double accept moves the transfer once and records one loan', async () => {
    const { t, supplier } = await pendingTransfer();
    const [a, b] = await Promise.all([1, 2].map(() => post('/odata/v4/supplier/accept', { transfer: t.ID, repaymentMode: 'IN_KIND' }, supplier)));
    expect([a.status, b.status].sort()).toEqual([200, 409]);
    expect([a, b].find(r => r.status === 409).data.error.code).toBe('INVALID_STATUS');
    expect(await loansOf(t.ID)).toHaveLength(1);
  });

  test('20 concurrent transactions writing the audit log keep one gap-free hash chain', async () => {
    const audit = require('../srv/lib/audit');
    const sleep = () => new Promise(r => setTimeout(r, Math.random() * 15));
    const res = await Promise.allSettled(Array.from({ length: 20 }, (_, i) => cds.tx(async () => {
      await SELECT.one.from('medilink.Hospitals'); await sleep();
      await audit.log('test:' + i, 'CONCURRENCY_TEST', { i }); await sleep();
    })));
    expect(res.filter(r => r.status === 'rejected')).toEqual([]);
    expect(await cds.tx(() => audit.verify())).toMatchObject({ ok: true });
    expect((await get('/audit/verify', 'admin')).data.ok).toBe(true);
  });
});

describe('F4: cancelling after the supplier accepted', () => {
  test('cancels the loan, tells the supplier and the courier channel, and leaves no task on either home screen', async () => {
    const events = []; require('../srv/lib/ws').listeners.add((event, data) => events.push({ event, data }));
    const { request, t, supplier } = await pendingTransfer();
    expect((await post('/odata/v4/supplier/accept', { transfer: t.ID, repaymentMode: 'LANDED_COST' }, supplier)).status).toBe(200);
    expect((await loansOf(t.ID))[0].status).toBe('OPEN');

    const c = await post('/me/actions/cancel-request', { requestId: request }, 'asha');
    expect(c.status).toBe(200);
    expect((await loansOf(t.ID))[0].status).toBe('CANCELLED');
    expect((await get(`/odata/v4/admin/Transfers(${t.ID})`, 'admin')).data.status).toBe('CANCELLED');
    const notes = (await get(`/odata/v4/cover/Notifications?$filter=ref eq '${t.ID}'`, supplier)).data.value;
    expect(notes.map(n => n.kind)).toContain('REQUEST_CANCELLED');
    expect(events).toContainEqual({ event: 'status', data: expect.objectContaining({ transferId: t.ID, status: 'CANCELLED' }) });
    const entry = (await get('/audit/Entries?$orderby=seq desc&$top=5', 'admin')).data.find(e => e.action === 'REQUEST_CANCELLED');
    expect(JSON.parse(entry.payload)).toMatchObject({ request, transfers: [t.ID], loansCancelled: 1 });
    for (const user of ['asha', supplier]) {
      const home = (await get('/me/home', user)).data;
      expect(home.tasks.filter(x => x.journeyId === request)).toEqual([]);
      const j = home.journeys.find(x => x.id === request);
      if (j) expect(j.key).toBe('cancelled'); // a finished journey, no longer pinned by an open loan
    }
  });
});

describe('F5: repayments', () => {
  const L = { lender_ID: 'H2', borrower_ID: 'H3', drug_ID: 'D-CYCL500', qty: 2, landedCost: 100, repaymentMode: 'IN_KIND', status: 'OPEN' };
  const ids = { a: cds.utils.uuid(), b: cds.utils.uuid(), back: cds.utils.uuid(), backLoan: cds.utils.uuid() };
  beforeAll(() => db(async () => {
    await INSERT.into('medilink.Ledger').entries([{ ...L, ID: ids.a }, { ...L, ID: ids.b }]);
    // H3 -> H2 delivery, accepted the ordinary way (so it carries its own reverse loan H3 -> H2)
    await INSERT.into('medilink.Transfers').entries({ ID: ids.back, supplier_ID: 'H3', receiver_ID: 'H2', drug_ID: 'D-CYCL500', qty: 2, qtyReceived: 2, status: 'DELIVERED' });
    await INSERT.into('medilink.Ledger').entries({ ...L, ID: ids.backLoan, lender_ID: 'H3', borrower_ID: 'H2', transfer_ID: ids.back });
  }));
  const settle = loan => post('/odata/v4/ledger/settleLoan', { loan, mode: 'IN_KIND', settlementTransfer: ids.back }, 'sunil');

  test('one delivery settles one loan, once; its reverse loan is withdrawn', async () => {
    expect((await settle(ids.a)).data).toMatchObject({ status: 'SETTLED', mode: 'IN_KIND' });
    const [a, backLoan, back] = await db(() => Promise.all([SELECT.one.from('medilink.Ledger').where({ ID: ids.a }), SELECT.one.from('medilink.Ledger').where({ ID: ids.backLoan }), SELECT.one.from('medilink.Transfers').where({ ID: ids.back })]));
    expect(a).toMatchObject({ status: 'SETTLED', settlementRef: 'TRANSFER:' + ids.back });
    expect(backLoan).toMatchObject({ status: 'CANCELLED', settlementRef: 'REPAYS:' + ids.a });
    expect(back.repaysLoan_ID).toBe(ids.a);
    expect((await settle(ids.b)).data.error.code).toBe('REPAYMENT_ALREADY_USED');
    expect((await settle(ids.a)).data.error.code).toBe('LOAN_NOT_OPEN');
  });

  test('a supplier accepting a delivery as repayment of a loan it owes records no new loan', async () => {
    const { t, supplier } = await pendingTransfer();
    const owed = cds.utils.uuid();
    await db(() => INSERT.into('medilink.Ledger').entries({ ...L, ID: owed, lender_ID: 'H1', borrower_ID: t.supplierId, drug_ID: 'D-CISP50', qty: 1 }));
    const wrong = await post('/odata/v4/supplier/accept', { transfer: t.ID, repaysLoan: ids.b }, supplier); // H3 owes H2, not this
    expect(wrong.data.error.code).toBe('REPAYMENT_WRONG_LOAN');
    const ok = await post('/odata/v4/supplier/accept', { transfer: t.ID, repaysLoan: owed }, supplier);
    expect(ok.status).toBe(200);
    expect(await loansOf(t.ID)).toEqual([]);
    expect((await get(`/odata/v4/admin/Transfers(${t.ID})`, 'admin')).data).toMatchObject({ repaysLoan_ID: owed, repaymentMode: 'IN_KIND' });
  });
});

describe('F9 / F10: who may read what', () => {
  test('audit entries are admin only; approvers keep the chain check', async () => {
    expect((await get('/audit/Entries', 'meera')).status).toBe(403);
    expect((await get('/audit/verify', 'meera')).data.ok).toBe(true);
    expect((await get('/audit/Entries?$top=1', 'admin')).status).toBe(200);
    expect((await T.axios.patch('/audit/Entries/1', { actor: 'x' }, as('admin'))).status).toBe(405);
  });

  test('plans, exclusions, transfer lots and approvals only show to the parties; road closures are not exposed', async () => {
    const own = (await get('/odata/v4/requests/Plans', 'asha')).data.value;
    expect(own.length).toBeGreaterThan(0);
    const reqs = new Set((await get('/odata/v4/requests/Requests', 'asha')).data.value.map(r => r.ID));
    expect(own.every(p => reqs.has(p.request_ID))).toBe(true);
    expect((await get('/odata/v4/requests/Plans', 'sunil')).data.value.filter(p => reqs.has(p.request_ID))).toEqual([]);
    expect((await get('/odata/v4/requests/Exclusions', 'sunil')).data.value.filter(p => reqs.has(p.request_ID))).toEqual([]);
    const seeded = 'a0000000-0000-4000-8000-000000000001'; // H2 -> H3
    for (const [user, n] of [['sunil', 1], ['lata', 1], ['ravi', 0]]) expect((await get(`/odata/v4/supplier/TransferLots?$filter=transfer_ID eq ${seeded}`, user)).data.value).toHaveLength(n);
    expect((await get(`/odata/v4/approval/Approvals?$filter=transfer_ID eq ${seeded}`, 'anil')).data.value).toHaveLength(2);
    expect((await get(`/odata/v4/approval/Approvals?$filter=transfer_ID eq ${seeded}`, 'meera')).data.value).toHaveLength(0);
    expect((await get('/odata/v4/routes/RoadClosures', 'admin')).status).toBe(404);
  });
});

describe('F18 / F20: onboarding', () => {
  test('a pharmacist without a hospital cannot onboard any licence', async () => {
    const { passwordHash } = await db(() => SELECT.one.from('medilink.Users').where({ username: 'asha' }));
    await db(() => INSERT.into('medilink.Users').entries({ username: 'nohosp', passwordHash, role: 'pharmacist', hospital: null, disabled: false }));
    const r = await post('/onboarding/licence', { licenceNo: 'KA-BLR-20B-1001', software: 'CONNECTOR' }, 'nohosp');
    expect(r.status).toBe(403);
    expect(r.data.error.message).toMatch(/^NO_HOSPITAL/);
    expect((await post('/me/actions/enter-licence', { licenceNo: 'KA-BLR-20B-1001' }, 'nohosp')).data.code).toBe('NO_HOSPITAL');
  });

  test('MediSoft sign-in uses PKCE S256; the verifier stays on the server with the state', async () => {
    const r = await post('/onboarding/licence', { licenceNo: 'KA-BLR-20B-1001' }, 'asha');
    const q = new URL(r.data.authorizeUrl).searchParams;
    expect(q.get('code_challenge_method')).toBe('S256');
    const st = await db(() => SELECT.one.from('medilink.OAuthStates').where({ state: q.get('state') }));
    expect(crypto.createHash('sha256').update(st.codeVerifier).digest('base64url')).toBe(q.get('code_challenge'));
    expect(r.data.authorizeUrl).not.toContain(st.codeVerifier);
  });
});

describe('F22: received stock is counted once', () => {
  test('a TRANSFER lot goes once the hospital feed reports the batch in at least that quantity', async () => {
    const lot = (id, drug_ID, batchNo, quantity, quarantined = false) => ({ ID: id, hospital_ID: 'H4', drug_ID, batchNo, quantity, quarantined, expiryDate: inDays(300), storageClass: 'AMBIENT', source: 'TRANSFER' });
    await db(() => INSERT.into('medilink.Lots').entries([lot('H4-RX-T1', 'D-CARB450', 'XB1', 3), lot('H4-RX-T2', 'D-CISP50', 'XB2', 3, true), lot('H4-RX-T3', 'D-OXAL100', 'XB3', 5)]));
    const sheet = (drugId, batchNo, quantity) => ({ drugId, batchNo, quantity, expiryDate: inDays(300) });
    const { ingestSnapshot } = require('../srv/lib/ingest');
    await db(() => ingestSnapshot('H4', 'SHEET', { lots: [sheet('D-CARB450', 'xb1', 4), sheet('D-CISP50', 'XB2', 10), sheet('D-OXAL100', 'XB3', 2)] }, { actor: 'test' }));
    const left = (await db(() => SELECT.from('medilink.Lots').columns('ID').where({ hospital_ID: 'H4', source: 'TRANSFER' }))).map(l => l.ID).sort();
    expect(left).toEqual(['H4-RX-T2', 'H4-RX-T3']); // quarantined stays; 2 reported < 5 received stays
    const entry = (await get('/audit/Entries?$orderby=seq desc&$top=5', 'admin')).data.find(e => e.action === 'TRANSFER_STOCK_RECONCILED');
    expect(JSON.parse(entry.payload)).toEqual({ hospital: 'H4', lots: ['H4-RX-T1'] });
  });
});

describe('housekeeping', () => {
  test('daily cleanup deletes expired keys, previews, sessions, OAuth states and pairing codes only', async () => {
    const old = new Date(Date.now() - 2 * 86400000).toISOString(), now = new Date().toISOString(), later = new Date(Date.now() + 3600000).toISOString();
    await db(async () => {
      await INSERT.into('medilink.IdempotencyKeys').entries([{ keyHash: 'old-key', createdAt: old }, { keyHash: 'new-key', createdAt: now }]);
      await INSERT.into('medilink.PhotoPreviews').entries([{ ID: cds.utils.uuid(), hospital_ID: 'H4', createdAt: old }, { ID: cds.utils.uuid(), hospital_ID: 'H4', createdAt: now }]);
      await INSERT.into('medilink.Sessions').entries([{ jti: 'old-jti', username: 'asha', exp: 1 }, { jti: 'new-jti', username: 'asha', exp: Math.floor(Date.now() / 1000) + 3600 }]);
      await INSERT.into('medilink.OAuthStates').entries([{ state: 'old-state', expiresAt: old }, { state: 'new-state', expiresAt: later }]);
      await INSERT.into('medilink.PairingCodes').entries([{ codeHash: 'old-code', expiresAt: old }, { codeHash: 'new-code', expiresAt: later }]);
    });
    const out = await db(() => require('../srv/lib/jobs').cleanup());
    expect(out).toMatchObject({ idempotencyKeys: 1, photoPreviews: 1, sessions: 1, pairingCodes: 1 });
    expect(out.oauthStates).toBeGreaterThanOrEqual(1);
    const keys = await db(() => Promise.all(['IdempotencyKeys', 'Sessions', 'OAuthStates', 'PairingCodes'].map(e => SELECT.from('medilink.' + e))));
    expect(keys.map(rows => rows.map(r => r.keyHash || r.jti || r.state || r.codeHash))).toEqual([['new-key'], ['new-jti'], expect.arrayContaining(['new-state']), ['new-code']]);
  });

  test('demo accounts still on the development password are found (production refuses to start with them)', async () => {
    expect(await require('../srv/lib/accounts').demoUsersWithDevPassword()).toEqual(expect.arrayContaining(['admin', 'asha']));
  });
});

describe('F7: rate limits and login throttling', () => {
  const xff = ip => ({ headers: { 'X-Forwarded-For': ip } });
  test('5 wrong passwords pause one IP + username (429, Retry-After); the real user on another network still signs in', async () => {
    for (let i = 0; i < 5; i++) expect((await T.axios.post('/auth/login', { username: 'kiran', password: 'wrong-' + i }, xff('203.0.113.7'))).status).toBe(401);
    const paused = await T.axios.post('/auth/login', { username: 'kiran', password: 'demo' }, xff('203.0.113.7'));
    expect(paused.status).toBe(429);
    expect(paused.data.code).toBe('TOO_MANY_LOGIN_ATTEMPTS');
    expect(Number(paused.headers['retry-after'])).toBeGreaterThan(800);
    const t0 = Date.now();
    const other = await T.axios.post('/auth/login', { username: 'kiran', password: 'demo' }, xff('198.51.100.9'));
    expect(other.status).toBe(200); // no lockout anyone can trigger
    expect(Date.now() - t0).toBeGreaterThanOrEqual(900); // ... but after 5 failures every try waits (progressive delay)
  });

  test('pairing, photos (paid LLM call), weather check and /me/actions have limits with Retry-After', async () => {
    for (let i = 0; i < 10; i++) expect((await T.axios.post('/connector/pair', { pairingCode: 'NOPE' + i })).status).toBe(401);
    const pair = await T.axios.post('/connector/pair', { pairingCode: 'NOPE' });
    expect([pair.status, pair.data.code, Number(pair.headers['retry-after']) > 0]).toEqual([429, 'RATE_LIMITED', true]);

    for (let i = 0; i < 10; i++) expect((await post('/sync/uploadPhoto', { imageBase64: 'eA==' }, 'hari')).status).not.toBe(429);
    const photo = await post('/sync/uploadPhoto', { imageBase64: 'eA==' }, 'hari');
    expect([photo.status, Number(photo.headers['retry-after']) > 0]).toEqual([429, true]);
    const viaAction = await post('/me/actions/upload-photo', { imageBase64: 'eA==' }, 'hari'); // same per-user budget
    expect([viaAction.status, viaAction.data.code, Number(viaAction.headers['retry-after']) > 0]).toEqual([429, 'RATE_LIMITED', true]);

    for (let i = 0; i < 5; i++) expect((await post('/odata/v4/routes/checkWeather', {}, 'admin')).status).toBe(200);
    expect((await post('/odata/v4/routes/checkWeather', {}, 'admin')).status).toBe(429);

    for (let i = 0; i < 60; i++) expect((await post('/me/actions/no-such-action', {}, 'lata')).status).toBe(404);
    const acts = await post('/me/actions/no-such-action', {}, 'lata');
    expect([acts.status, acts.data.code, Number(acts.headers['retry-after']) > 0]).toEqual([429, 'RATE_LIMITED', true]);
  });

  test('IPv6 clients are limited per /64; IPv4-mapped addresses are plain IPv4', () => {
    const { ipOf, hit } = require('../srv/lib/ratelimit');
    expect(ipOf({ ip: '2001:db8:1:2:aaaa::1' })).toBe(ipOf({ ip: '2001:db8:1:2:bbbb:cccc:dddd:eeee' }));
    expect(ipOf({ ip: '2001:db8:1:2::1' })).not.toBe(ipOf({ ip: '2001:db8:1:3::1' }));
    expect(ipOf({ ip: '::ffff:10.1.2.3' })).toBe('10.1.2.3');
    expect([hit('t', 2, 1000, 0), hit('t', 2, 1000, 1), hit('t', 2, 1000, 2), hit('t', 2, 1000, 1000)]).toEqual([0, 0, 1, 0]);
  });
});

describe('F3: disconnect (consent withdrawn)', () => {
  test('bookings are erased; frozen stock is no longer offered or counted in the city view', async () => {
    const surplus = rows => rows.reduce((s, r) => s + Number(r.surplus ?? r.citySurplus), 0);
    const city = async () => surplus((await get('/odata/v4/cover/cityView(window=14)', 'admin')).data.value);
    const before = await city();
    const h5 = surplus((await get('/odata/v4/cover/board(window=14,hospital=null)', 'ravi')).data.value);
    expect(h5).toBeGreaterThan(0);

    const r = await post('/onboarding/revokeAccess', {}, 'ravi');
    expect(r.data).toMatchObject({ hospitalId: 'H5', revoked: true });
    const count = e => db(async () => (await SELECT.one.from(e).columns('count(*) as n').where({ hospital_ID: 'H5' })).n);
    expect(await count('medilink.Bookings')).toBe(0);
    expect(await count('medilink.Lots')).toBeGreaterThan(0); // kept: in-flight transfers and receipts read them
    const entry = (await get('/audit/Entries?$orderby=seq desc&$top=5', 'admin')).data.find(e => e.action === 'CONSENT_REVOKED');
    expect(JSON.parse(entry.payload).bookingsPurged).toBeGreaterThan(0);

    expect(await city()).toBe(before - h5);
    const rank = await post('/odata/v4/requests/createRequest', { drug: 'D-CARB450', qty: 5, neededBy: inDays(5), allowBrandSwitch: true }, 'asha');
    const touched = [...rank.data.ranking.plans.flatMap(p => p.legs.map(l => l.hospitalId)), ...rank.data.ranking.exclusions.map(e => e.hospitalId)];
    expect(touched.length).toBeGreaterThan(0);
    expect(touched).not.toContain('H5');
  });
});
