'use strict';
/*
 * Supplier + approval flow (FR-18..20) and lending ledger (FR-26):
 * decline -> next-ranked supplier, 30-minute silence -> TIMED_OUT + fallback, BPA-compatible API,
 * approver reject cancels the loan, ledger settlement in kind / at landed cost.
 * Runs without the Python matcher (CAP's greedy fallback ranks) and without SAP credentials.
 */
require('./helpers/env')({ MATCHER_URL: 'http://localhost:1', MATCHER_FALLBACK_ENABLED: 'true', MEDISOFT_BASE_URL: 'http://localhost:1' });
const cds = require('@sap/cds');
const T = cds.test(__dirname + '/..');
T.axios.defaults.validateStatus = () => true;

const as = user => ({ auth: { username: user, password: 'demo' } });
const get = (url, user) => T.axios.get(url, as(user));
const post = (url, body, user) => T.axios.post(url, body, as(user));
const transfersOf = async req => (await get(`/odata/v4/admin/Transfers?$filter=request_ID eq ${req}&$orderby=createdAt`, 'admin')).data.value;
const actions = async () => (await get('/audit/Entries?$orderby=seq', 'admin')).data.map(e => e.action);
const s = {};
const inDays = n => new Date(Date.now() + n * 86400000).toISOString().slice(0, 10);

describe('supplier decline, timeout fallback and BPA-compatible API', () => {
  test('request ranks several suppliers (greedy fallback when the matcher is down)', async () => {
    const r = await post('/odata/v4/requests/createRequest', { drug: 'D-CARB450', qty: 16, neededBy: inDays(5), allowBrandSwitch: true }, 'asha');
    expect(r.status).toBe(200);
    expect(r.data.ranking.engine).toBe('fallback-greedy');
    expect(r.data.ranking.plans.length).toBeGreaterThanOrEqual(2);
    s.request = r.data.request;
    s.suppliers = [...new Set(r.data.ranking.plans.flatMap(p => p.legs.map(l => l.hospitalId)))];
    const t = await post('/odata/v4/requests/choosePlan', { request: s.request, rank: 1 }, 'asha');
    s.first = t.data.value[0];
    expect(s.first.status).toBe('PENDING_SUPPLIER');
    expect(new Date(s.first.supplierResponseDueAt) - Date.now()).toBeGreaterThan(29 * 60000);
  });

  test('decline needs a reason, then routes the quantity to the next ranked supplier', async () => {
    const user = { H5: 'ravi', H2: 'sunil', H3: 'lata' }[s.first.supplierId];
    expect((await post('/odata/v4/supplier/decline', { transfer: s.first.ID }, user)).data.error.code).toBe('DECLINE_REASON_REQUIRED');
    const d = await post('/odata/v4/supplier/decline', { transfer: s.first.ID, reasonCode: 'OWN_NEED', reason: 'Extra cycle booked' }, user);
    expect(d.data.status).toBe('DECLINED');
    expect(d.data.message).toMatch(/Routed to next ranked supplier/);
    const ts = await transfersOf(s.request);
    s.second = ts.find(t => t.status === 'PENDING_SUPPLIER');
    expect(s.second.supplier_ID).not.toBe(s.first.supplierId);
    expect(await actions()).toEqual(expect.arrayContaining(['SUPPLIER_DECLINED', 'FALLBACK_ROUTED']));
  });

  test('30 minutes of silence times out and falls back again (CAP-native timer)', async () => {
    const workflow = require('../srv/lib/workflow');
    const out = await cds.tx(() => workflow.timeoutSweep(new Date(Date.now() + 31 * 60000)));
    expect(out.map(o => o.ID)).toContain(s.second.ID);
    const ts = await transfersOf(s.request);
    expect(ts.find(t => t.ID === s.second.ID).status).toBe('TIMED_OUT');
    expect(await actions()).toContain('SUPPLIER_TIMEOUT');
    s.third = ts.find(t => t.status === 'PENDING_SUPPLIER'); // may be undefined if no supplier is left
    if (!s.third) expect(await actions()).toContain('FALLBACK_EXHAUSTED');
  });

  test('BPA API: context, supplier ACCEPT at landed cost records the loan; approver REJECT cancels it', async () => {
    // fresh request so a supplier is guaranteed available
    const r = await post('/odata/v4/requests/createRequest', { drug: 'D-CISP50', qty: 2, neededBy: inDays(5), allowBrandSwitch: true }, 'asha');
    expect(r.data.ranking.plans.length).toBeGreaterThan(0);
    const [t] = (await post('/odata/v4/requests/choosePlan', { request: r.data.request, rank: 1 }, 'asha')).data.value;
    expect((await get(`/workflow/context(transfer=${t.ID})`, 'asha')).status).toBe(403); // technical user only
    const raw = (await get(`/workflow/context(transfer=${t.ID})`, 'bpa')).data;
    const ctx = typeof raw === 'string' ? JSON.parse(raw) : typeof raw?.value === 'string' ? JSON.parse(raw.value) : raw;
    expect(ctx).toMatchObject({ transferId: t.ID, timeoutMinutes: 30, ownBookingsStayCovered: true });
    expect((await post('/workflow/supplierDecision', { transfer: t.ID, decision: 'MAYBE' }, 'bpa')).status).toBe(400);
    const acc = await post('/workflow/supplierDecision', { transfer: t.ID, decision: 'ACCEPT', repaymentMode: 'LANDED_COST', actor: 'pharm.supplier' }, 'bpa');
    expect(acc.data.status).toBe('PENDING_APPROVAL');
    const loan = (await get(`/odata/v4/ledger/Loans?$filter=transfer_ID eq ${t.ID}`, 'admin')).data.value[0];
    expect(loan).toMatchObject({ status: 'OPEN', repaymentMode: 'LANDED_COST', qty: 2 });
    expect(Number(loan.landedCost)).toBe(840); // 2 x 420 INR unit cost
    expect((await post('/workflow/approvalDecision', { transfer: t.ID, decision: 'REJECT' }, 'bpa')).data.error.code).toBe('REJECT_REASON_REQUIRED');
    const rej = await post('/workflow/approvalDecision', { transfer: t.ID, decision: 'REJECT', reason: 'Pending licence audit', actor: 'chief.pharm' }, 'bpa');
    expect(rej.data.status).toBe('REJECTED');
    expect((await get(`/odata/v4/ledger/Loans(${loan.ID})`, 'admin')).data.status).toBe('CANCELLED');
    const audit = (await get('/audit/Entries?$orderby=seq', 'admin')).data;
    expect(audit.find(e => e.action === 'REJECTED' && e.payload.includes(t.ID)).actor).toBe('chief.pharm (via BPA)');
  });

  test('approver inbox only shows the approver\'s own hospital', async () => {
    const inbox = (await get('/odata/v4/approval/Inbox', 'meera')).data.value;
    expect(inbox.every(t => t.supplier_ID === 'H5')).toBe(true);
    expect((await get('/odata/v4/approval/Inbox', 'asha')).status).toBe(403); // pharmacist is not an approver
  });
});

