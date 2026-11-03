'use strict';
/*
 * The requesting pharmacist chooses the supplier(s) from the price vs distance chart (choose-suppliers):
 * any hospital that passes the 8 hard rules, not only the matcher's top plans; up to three to split one order.
 * The rules run again on live stock when the request is sent; every choice is in the audit chain.
 */
require('./helpers/env')({ MATCHER_URL: 'http://localhost:1', MATCHER_FALLBACK_ENABLED: 'true' });
const cds = require('@sap/cds');
const T = cds.test(__dirname + '/..');
T.axios.defaults.validateStatus = () => true;
const ingestH1 = require('./helpers/h1');

const as = user => ({ auth: { username: user, password: 'demo' } });
const act = (user, id, body) => T.axios.post(`/me/actions/${id}`, body, as(user));
const choose = (user, requestId, hospitals) => act(user, 'choose-suppliers', { requestId, hospitals });
const transfersOf = id => cds.tx(() => SELECT.from('medilink.Transfers').where({ request_ID: id }).orderBy('createdAt'));
const lastAudit = action => cds.tx(() => SELECT.one.from('medilink.AuditLog').where({ action }).orderBy('seq desc'));
async function newRequest(qty) {
  const card = (await T.axios.get('/me/home', as('asha'))).data.tasks.find(t => t.kind === 'send_request' && t.primaryAction.body.drugId === 'D-CARB450');
  const r = await act('asha', 'send-request', { ...card.primaryAction.body, ...(qty ? { qty } : {}) });
  expect(r.status).toBe(200);
  return r.data.journey.id;
}

beforeAll(async () => { await ingestH1(); });

describe('choosing from the chart', () => {
  let requestId;
  beforeAll(async () => { requestId = await newRequest(); });

  test('every safe hospital on the chart can be asked', async () => {
    const d = (await T.axios.get(`/me/journeys/${requestId}/prices`, as('asha'))).data;
    expect(d).toMatchObject({ canChoose: true, maxSuppliers: 3 });
    expect(d.points.map(p => [p.hospitalId, p.action?.id, p.action?.body?.hospitals])).toEqual([['H5', 'choose-suppliers', 'H5'], ['H2', 'choose-suppliers', 'H2']]);
    expect(d.points[1].action).toMatchObject({ label: 'Ask Sanjeevani Hospital', confirm: 'Ask Sanjeevani Hospital for 16 vials?' });
  });

  test('a hospital that fails the safety rules is refused in plain words; nothing is sent', async () => {
    const flagged = await choose('asha', requestId, 'H3');
    expect(flagged.status).toBe(409);
    expect(flagged.data).toMatchObject({ code: 'SUPPLIER_NOT_ELIGIBLE', title: 'This hospital can no longer lend', message: expect.stringMatching(/^Lakeside Oncology Centre cannot lend this right now \(.+\)\.$/) });
    expect((await choose('asha', requestId, 'H4')).data.message).toMatch(/^Hebbal Community Hospital cannot lend this right now/);
    expect(await transfersOf(requestId)).toEqual([]);
  });

  test('a second hospital that is not needed, too many hospitals, or another hospital\'s request: refused', async () => {
    expect((await choose('asha', requestId, 'H5,H2')).data).toMatchObject({ code: 'SUPPLIER_NOT_NEEDED', message: 'The hospitals before Sanjeevani Hospital already cover all 16 vials.' });
    expect((await choose('asha', requestId, 'H5,H2,H3,H4')).data.code).toBe('INVALID_INPUT');
    expect((await choose('ravi', requestId, 'H2')).status).toBe(403);
    expect(await transfersOf(requestId)).toEqual([]);
  });

  test('asking the cheaper, farther hospital instead of the matcher\'s first pick', async () => {
    const r = await choose('asha', requestId, 'H2');
    expect(r.status).toBe(200);
    expect(r.data.message).toBe('Asked Sanjeevani Hospital. They have 30 minutes to answer.');
    expect(r.data.journey).toMatchObject({ stage: 3, headline: 'Asked Sanjeevani Hospital' });
    const ts = await transfersOf(requestId);
    expect(ts.map(t => [t.supplier_ID, t.qty, t.status])).toEqual([['H2', 16, 'PENDING_SUPPLIER']]);
    const plan = await cds.tx(() => SELECT.one.from('medilink.Plans').where({ request_ID: requestId, rank: ts[0].planRank }));
    expect(plan).toMatchObject({ engine: 'pharmacist-choice', totalQty: 16 });
    const a = JSON.parse((await lastAudit('SUPPLIERS_CHOSEN')).payload);
    expect(a).toMatchObject({ request: requestId, hospitals: ['H2'], qty: 16, matcherFirst: ['H5'], sameAsMatcher: false });
    expect(a.total).toBeGreaterThan(0);
    expect((await T.axios.get(`/me/journeys/${requestId}/prices`, as('asha'))).data.canChoose).toBe(false);
    expect((await choose('asha', requestId, 'H5')).data.code).toBe('PLAN_ALREADY_CHOSEN');
    expect((await cds.tx(() => require('../srv/lib/audit').verify())).ok).toBe(true);
  });

  test('split order: the first hospital gives what it safely can, the second the rest', async () => {
    expect((await act('asha', 'cancel-request', { requestId })).status).toBe(200);
    const big = await newRequest(40);
    const d = (await T.axios.get(`/me/journeys/${big}/prices`, as('asha'))).data;
    const h5 = d.points.find(p => p.hospitalId === 'H5');
    expect(h5.qty).toBeLessThan(40); // Banashankari alone cannot cover 40
    const r = await choose('asha', big, 'H5,H2');
    expect(r.status).toBe(200);
    const ts = await transfersOf(big);
    expect(ts.map(t => t.supplier_ID)).toEqual(['H5', 'H2']);
    expect(ts[0].qty).toBe(h5.qty);
    const total = ts.reduce((s, t) => s + t.qty, 0);
    expect(r.data.message).toMatch(total < 40 ? new RegExp(`^Asked Banashankari Care Hospital and Sanjeevani Hospital\\. Together they give ${total} of 40 vials\\.`) : /^Asked Banashankari Care Hospital and Sanjeevani Hospital\. They have/);
    // each supplier sees only its own part and accepts as usual
    const ravi = (await T.axios.get('/me/home', as('ravi'))).data.tasks.find(t => t.kind === 'accept_request');
    expect(ravi.primaryAction.fields.find(f => f.name === 'quantity')).toMatchObject({ default: h5.qty, max: h5.qty });
  });
});
