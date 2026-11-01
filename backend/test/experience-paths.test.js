'use strict';
/*
 * Experience layer side paths: every detour maps onto the same journey with a clear message, never a bare error.
 * decline -> next supplier · approver rejects (with reason) -> no other supplier · try again · cancel ·
 * recall of the lot -> transfer cancelled · supplier silence -> next supplier. Plus dispatcher behaviour:
 * concurrent double tap, unknown action, bad JSON, not signed in.
 * Ranking uses the built-in fallback (no Python needed).
 */
require('./helpers/env')({ MATCHER_URL: 'http://localhost:1', MATCHER_FALLBACK_ENABLED: 'true' });
const cds = require('@sap/cds');
const T = cds.test(__dirname + '/..');
T.axios.defaults.validateStatus = () => true;
const ingestH1 = require('./helpers/h1');

const as = (user, headers = {}) => ({ auth: { username: user, password: 'demo' }, headers });
const home = async user => (await T.axios.get('/me/home', as(user))).data;
const act = (user, a, values = {}, key) => T.axios.post(a.path || `/me/actions/${a}`, { ...(a.body || {}), ...values }, as(user, key ? { 'Idempotency-Key': key } : {}));
const task = (h, kind) => h.tasks.find(x => x.kind === kind);
const jOf = (h, id) => h.journeys.find(j => j.id === id);
const s = {};

beforeAll(async () => { await ingestH1(); });

async function requestCarboplatin() {
  const card = task(await home('asha'), 'send_request');
  expect(card).toBeDefined();
  const r = await act('asha', card.primaryAction, { allowBrandSwitch: false });
  expect(r.status).toBe(200);
  return r.data.journey;
}

describe('side paths keep the same journey, with a clear message', () => {
  test('supplier declines -> "said no, asking the next nearest hospital"', async () => {
    const j = await requestCarboplatin();
    s.req1 = j.id;
    const chosen = await act('asha', j.actions.find(a => a.id === 'choose-plan'));
    expect(chosen.data.journey.headline).toBe('Asked Banashankari Care Hospital');
    const dec = task(await home('ravi'), 'accept_request').secondaryAction;
    expect(dec.fields[0].options.map(o => o.value)).toEqual(['OWN_PATIENTS', 'RESERVED', 'QUALITY', 'OTHER']);
    const noReason = await act('ravi', dec, {});
    expect(noReason.data).toMatchObject({ code: 'INVALID_INPUT', title: 'Check what you entered' });
    const out = await act('ravi', dec, { reasonCode: 'OWN_PATIENTS' });
    expect(out.data.message).toBe('Declined. MediLink will ask the next nearest hospital.');
    expect(out.data.journey).toMatchObject({ key: 'declined', colour: 'grey', headline: 'You said no' });

    const aj = jOf(await home('asha'), s.req1);
    expect(aj).toMatchObject({ stage: 3, key: 'waiting_supplier_fallback', colour: 'amber' });
    expect(aj.headline).toBe('Banashankari Care Hospital said no. Asking the next nearest hospital: Sanjeevani Hospital');
    expect(aj.timeline.map(e => e.text)).toEqual(expect.arrayContaining(['Asked Banashankari Care Hospital', 'Banashankari Care Hospital said no', 'Asked Sanjeevani Hospital']));
    expect(task(await home('sunil'), 'accept_request').title).toBe('Accept or decline a request');
  });

  test('approver rejects with a reason -> no other supplier -> try again -> cancel', async () => {
    const acc = task(await home('sunil'), 'accept_request');
    await act('sunil', acc.primaryAction, { repaymentMode: 'LANDED_COST' });
    const rej = task(await home('anil'), 'approve').secondaryAction;
    expect(rej).toMatchObject({ id: 'reject-transfer', label: 'Reject' });
    const noWhy = await act('anil', rej, {});
    expect(noWhy.status).toBe(400);
    const r = await act('anil', rej, { reason: 'Batch paperwork missing' });
    expect(r.data.message).toBe('Rejected. MediLink will ask the next nearest hospital.');
    expect(jOf(await home('sunil'), s.req1)).toMatchObject({ key: 'rejected', headline: 'Sign-off refused: Batch paperwork missing' });

    const h = await home('asha');
    expect(jOf(h, s.req1)).toMatchObject({ stage: 2, key: 'no_match', colour: 'red', headline: 'No safe supplier can help right now' });
    const again = task(h, 'find_again');
    expect(again.title).toBe('No supplier yet for Carboplatin 450 mg');
    const tried = await act('asha', again.primaryAction);
    expect(tried.data.message).toBe('Still no safe supplier. Try again later.');
    const cancel = jOf(await home('asha'), s.req1).actions.find(a => a.id === 'cancel-request');
    expect(cancel.confirm).toMatch(/^Cancel this request\?/);
    const c = await act('asha', cancel);
    expect(c.data.journey).toMatchObject({ key: 'cancelled', colour: 'grey', headline: 'You cancelled this request' });
  });

  test('recall of the lot -> "This batch was recalled. Transfer cancelled"', async () => {
    const j = await requestCarboplatin();
    s.req2 = j.id;
    expect(j.id).not.toBe(s.req1); // the cancelled request does not block a new one
    await act('asha', j.actions.find(a => a.id === 'choose-plan'));
    await act('ravi', task(await home('ravi'), 'accept_request').primaryAction, { repaymentMode: 'IN_KIND' });
    await act('meera', task(await home('meera'), 'approve').primaryAction);
    await act('kiran', task(await home('kiran'), 'approve').primaryAction);
    expect(task(await home('partner'), 'pickup')).toBeDefined();

    const rc = await T.axios.post('/odata/v4/trust/recall', { batchNo: 'SOL24B077', reason: 'RECALL', source: 'Synthetic recall for the test' }, as('admin'));
    expect(rc.data.transfersCancelled).toBe(1);
    const h = await home('asha');
    expect(jOf(h, s.req2)).toMatchObject({ key: 'recalled', colour: 'red', headline: 'This batch was recalled. Transfer cancelled' });
    expect(jOf(h, s.req2).timeline.at(-1).text).toBe('This batch was recalled. Transfer cancelled');
    expect(task(h, 'find_again')).toBeDefined();
    const p = await home('partner');
    expect(task(p, 'pickup')).toBeUndefined();
    expect(jOf(p, s.req2).headline).toBe('This batch was recalled. Do not pick it up');
    const ravi = await home('ravi');
    expect(ravi.alerts.find(a => a.kind === 'RECALL').message).toBe('Batch SOL24B077 of Carboplatin 450 mg is on a recall alert. Keep it aside; MediLink will never offer it.');
  });

  test('supplier silence -> "didn\'t answer in time", next hospital asked', async () => {
    const again = await act('asha', task(await home('asha'), 'find_again').primaryAction);
    expect(again.data.journey.key).toBe('choose_supplier');
    const chosen = await act('asha', again.data.journey.actions.find(a => a.id === 'choose-plan'));
    const first = chosen.data.journey.counterpart;
    await cds.tx(() => require('../srv/lib/workflow').timeoutSweep(new Date(Date.now() + 31 * 60000)));
    const aj = jOf(await home('asha'), s.req2);
    expect(aj.timeline.some(e => e.text === `${first} didn't answer in 30 minutes`)).toBe(true);
    if (aj.key === 'waiting_supplier_fallback') expect(aj.headline).toMatch(new RegExp(`^${first} didn't answer in time\\. Asking the next nearest hospital: `));
    else expect(aj.key).toBe('no_match');
  });
});