describe('lending ledger settlement (FR-26)', () => {
  const seeded = 'e0000000-0000-4000-8000-000000000001'; // H2 lent 2 x trastuzumab to H3 (seed)
  test('only lender or borrower may settle; landed cost needs a payment reference', async () => {
    expect((await post('/odata/v4/ledger/settleLoan', { loan: seeded, mode: 'LANDED_COST', reference: 'X' }, 'asha')).data.error.code).toBe('NOT_A_PARTY');
    expect((await post('/odata/v4/ledger/settleLoan', { loan: seeded, mode: 'LANDED_COST' }, 'lata')).data.error.code).toBe('PAYMENT_REFERENCE_REQUIRED');
    expect((await post('/odata/v4/ledger/settleLoan', { loan: seeded, mode: 'BARTER', reference: 'X' }, 'lata')).data.error.code).toBe('INVALID_MODE');
  });
  test('in-kind settlement must link a DELIVERED repayment from borrower to lender', async () => {
    expect((await post('/odata/v4/ledger/settleLoan', { loan: seeded, mode: 'IN_KIND' }, 'lata')).data.error.code).toBe('SETTLEMENT_TRANSFER_REQUIRED');
    // the seeded loan's own outbound transfer is IN_TRANSIT and goes lender -> borrower: not a repayment
    const r = await post('/odata/v4/ledger/settleLoan', { loan: seeded, mode: 'IN_KIND', settlementTransfer: 'a0000000-0000-4000-8000-000000000001' }, 'lata');
    expect(r.data.error.code).toBe('REPAYMENT_NOT_DELIVERED');
  });
  test('landed-cost settlement closes the loan once and is audited', async () => {
    const ok = await post('/odata/v4/ledger/settleLoan', { loan: seeded, mode: 'LANDED_COST', reference: 'NEFT-2026-0042' }, 'lata');
    expect(ok.data).toMatchObject({ status: 'SETTLED', mode: 'LANDED_COST', amount: 56000 });
    const l = (await get(`/odata/v4/ledger/Loans(${seeded})`, 'sunil')).data;
    expect(l).toMatchObject({ status: 'SETTLED', settlementRef: 'PAID:NEFT-2026-0042' });
    expect((await post('/odata/v4/ledger/settleLoan', { loan: seeded, mode: 'LANDED_COST', reference: 'again' }, 'lata')).data.error.code).toBe('LOAN_NOT_OPEN');
    expect(await actions()).toContain('LEDGER_SETTLED');
    expect((await get('/audit/verify', 'admin')).data.ok).toBe(true);
  });
  test('pharmacists only see loans their hospital is party to', async () => {
    const mine = (await get('/odata/v4/ledger/Loans', 'hari')).data.value;
    expect(mine.every(l => l.lender_ID === 'H4' || l.borrower_ID === 'H4')).toBe(true);
  });
});
