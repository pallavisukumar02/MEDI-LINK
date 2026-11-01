'use strict';
/*
 * Acceptance for the experience layer: the PRD section 18 demo run through /me/* only, as the demo users,
 * asserting journey stage, task cards and plain-language messages at every beat. The only non-/me calls are
 * what is not a person tapping a screen: the MediSoft login popup (the hospital software's own UI) and the
 * courier's temperature logger feed (device telemetry).
 */
require('./helpers/env')({ MEDISOFT_BASE_URL: 'http://localhost:4112', MATCHER_URL: 'http://localhost:5112', MATCHER_FALLBACK_ENABLED: 'false' });
const procs = require('./helpers/procs');
const cds = require('@sap/cds');
const T = cds.test(__dirname + '/..');
T.axios.defaults.validateStatus = () => true;

const as = (user, headers = {}) => ({ auth: { username: user, password: 'demo' }, headers });
const home = async user => { const r = await T.axios.get('/me/home', as(user)); expect(r.status).toBe(200); return r.data; };
const act = (user, a, values = {}, key) => T.axios.post(a.path || `/me/actions/${a}`, { ...(a.body || {}), ...values }, as(user, key ? { 'Idempotency-Key': key } : {}));
const task = (h, kind) => h.tasks.find(x => x.kind === kind);
const journeyOf = (h, id) => h.journeys.find(j => j.id === id);
const telemetry = (body, user = 'sim') => T.axios.post('/odata/v4/delivery/telemetry', body, as(user)); // logger device feed
const H1 = { lat: 12.9299, long: 77.5826 }, H5 = { lat: 12.9255, long: 77.5468 };
const along = f => ({ lat: H5.lat + (H1.lat - H5.lat) * f, long: H5.long + (H1.long - H5.long) * f });
const NO_JARGON = /odata|stack|rule \d|\b[0-9a-f]{8}-[0-9a-f]{4}-|undefined|null\b|\{\w+\}/i;
let medisoft, matcher;
const s = {};

beforeAll(async () => {
  medisoft = await procs.startMedisoft(4112);
  matcher = await procs.startMatcher(5112);
  if (!matcher) throw new Error('Python with ortools/fastapi/uvicorn is required (pip install -r matcher/requirements.txt)');
}, 60000);
afterAll(() => procs.stop(medisoft, matcher));

async function allowInMediSoft(url) {
  const q = Object.fromEntries(new URL(url).searchParams);
  const form = o => new URLSearchParams(o).toString();
  const H = { 'Content-Type': 'application/x-www-form-urlencoded' };
  const login = await fetch('http://localhost:4112/oauth/login', { method: 'POST', headers: H, body: form({ ...q, username: 'pharm.jayanagar', password: 'medisoft-demo' }), redirect: 'manual' });
  const consent = await fetch('http://localhost:4112/oauth/consent', { method: 'POST', headers: { ...H, cookie: login.headers.get('set-cookie').split(';')[0] }, body: form({ ...q, decision: 'allow' }), redirect: 'manual' });
  return T.axios.get(`/oauth/medisoft/callback${new URL(consent.headers.get('location')).search}`);
}