describe('dispatcher', () => {
  test('a concurrent double tap with one Idempotency-Key runs the action once', async () => {
    const before = (await T.axios.get('/odata/v4/requests/Requests', as('asha'))).data.value.length;
    const card = task(await home('asha'), 'send_request') || null;
    // cisplatin is covered; force a request card through the action itself
    const a = card?.primaryAction || { path: '/me/actions/send-request', body: { drugId: 'D-CISP50', qty: 1, neededBy: new Date(Date.now() + 5 * 86400000).toISOString().slice(0, 10) } };
    const [r1, r2] = await Promise.all([act('asha', a, {}, 'same-key'), act('asha', a, {}, 'same-key')]);
    expect([r1.status, r2.status].sort()).toEqual(expect.arrayContaining([200]));
    for (const r of [r1, r2]) expect([200, 409]).toContain(r.status);
    const conflict = [r1, r2].find(r => r.status === 409);
    if (conflict) expect(conflict.data).toMatchObject({ code: 'ACTION_IN_PROGRESS', retryable: true });
    const after = (await T.axios.get('/odata/v4/requests/Requests', as('asha'))).data.value.length;
    expect(after - before).toBeLessThanOrEqual(1);
  });

  test('unknown action, bad JSON, not signed in, wrong role: all plain-language', async () => {
    const u = await act('asha', 'launch-rocket');
    expect(u.status).toBe(404);
    expect(u.data).toMatchObject({ code: 'UNKNOWN_ACTION', title: 'Unknown action', retryable: false });
    const bad = await T.axios.post('/me/actions/send-request', '{nope', { ...as('asha'), headers: { 'Content-Type': 'application/json' } });
    expect(bad.status).toBe(400);
    expect(bad.data).toMatchObject({ code: 'INVALID_INPUT', message: 'The request body is not valid JSON.' });
    expect((await T.axios.get('/me/home')).status).toBe(401);
    const role = await act('meera', 'send-request', { drugId: 'D-CARB450' });
    expect(role.data).toMatchObject({ code: 'NOT_ALLOWED', title: 'Not available for your role' });
    const nf = await T.axios.get('/me/journeys/00000000-0000-4000-8000-000000000000', as('asha'));
    expect(nf.status).toBe(404);
    expect(nf.data.code).toBe('NOT_FOUND');
  });

  test('every role gets a home screen with friendly empty states', async () => {
    const admin = await home('admin');
    expect(admin).toMatchObject({ greeting: 'MediLink across the city', hospital: null });
    const p2 = await home('courier2');
    expect(p2.partner.name).toBe('QuickMeds Couriers (synthetic)');
    expect(p2.empty).toMatchObject({ tasks: 'Nothing needs you right now.', journeys: 'No pickups assigned to you right now.' });
    const deepa = await home('deepa');
    expect(deepa.greeting).toBe('Sign-offs for your hospital');
    expect(deepa.onboarding).toBeNull(); // onboarding is for pharmacists
    const bpa = await T.axios.get('/me/home', as('bpa'));
    expect(bpa.status).toBe(200);
  });
});
