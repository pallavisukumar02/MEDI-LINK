'use strict';
/*
 * End-to-end: the PRD section 18 three-minute demo script against the synthetic seed data,
 * with the real mock MediSoft OAuth server and the real OR-Tools matcher as child processes.
 * No SAP credentials are used.
 */
require('./helpers/env')({ MATCHER_FALLBACK_ENABLED: 'false' });
const procs = require('./helpers/procs');
const cds = require('@sap/cds');
const T = cds.test(__dirname + '/..');
T.axios.defaults.validateStatus = () => true;
const ws = require('../srv/lib/ws');

const as = user => ({ auth: { username: user, password: 'demo' } });
const get = (url, user) => T.axios.get(url, as(user));
const post = (url, body, user) => T.axios.post(url, body, as(user));
const courier = (url, body, token) => T.axios.post(url, body, { headers: { Authorization: 'Courier ' + token } }); // the rider's phone / logger
const linkOf = async transfer => (await get('/admin/courier-links', 'admin')).data.links.find(l => l.transferId === transfer).token;
const events = [];
let medisoft, matcher;

beforeAll(async () => {
  medisoft = await procs.startMedisoft();
  matcher = await procs.startMatcher();
  if (!matcher) throw new Error('Python with ortools/fastapi/uvicorn is required for the e2e test (pip install -r matcher/requirements.txt)');
  Object.assign(process.env, { MEDISOFT_BASE_URL: medisoft.url, MATCHER_URL: matcher.url }); require('../srv/lib/config').reload();
  ws.listeners.add((event, data) => events.push({ event, data }));
}, 60000);
afterAll(() => procs.stop(medisoft, matcher));

const state = {};
async function oauthAllow(authorizeUrl, username) {
  const u = new URL(authorizeUrl);
  const form = o => new URLSearchParams(o).toString();
  const H = { 'Content-Type': 'application/x-www-form-urlencoded' };
  const q = Object.fromEntries(u.searchParams);
  const login = await fetch(`${medisoft.url}/oauth/login`, { method: 'POST', headers: H, body: form({ ...q, username, password: 'medisoft-demo' }), redirect: 'manual' });
  const cookie = login.headers.get('set-cookie').split(';')[0];
  const consent = await fetch(`${medisoft.url}/oauth/consent`, { method: 'POST', headers: { ...H, cookie }, body: form({ ...q, decision: 'allow' }), redirect: 'manual' });
  const cb = new URL(consent.headers.get('location'));
  return T.axios.get(`/oauth/medisoft/callback${cb.search}`); // the "browser" follows the redirect to CAP
}