describe('PRD section 18 demo through /me/* only', () => {
  test('1. onboarding checklist: licence + Allow; expired licence refused in plain words', async () => {
    const ob = (await T.axios.get('/me/onboarding', as('asha'))).data;
    expect(ob).toMatchObject({ done: false, current: 'licence' });
    expect(ob.steps.map(x => x.label)).toEqual(['Enter licence', 'Licence checked', 'Connect your system', 'First sync', 'Ready']);
    expect(ob.nextAction).toMatchObject({ id: 'enter-licence', method: 'POST', path: '/me/actions/enter-licence' });
    expect(ob.nextAction.fields.map(f => f.name)).toEqual(['licenceNo']); // the only typed input
    const h0 = await home('asha');
    expect(h0.hospital.connection.text).toBe('Not connected: tap to connect');
    expect(task(h0, 'connect').primaryAction.id).toBe('enter-licence');

    const expired = await act('asha', ob.nextAction, { licenceNo: 'KA-BLR-20B-1004' });
    expect(expired.status).toBe(403);
    expect(expired.data).toEqual({ code: 'LICENCE_EXPIRED', title: 'Your licence has expired', message: expect.stringMatching(/^Your drug licence KA-BLR-20B-1004 expired on \d{1,2} \w{3} \d{4}\.$/), fix: 'Renew it with the Karnataka Drugs Control Department, then try again.', retryable: false });
    const unknown = await act('asha', 'enter-licence', { licenceNo: 'KA-XXX-0000' });
    expect(unknown.data).toMatchObject({ code: 'LICENCE_UNKNOWN', title: 'We could not find this licence' });
    const empty = await act('asha', 'enter-licence', {});
    expect(empty.status).toBe(400);
    expect(empty.data).toMatchObject({ code: 'INVALID_INPUT', message: 'Please fill in "Drug licence number".' });

    const ok = await act('asha', 'enter-licence', { licenceNo: 'KA-BLR-20B-1001' });
    expect(ok.status).toBe(200);
    expect(ok.data.message).toMatch(/City Cancer Hospital, Jayanagar · Licence valid till 2028 · Your stock is in MediSoft HIS/);
    expect(ok.data.next).toMatchObject({ type: 'open', label: 'Allow MediLink to read stock and chemo bookings' });
    expect(ok.data.onboarding).toMatchObject({ current: 'connect' });
    expect(ok.data.onboarding.nextAction.id).toBe('allow-access');
    expect(ok.data.onboarding.fallbacks.map(a => a.id)).toEqual(expect.arrayContaining(['pick-software', 'ask-it-team', 'upload-sheet', 'upload-photo']));
    expect(ok.data.onboarding.fallbacks.find(a => a.id === 'upload-photo')).toMatchObject({ available: false });

    const cb = await allowInMediSoft(ok.data.next.url);
    expect(cb.data).toMatch(/Your board will be ready/);
    const done = (await T.axios.get('/me/onboarding', as('asha'))).data;
    expect(done).toMatchObject({ done: true, message: "You're connected. Your board is ready." });
    const h = await home('asha');
    expect(h.hospital.connection.text).toMatch(/^Connected · synced (just now|\d+ min ago)$/);
    expect(h.hospital.licence).toMatchObject({ status: 'valid' });
    expect(h.onboarding).toBeNull();

    const hari = await home('hari'); // expired licence, still on file
    expect(hari.alerts[0]).toMatchObject({ kind: 'LICENCE_EXPIRY', severity: 'red' });
    expect(hari.alerts[0].message).toMatch(/^Your drug licence expired on /);
  });

  test('2. carboplatin is red: alert, stage-1 journey and a prefilled request card', async () => {
    const h = await home('asha');
    expect(h.coverSummary.red).toBeGreaterThanOrEqual(1);
    expect(h.alerts[0]).toMatchObject({ kind: 'SHORTFALL', severity: 'red', drugId: 'D-CARB450' });
    expect(h.alerts[0].message).toMatch(/^Carboplatin 450 mg: 16 of 40 doses short by \d{1,2} \w{3}$/);
    const j = h.journeys.find(x => x.drug.id === 'D-CARB450');
    expect(j).toMatchObject({ stage: 1, of: 7, stageLabel: 'Shortfall found', colour: 'red', qty: 16, perspective: 'receiver' });
    expect(j.headline).toMatch(/^You're short 16 doses of Carboplatin 450 mg by \d{1,2} \w{3}$/);
    const card = task(h, 'send_request');
    expect(card).toMatchObject({ title: 'Request 16 doses of Carboplatin 450 mg', urgency: expect.stringMatching(/high|medium/) });
    expect(card.subtitle).toMatch(/9 booked patients are affected first/);
    expect(card.primaryAction).toMatchObject({ id: 'send-request', label: 'Request 16 doses', style: 'primary', method: 'POST', body: { drugId: 'D-CARB450', qty: 16 } });
    expect(card.primaryAction.fields.map(f => [f.name, f.type, f.default])).toEqual([['allowBrandSwitch', 'boolean', false], ['note', 'text', undefined]]);
    expect(card.primaryAction.confirm).toMatch(/^Request 16 doses of Carboplatin 450 mg by /);
    s.sendRequest = card.primaryAction;
    for (const text of [j.headline, card.title, card.subtitle, h.alerts[0].message]) expect(text).not.toMatch(NO_JARGON);
  });

  test('3. one tap sends the request (idempotent); flagged / unlicensed stock never offered; nearest ranks first', async () => {
    const r1 = await act('asha', s.sendRequest, { allowBrandSwitch: false }, 'tap-1');
    expect(r1.status).toBe(200);
    expect(r1.data.message).toMatch(/^Request sent. We found \d safe supplier options?\.$/);
    const j = r1.data.journey;
    expect(j).toMatchObject({ stage: 2, stageLabel: 'Request sent', key: 'choose_supplier', colour: 'amber' });
    expect(j.headline).toBe('Found a safe supplier: Banashankari Care Hospital. Tap to ask them.');
    s.request = j.id;
    const again = await act('asha', s.sendRequest, { allowBrandSwitch: false }, 'tap-1');           // double tap, same key
    expect(again.headers['idempotent-replay']).toBe('true');
    expect(again.data).toEqual(r1.data);
    const third = await act('asha', s.sendRequest, { allowBrandSwitch: false });                    // no key: still one request
    expect(third.data.journey.id).toBe(s.request);
    const reqs = (await T.axios.get("/odata/v4/requests/Requests?$filter=drug_ID eq 'D-CARB450'", as('asha'))).data.value;
    expect(reqs).toHaveLength(1);

    const h = await home('asha');
    const card = task(h, 'choose_plan');
    expect(card.title).toBe('Pick a supplier for Carboplatin 450 mg');
    expect(card.subtitle).toMatch(/^Nearest safe option: Banashankari Care Hospital, [\d.]+ km, about \d+ min away$/);
    const plan = card.primaryAction.fields.find(f => f.name === 'plan');
    expect(plan.options[0].label).toMatch(/^Banashankari Care Hospital · [\d.]+ km · about \d+ min · 16 vials$/);
    expect(plan.options[0].reason).toMatch(/near-expiry batch SOL24B077/);
    expect(JSON.stringify(plan.options)).not.toMatch(/Lakeside|Hebbal/); // flagged lot (H3) and expired licence (H4) never offered
    expect(card.secondaryAction.id).toBe('cancel-request');
    const chosen = await act('asha', card.primaryAction, {}, 'tap-2');
    expect(chosen.status).toBe(200);
    expect(chosen.data.journey).toMatchObject({ stage: 3, stageLabel: 'Waiting for supplier', headline: 'Asked Banashankari Care Hospital' });
    s.transfer = chosen.data.journey.transferId;
  });

  test('4. supplier sees its patients stay covered and accepts in kind; two approvers sign', async () => {
    const r = await home('ravi');
    const card = task(r, 'accept_request');
    expect(card).toMatchObject({ title: 'Accept or decline a request', subtitle: "City Cancer Hospital needs 16 vials of Carboplatin 450 mg. You'll still cover your own patients.", urgency: 'high' });
    expect(journeyOf(r, s.request)).toMatchObject({ stage: 3, perspective: 'supplier', headline: "City Cancer Hospital needs 16 vials. You'll still cover your own patients." });
    const qty = card.primaryAction.fields.find(f => f.name === 'quantity');
    expect(qty).toMatchObject({ label: 'How many vials can you give?', type: 'number', default: 16, min: 1, max: 16, required: true });
    expect(card.primaryAction.fields.find(f => f.name === 'repaymentMode').options.map(o => o.value)).toEqual(['IN_KIND', 'LANDED_COST']);
    expect(card.primaryAction.confirm).toBe('Give 16 vials to City Cancer Hospital?');
    expect(card.secondaryAction.id).toBe('decline-request');

    expect(task(await home('sunil'), 'accept_request')).toBeUndefined();
    const notMine = await act('sunil', card.primaryAction, { quantity: 16, repaymentMode: 'IN_KIND' });
    expect(notMine.data).toMatchObject({ code: 'NOT_SUPPLIER', title: 'Not your request' });
    const wrongRole = await act('partner', card.primaryAction, { quantity: 16, repaymentMode: 'IN_KIND' });
    expect(wrongRole.status).toBe(403);
    expect(wrongRole.data.code).toBe('NOT_ALLOWED');

    const acc = await act('ravi', card.primaryAction, { quantity: 16, repaymentMode: 'IN_KIND' }, 'ravi-1');
    expect(acc.data.journey).toMatchObject({ stage: 4, stageLabel: 'Waiting for approval', headline: 'Waiting for sign-off' });
    expect(journeyOf(await home('asha'), s.request).headline).toBe('Supplier said yes, waiting for sign-off');

    const m = await home('meera');
    const ap = task(m, 'approve');
    expect(ap.title).toBe('Approve transfer of 16 vials');
    expect(ap.subtitle).toMatch(/^Carboplatin 450 mg to City Cancer Hospital\. Check: near-expiry stock\.$/);
    const a1 = await act('meera', ap.primaryAction, {}, 'meera-1');
    expect(a1.data.message).toBe('First sign-off done. A second approver must also sign.');
    expect(a1.data.journey.headline).toBe('Waiting for a second sign-off');
    expect(task(await home('meera'), 'approve')).toBeUndefined();                 // she already signed
    const same = await act('meera', ap.primaryAction, {}, 'meera-2');
    expect(same.data).toMatchObject({ code: 'SECOND_SIGNOFF_SAME_USER', title: 'A second person must sign' });
    const k = task(await home('kiran'), 'approve');
    expect(k.subtitle).toMatch(/Second sign-off needed: near-expiry stock/);
    const a2 = await act('kiran', k.primaryAction, {}, 'kiran-1');
    expect(a2.data.message).toBe('Approved. A licensed courier has been assigned.');
    const aj = journeyOf(await home('asha'), s.request);
    expect(aj).toMatchObject({ stage: 5, key: 'waiting_pickup', headline: 'Approved. CoolRoute Logistics (synthetic) will pick it up soon' });
    expect(aj.note).toMatch(/16 vials/); // transfer note written on approval (template, LLM off)
    expect(aj.note).toMatch(/SOL24B077/);
    expect(aj.timeline.map(e => e.text)).toEqual(expect.arrayContaining(['You asked for 16 doses of Carboplatin 450 mg', 'Asked Banashankari Care Hospital', 'Banashankari Care Hospital said yes (repay in kind)', 'Signed off by an approver (1 of 2)', 'Signed off by an approver (2 of 2)']));
    for (const e of aj.timeline) expect(e.time).toMatch(/\d{1,2}:\d{2} (am|pm)$/);
  });

  test('5. pickup, live tracking, road closed -> re-route; temperature spike on another shipment', async () => {
    const p = await home('partner');
    const card = task(p, 'pickup');
    expect(card.title).toBe('Pick up 16 vials at Banashankari Care Hospital');
    expect(card.primaryAction.fields.map(f => [f.name, f.type])).toEqual([['batchNo', 'barcode'], ['sealId', 'barcode'], ['loggerId', 'barcode']]);
    expect(card.primaryAction.fields[0].hint).toBe('Expected: SOL24B077, SOL25A015');
    const bad = await act('partner', card.primaryAction, { batchNo: 'WRONG1', sealId: 'SEAL-9001', loggerId: 'LOG-9001' });
    expect(bad.data).toMatchObject({ code: 'BATCH_MISMATCH', title: 'Wrong batch' });
    const pk = await act('partner', card.primaryAction, { batchNo: 'SOL24B077, SOL25A015', sealId: 'SEAL-9001', loggerId: 'LOG-9001' }, 'pk-1');
    expect(pk.data.journey).toMatchObject({ stage: 5, key: 'on_the_way' });
    expect(pk.data.journey.headline).toMatch(/^Deliver to City Cancer Hospital by ~\d{1,2}:\d{2} (am|pm)$/);
    for (const f of [0.1, 0.3]) expect((await telemetry({ transfer: s.transfer, ...along(f), temperatureC: 24.5 })).data.excursion).toBe(false);
    const aj = journeyOf(await home('asha'), s.request);
    expect(aj.headline).toMatch(/^On the way, arriving ~\d{1,2}:\d{2} (am|pm), 24\.5 °C$/);
    expect(journeyOf(await home('ravi'), s.request).headline).toBe('Picked up');

    const road = journeyOf(await home('partner'), s.request).actions.find(a => a.id === 'report-road-closed');
    const rc = await act('partner', road, { note: 'Silk Board junction' }, 'rc-1');
    expect(rc.data.message).toMatch(/^Re-routed\. New arrival time about \d{1,2}:\d{2} (am|pm)\.$/);
    expect(journeyOf(await home('asha'), s.request)).toMatchObject({ key: 'rerouted', colour: 'amber' });
    expect(journeyOf(await home('asha'), s.request).headline).toMatch(/^Re-routed around Silk Board junction, new ETA \d{1,2}:\d{2} (am|pm)$/);

    await telemetry({ loggerId: 'LOG-7781', lat: 12.95, long: 77.69, temperatureC: 11.4 }); // seeded H2 -> H3 cold-chain shipment
    const lata = await home('lata');
    expect(lata.alerts[0]).toMatchObject({ kind: 'EXCURSION', severity: 'red', message: "Temperature went out of range on the Trastuzumab 440 mg delivery. Don't use until checked." });
    const lj = lata.journeys.find(j => j.drug.id === 'D-TRAS440');
    expect(lj).toMatchObject({ key: 'excursion', colour: 'red', headline: "Temperature went out of range. Don't use until checked" });
    expect(lj.timeline.some(e => e.text === 'Temperature went out of range (11.4 °C)')).toBe(true);
    expect((await home('sunil')).journeys.find(j => j.drug.id === 'D-TRAS440').headline).toBe('Temperature went out of range on the way');
  });

  test('6. arrival: scan, failed check explained, accept; coverage green; loan shown to both sides', async () => {
    await telemetry({ transfer: s.transfer, ...along(0.98), temperatureC: 25.1 });
    const h = await home('asha');
    expect(journeyOf(h, s.request)).toMatchObject({ stage: 6, stageLabel: 'Arrived', headline: 'Arrived. Check and accept' });
    expect(journeyOf(await home('ravi'), s.request).headline).toBe('Delivered');
    const card = task(h, 'arrival');
    expect(card).toMatchObject({ title: 'Scan the delivery that just arrived', subtitle: '16 vials of Carboplatin 450 mg from Banashankari Care Hospital' });
    expect(card.primaryAction.id).toBe('accept-delivery');
    expect(card.secondaryAction.id).toBe('quarantine-delivery');
    expect(card.primaryAction.fields.find(f => f.name === 'qtyReceived').default).toBe(16);
    const fail = await act('asha', card.primaryAction, { batchNo: 'SOL24B077,SOL25A015', sealIntact: false, qtyReceived: 16 });
    expect(fail.status).toBe(409);
    expect(fail.data).toMatchObject({ code: 'PROOF_OF_CONDITION_FAILED', title: 'Cannot accept into stock', fix: expect.stringMatching(/quarantine/), retryable: false });
    const ok = await act('asha', card.primaryAction, { batchNo: 'SOL24B077,SOL25A015', sealIntact: true, qtyReceived: 16 }, 'arr-1');
    expect(ok.status).toBe(200);
    expect(ok.data.journey).toMatchObject({ stage: 7, stageLabel: 'Done', colour: 'green', headline: '40 of 40 doses covered' });
    const after = await home('asha');
    expect(after.coverSummary.red).toBe(0);
    expect(after.coverSummary.emptyText).toBe('All your critical drugs are covered for the next 14 days.');
    expect(after.alerts.some(a => a.kind === 'SHORTFALL')).toBe(false);
    const repay = task(after, 'repay');
    expect(repay).toMatchObject({ title: 'Repay a loan', urgency: 'low' });
    expect(repay.subtitle).toMatch(/^You owe Banashankari Care Hospital 16 vials of Carboplatin 450 mg \(or ₹29,600\)$/);
    expect(journeyOf(await home('ravi'), s.request).headline).toBe('Loan of 16 vials open: repay in kind or at cost');

    const m = (await T.axios.get('/admin/metrics', as('admin'))).data.metrics;
    const by = id => m.find(x => x.id === id);
    expect(by('flaggedLotsMoved')).toMatchObject({ value: 0, met: true });
    expect(by('traceCompletenessPct')).toMatchObject({ value: 100, met: true });
    expect(by('requestToAcceptanceMin').count).toBeGreaterThanOrEqual(1);
    expect(by('onboardingTimeSec')).toMatchObject({ count: 1, met: true });
    expect(by('alertLeadTimeDays').count).toBeGreaterThanOrEqual(1);
    expect((await T.axios.get('/admin/metrics', as('asha'))).status).toBe(403);
    expect((await T.axios.get('/audit/verify', as('admin'))).data.ok).toBe(true);
  });

  test('7. city view: aggregated, anonymised, plain language', async () => {
    const c = (await T.axios.get('/me/city', as('admin'))).data;
    const carb = c.rows.find(r => r.drugId === 'D-CARB450');
    expect(carb).toMatchObject({ hospitalsShort: 0, dosesShort: 0 });
    expect(carb.text).toMatch(/^Carboplatin 450 mg: 0 hospital\(s\) short of 0 doses; \d+ spare across the city$/);
    expect(JSON.stringify(c)).not.toMatch(/"H[1-5]"|Jayanagar|Banashankari|Whitefield|patientRef/);
  });
});