describe('PRD section 18 demo script', () => {
  test('1. onboard live with licence + Allow; expired licence is refused', async () => {
    const expired = await post('/onboarding/licence', { licenceNo: 'KA-BLR-20B-1004' }, 'asha');
    expect(expired.status).toBe(403);
    expect(expired.data.error.code).toBe('LICENCE_EXPIRED');
    const unknown = await post('/onboarding/licence', { licenceNo: 'KA-XXX-0000' }, 'asha');
    expect(unknown.data.error.code).toBe('LICENCE_UNKNOWN');

    const r = await post('/onboarding/licence', { licenceNo: 'KA-BLR-20B-1001' }, 'asha');
    expect(r.status).toBe(200);
    expect(r.data.message).toMatch(/City Cancer Hospital, Jayanagar · Licence valid till 2028 · Your stock is in MediSoft HIS/);
    expect(r.data.next).toBe('OAUTH_ALLOW');
    const cb = await oauthAllow(r.data.authorizeUrl, 'pharm.jayanagar'); // mock MediSoft requires PKCE S256
    expect(cb.status).toBe(200);
    expect(cb.data).toMatch(/Your board will be ready/);
    expect(cb.data).toContain(',"http://localhost:4004")'); // postMessage only to MediLink's own origin
    expect(cb.data).not.toContain("'*'");
    const st = await get('/onboarding/status', 'asha');
    expect(st.data.connected).toBe(true);
    expect(st.data.consents[0]).toMatchObject({ provider: 'MEDISOFT', scopes: 'stock.read schedule.read' });
  });

  test('2. carboplatin is red: 16 of 40 booked doses uncovered, 9 patients affected first', async () => {
    const b = await get('/odata/v4/cover/board(window=14,hospital=null)', 'asha');
    expect(b.status).toBe(200);
    const carb = b.data.value[0];
    expect(carb).toMatchObject({ drugId: 'D-CARB450', status: 'RED', booked: 40, shortfall: 16, patientsAffected: 9 });
    expect(carb.message).toBe('16 of 40 booked doses short, 9 patients affected first');
    const card = await get("/odata/v4/cover/shortfall(drug='D-CARB450',window=14,hospital=null)", 'asha');
    expect(card.data.affected).toHaveLength(9);
    expect(card.data.affected.some(a => a.curative)).toBe(true);
    for (const a of card.data.affected) expect(a.patientRefShort).toMatch(/^[a-f0-9]{10}$/);
    expect(card.data.prefill).toMatchObject({ qty: 16, preferredBrand: 'Carbokem' });
    state.neededBy = card.data.prefill.neededBy;
  });

  test('3. prefilled request: flagged lot and unlicensed site drop out, nearest eligible hospital ranks first', async () => {
    const r = await post('/odata/v4/requests/createRequest', { drug: 'D-CARB450' }, 'asha');
    expect(r.status).toBe(200);
    expect(r.data).toMatchObject({ qty: 16, neededBy: state.neededBy, status: 'MATCHED' });
    const k = r.data.ranking;
    expect(k.engine).toBe('ortools-cp-sat');
    const codes = {};
    for (const e of k.exclusions) (codes[e.lotId] ||= []).push(e.code);
    expect(codes['H3-CARB-A']).toContain('FLAGGED_BATCH');            // rule 2
    expect(codes['H1-CARB-A']).toBeUndefined();                     // receiver's own stock is never a candidate
    expect(k.exclusions.every(e => e.rule >= 1 && e.rule <= 8 && e.detail)).toBe(true);
    expect(codes['H4-CARB-A']).toContain('SUPPLIER_LICENCE_INVALID'); // rule 6
    expect(codes['H3-CARB-B']).toContain('NO_GENUINE_SURPLUS');       // rule 1
    expect(codes['H2-CARB-D']).toContain('NOT_SEALED');               // rule 3
    expect(codes['H2-CARB-C']).toContain('EXPIRES_TOO_SOON');         // rule 4
    expect(codes['H5-CARB-C']).toContain('STORAGE_MISMATCH');         // rule 5
    expect(codes['H2-C150-A']).toContain('DIFFERENT_MEDICINE');       // rule 7
    expect(codes['H2-CARB-B']).toContain('BRAND_SWITCH_NOT_ALLOWED'); // rule 7
    const p1 = k.plans[0];
    expect(p1.legs[0].hospitalId).toBe('H5');
    expect(p1).toMatchObject({ rank: 1, totalQty: 16, transfers: 1, fullyCovers: true });
    expect(p1.reason).toMatch(/Nearest eligible hospital: Banashankari Care Hospital/);
    expect(p1.reason).toMatch(/near-expiry batch SOL24B077/);
    expect(k.plans.length).toBeGreaterThan(1);
    state.request = r.data.request;
  });

  test('4. supplier sees own bookings stay covered, accepts in kind; approver signs (second sign-off for near-expiry)', async () => {
    const t = await post('/odata/v4/requests/choosePlan', { request: state.request, rank: 1 }, 'asha');
    expect(t.status).toBe(200);
    const tr = t.data.value[0];
    expect(tr).toMatchObject({ status: 'PENDING_SUPPLIER', supplierId: 'H5', receiverId: 'H1', qty: 16, requiresSecondSignoff: true });
    expect(tr.riskReasons).toMatch(/NEAR_EXPIRY/);
    state.transfer = tr.ID;

    expect((await get(`/odata/v4/supplier/review(transfer=${tr.ID})`, 'sunil')).status).toBe(403); // not the supplier
    const rv = await get(`/odata/v4/supplier/review(transfer=${tr.ID})`, 'ravi');
    expect(rv.data.ownBookingsStayCovered).toBe(true);
    expect(rv.data.coverAfter.shortfall).toBe(0);
    const acc = await post('/odata/v4/supplier/accept', { transfer: tr.ID, repaymentMode: 'IN_KIND' }, 'ravi');
    expect(acc.data.status).toBe('PENDING_APPROVAL');

    const a1 = await post('/odata/v4/approval/approveTransfer', { transfer: tr.ID }, 'meera');
    expect(a1.data.status).toBe('PENDING_SECOND_APPROVAL');
    const same = await post('/odata/v4/approval/approveTransfer', { transfer: tr.ID }, 'meera');
    expect(same.data.error.code).toBe('SECOND_SIGNOFF_SAME_USER');
    const a2 = await post('/odata/v4/approval/approveTransfer', { transfer: tr.ID }, 'kiran');
    expect(a2.data).toMatchObject({ status: 'ASSIGNED', partnerId: 'P1' });

    const loans = await get('/odata/v4/ledger/Loans', 'asha');
    expect(loans.data.value.find(l => l.transfer_ID === tr.ID)).toMatchObject({ lender_ID: 'H5', borrower_ID: 'H1', qty: 16, status: 'OPEN', repaymentMode: 'IN_KIND' });
  });

  test('5. road flooded: route re-plans; temperature spike on another shipment raises a quarantine alert', async () => {
    state.token = await linkOf(state.transfer); // the courier's link, minted when the partner was assigned
    const pk = await courier('/courier/pickup', { batchNo: 'SOL24B077, SOL25A015', sealId: 'SEAL-9001', loggerId: 'LOG-9001' }, state.token);
    expect(pk.data.job.status).toBe('IN_TRANSIT');
    const h1 = { lat: 12.9299, long: 77.5826 }, h5 = { lat: 12.9255, long: 77.5468 };
    for (const f of [0.1, 0.3]) {
      const tl = await courier('/courier/location', { lat: h5.lat + (h1.lat - h5.lat) * f, long: h5.long + (h1.long - h5.long) * f, temperatureC: 24.5, sealStatus: 'INTACT' }, state.token);
      expect(tl.data).toMatchObject({ accepted: true, excursion: false });
    }
    const before = (await get(`/odata/v4/admin/Transfers(${state.transfer})`, 'admin')).data;
    const rc = await post('/odata/v4/routes/setRouteClosed', { transfer: state.transfer, closed: true, note: 'Flooded underpass (demo)' }, 'admin');
    expect(rc.status).toBe(200);
    expect(rc.data).toMatchObject({ open: true, closed: true });
    expect(Number(rc.data.distanceKm)).toBeGreaterThan(0);
    expect(rc.data.note).toMatch(/Detour around Flooded underpass/);
    expect(events.some(e => e.event === 'replan' && e.data.transferId === state.transfer)).toBe(true);
    expect(before.etaMin).toBeDefined();

    // seeded cold-chain shipment H2 -> H3 (trastuzumab 2-8 °C)
    const cold = 'a0000000-0000-4000-8000-000000000001';
    const ex = await courier('/courier/location', { lat: 12.95, long: 77.69, temperatureC: 11.4 }, await linkOf(cold));
    expect(ex.data).toMatchObject({ excursion: true });
    const ev = events.find(e => e.event === 'excursion');
    expect(ev.data).toMatchObject({ transferId: cold, quarantineSuggested: true, range: '2-8' });
    const n = await get("/odata/v4/admin/Notifications?$filter=kind eq 'EXCURSION'", 'admin');
    expect(n.data.value.map(x => x.hospital_ID).sort()).toEqual(['H2', 'H3']);
  });

  test('6. arrival: proof of condition passes, coverage turns green, ledger shows the loan, audit chain verifies', async () => {
    await courier('/courier/location', { lat: 12.9295, long: 77.5800, temperatureC: 25.1 }, state.token);
    const bad = await post('/odata/v4/receipt/arrivalScan', { transfer: state.transfer, batchNo: 'SOL24B077,SOL25A015', sealIntact: false, qtyReceived: 16, decision: 'ACCEPT' }, 'asha');
    expect(bad.data.error.code).toBe('PROOF_OF_CONDITION_FAILED');
    const ok = await post('/odata/v4/receipt/arrivalScan', { transfer: state.transfer, batchNo: 'SOL24B077,SOL25A015', sealIntact: true, qtyReceived: 16, decision: 'ACCEPT' }, 'asha');
    expect(ok.status).toBe(200);
    expect(ok.data).toMatchObject({ status: 'DELIVERED', proofOfCondition: 'PASS', coverStatus: 'GREEN' });
    const b = await get('/odata/v4/cover/board(window=14,hospital=null)', 'asha');
    expect(b.data.value.find(r => r.drugId === 'D-CARB450')).toMatchObject({ status: 'GREEN', shortfall: 0, covered: 40 });
    const req = (await get(`/odata/v4/requests/Requests(${state.request})`, 'asha')).data;
    expect(req.status).toBe('FULFILLED');
    const loan = (await get('/odata/v4/ledger/Loans', 'ravi')).data.value.find(l => l.transfer_ID === state.transfer);
    expect(loan).toMatchObject({ status: 'OPEN', qty: 16 });
    const v = await get('/audit/verify', 'admin');
    expect(v.status).toBe(200);
    expect(v.data.ok).toBe(true);
    const actions = (await get('/audit/Entries?$orderby=seq', 'admin')).data.map(e => e.action);
    for (const a of ['CONSENT_GRANTED', 'REQUEST_CREATED', 'RULES_APPLIED', 'PLAN_CHOSEN', 'SUPPLIER_ACCEPTED', 'LEDGER_LOAN_RECORDED', 'APPROVED', 'PARTNER_ASSIGNED', 'COURIER_LINK_ISSUED', 'PICKUP', 'ROUTE_REPLANNED', 'EXCURSION', 'ARRIVAL'])
      expect(actions).toContain(a);
  });

  test('7. city view: aggregated, anonymised shortfalls for distributors and the state body', async () => {
    const c = await get('/odata/v4/cover/cityView(window=14)', 'admin');
    expect(c.status).toBe(200);
    const carb = c.data.value.find(r => r.drugId === 'D-CARB450');
    expect(carb).toMatchObject({ hospitalsShort: 0, dosesShort: 0 });
    expect(carb.dosesBooked).toBeGreaterThanOrEqual(40);
    expect(JSON.stringify(c.data)).not.toMatch(/"H[1-5]"|Jayanagar|Banashankari|Whitefield|patientRef/);
  });
});
