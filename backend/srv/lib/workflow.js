'use strict';
/*
 * Supplier accept/decline, approver sign-off with second sign-off risk rules, 30-minute fallback
 * (FR-18..20, FR-26 loan on acceptance). One code path serves both:
 *   - CAP-native mode (APPROVAL_MODE=cap, default): CAP actions + an in-process timer sweep
 *   - SAP Build Process Automation mode (APPROVAL_MODE=bpa): BPA calls WorkflowService; BPA owns the timer
 */
const cds = require('@sap/cds');
const config = require('./config');
const http = require('./http');
const audit = require('./audit');
const coverdb = require('./coverdb');
const matching = require('./matching');
const delivery = require('./delivery');
const ws = require('./ws');
const { notify } = require('./notify');
const { daysBetween } = require('./cover');
const LOG = cds.log('workflow');

const T = 'medilink.Transfers';
const ACTIVE = ['PENDING_SUPPLIER', 'PENDING_APPROVAL', 'PENDING_SECOND_APPROVAL', 'APPROVED', 'ASSIGNED', 'IN_TRANSIT', 'DELIVERED', 'QUARANTINED'];
const FAILED = ['DECLINED', 'TIMED_OUT', 'REJECTED', 'CANCELLED'];

function wfError(status, code, message) { const e = new Error(`${code}: ${message}`); e.status = status; e.code = code; return e; }

function toOut(t, message) {
  return {
    ID: t.ID, status: t.status, supplierId: t.supplier_ID, receiverId: t.receiver_ID, drugId: t.drug_ID, qty: t.qty, planRank: t.planRank,
    requiresSecondSignoff: !!t.requiresSecondSignoff, riskReasons: t.riskReasons, partnerId: t.partner_ID, etaMin: t.etaMin, distanceKm: t.distanceKm,
    supplierResponseDueAt: t.supplierResponseDueAt, message,
  };
}
async function load(id) {
  const t = await SELECT.one.from(T).where({ ID: id });
  if (!t) throw wfError(404, 'TRANSFER_NOT_FOUND', `Transfer ${id} not found`);
  t.lots = await SELECT.from('medilink.TransferLots').where({ transfer_ID: id });
  return t;
}
const expectStatus = (t, ...s) => { if (!s.includes(t.status)) throw wfError(409, 'INVALID_STATUS', `Transfer is ${t.status}; expected ${s.join(' or ')}`); };

/** Second sign-off risk rules: cold chain, near expiry, long route. */
function riskReasons({ drug, lots, distanceKm, etaMin, today }) {
  const r = [];
  if (drug.storageClass !== 'AMBIENT') r.push('COLD_CHAIN');
  if (lots.some(l => daysBetween(today, l.expiryDate) <= config.nearExpiryDays)) r.push('NEAR_EXPIRY');
  if (Number(distanceKm) > config.longRouteKm || Number(etaMin) > config.longRouteMin) r.push('LONG_ROUTE');
  return r;
}

async function createTransfersForPlan(request, plan, actor, { tag = 'PLAN_CHOSEN' } = {}) {
  const legs = typeof plan.legs === 'string' ? JSON.parse(plan.legs) : plan.legs;
  const drug = await SELECT.one.from('medilink.Drugs').where({ ID: request.drug_ID });
  const today = new Date().toISOString().slice(0, 10);
  const due = new Date(Date.now() + config.supplierResponseTimeoutMin * 60000).toISOString();
  const out = [];
  for (const leg of legs) {
    const lotRows = await SELECT.from('medilink.Lots').where({ ID: { in: leg.lots.map(l => l.lotId) } });
    const risks = riskReasons({ drug, lots: lotRows, distanceKm: leg.distanceKm, etaMin: leg.etaMin, today });
    const t = {
      ID: cds.utils.uuid(), request_ID: request.ID, supplier_ID: leg.hospitalId, receiver_ID: request.hospital_ID, drug_ID: request.drug_ID,
      qty: leg.qty, status: 'PENDING_SUPPLIER', planRank: plan.rank, distanceKm: leg.distanceKm, etaMin: leg.etaMin, supplierResponseDueAt: due,
      requiresSecondSignoff: risks.length > 0, riskReasons: risks.join(',') || null,
    };
    await INSERT.into(T).entries(t);
    await INSERT.into('medilink.TransferLots').entries(leg.lots.map(l => ({ ID: cds.utils.uuid(), transfer_ID: t.ID, lot_ID: l.lotId, batchNo: lotRows.find(r => r.ID === l.lotId)?.batchNo, qty: l.qty })));
    await audit.log(actor, tag, { request: request.ID, transfer: t.ID, rank: plan.rank, supplier: leg.hospitalId, qty: leg.qty, lots: leg.lots.map(l => ({ lot: l.lotId, qty: l.qty })), risks });
    await notify({ hospital: leg.hospitalId, kind: 'SUPPLY_REQUEST', severity: 'MEDIUM', ref: t.ID, message: `Request for ${leg.qty} x ${drug.genericName} ${drug.strength}; please respond within ${config.supplierResponseTimeoutMin} minutes` });
    if (config.approvalMode === 'bpa') await startBpa(t).catch(e => LOG.warn('BPA start failed, CAP-native fallback stays active for this transfer:', e.message));
    out.push(t);
  }
  await UPDATE('medilink.Requests').set({ status: 'IN_PROGRESS' }).where({ ID: request.ID });
  return out;
}

async function choosePlan(requestId, rank, actor) {
  const request = await SELECT.one.from('medilink.Requests').where({ ID: requestId });
  if (!request) throw wfError(404, 'REQUEST_NOT_FOUND', requestId);
  const open = await SELECT.from(T).where({ request_ID: requestId, status: { in: ['PENDING_SUPPLIER', 'PENDING_APPROVAL', 'PENDING_SECOND_APPROVAL', 'APPROVED', 'ASSIGNED', 'IN_TRANSIT'] } });
  if (open.length) throw wfError(409, 'PLAN_ALREADY_CHOSEN', 'This request already has an active transfer');
  const plan = await SELECT.one.from('medilink.Plans').where({ request_ID: requestId, rank: rank || 1 });
  if (!plan) throw wfError(404, 'PLAN_NOT_FOUND', `No plan with rank ${rank} (rank the request first)`);
  const ts = await createTransfersForPlan(request, plan, actor);
  return ts.map(t => toOut(t, `Sent to ${t.supplier_ID}; waiting for the supplying pharmacist`));
}

/** Stock the supplier would have left for its own bookings after giving this transfer. */
async function supplierReview(id) {
  const t = await load(id);
  const others = await coverdb.reservations({ excludeTransfer: id, includePendingSupplier: false });
  const mine = { ...others };
  for (const l of t.lots) mine[l.lot_ID] = (mine[l.lot_ID] || 0) + Number(l.qty);
  const before = await coverdb.rowFor(t.supplier_ID, t.drug_ID, others);
  const after = await coverdb.rowFor(t.supplier_ID, t.drug_ID, mine);
  const lots = await SELECT.from('medilink.Lots').where({ ID: { in: t.lots.map(l => l.lot_ID) } });
  const drug = await SELECT.one.from('medilink.Drugs').where({ ID: t.drug_ID });
  const today = new Date().toISOString().slice(0, 10);
  return {
    transfer: toOut(t),
    lots: t.lots.map(l => { const x = lots.find(y => y.ID === l.lot_ID) || {}; const d = daysBetween(today, x.expiryDate); return { lotId: l.lot_ID, batchNo: l.batchNo, brandName: x.brandName, qty: l.qty, expiryDate: x.expiryDate, daysToExpiry: d, nearExpiry: d <= config.nearExpiryDays }; }),
    coverBefore: before.row, coverAfter: after.row,
    ownBookingsStayCovered: after.cover.shortfall === 0 && after.cover.usableStock - after.cover.booked >= after.cover.margin,
    landedCostPerUnit: drug.unitCost,
  };
}

async function supplierAccept(id, { qty, repaymentMode }, actor) {
  const t = await load(id);
  expectStatus(t, 'PENDING_SUPPLIER');
  if (!['IN_KIND', 'LANDED_COST'].includes(repaymentMode)) throw wfError(400, 'REPAYMENT_MODE_REQUIRED', 'repaymentMode must be IN_KIND or LANDED_COST');
  const offered = qty === undefined || qty === null ? t.qty : Number(qty);
  if (!(offered > 0) || offered > t.qty) throw wfError(400, 'INVALID_QUANTITY', `Quantity must be between 1 and ${t.qty}`);
  // lower the quantity: trim longest-expiry lots first, so near-expiry stock still moves
  if (offered < t.qty) {
    const lots = await SELECT.from('medilink.Lots').where({ ID: { in: t.lots.map(l => l.lot_ID) } });
    const exp = id2 => lots.find(l => l.ID === id2)?.expiryDate || '';
    let cut = t.qty - offered;
    for (const l of [...t.lots].sort((a, b) => String(exp(b.lot_ID)).localeCompare(String(exp(a.lot_ID))))) {
      if (cut <= 0) break;
      const take = Math.min(cut, l.qty); cut -= take;
      if (l.qty - take === 0) await DELETE.from('medilink.TransferLots').where({ ID: l.ID });
      else await UPDATE('medilink.TransferLots').set({ qty: l.qty - take }).where({ ID: l.ID });
    }
    await UPDATE(T).set({ qty: offered }).where({ ID: id });
  }
  // Re-validate rule 1 and the trust check at the moment of acceptance
  const review = await supplierReview(id);
  if (!review.ownBookingsStayCovered) throw wfError(409, 'NO_GENUINE_SURPLUS', 'Giving this quantity would leave your own booked patients uncovered; lower the quantity or decline');
  const ctx = await coverdb.loadContext([t.supplier_ID]);
  const flagged = ctx.lots.filter(l => t.lots.some(x => x.lot_ID === l.ID) && ctx.isFlagged(l));
  if (flagged.length) throw wfError(409, 'FLAGGED_BATCH', `Lot ${flagged[0].batchNo} is now flagged and can never move`);

  const status = 'PENDING_APPROVAL';
  await UPDATE(T).set({ status, repaymentMode }).where({ ID: id });
  const drug = await SELECT.one.from('medilink.Drugs').where({ ID: t.drug_ID });
  const loan = { ID: cds.utils.uuid(), lender_ID: t.supplier_ID, borrower_ID: t.receiver_ID, drug_ID: t.drug_ID, qty: offered, landedCost: Math.round(offered * Number(drug.unitCost || 0) * 100) / 100, repaymentMode, status: 'OPEN', transfer_ID: id };
  await INSERT.into('medilink.Ledger').entries(loan);
  await audit.log(actor, 'SUPPLIER_ACCEPTED', { transfer: id, qty: offered, repaymentMode });
  await audit.log(actor, 'LEDGER_LOAN_RECORDED', { loan: loan.ID, transfer: id, lender: loan.lender_ID, borrower: loan.borrower_ID, qty: offered, landedCost: loan.landedCost, repaymentMode });
  await notify({ hospital: t.receiver_ID, kind: 'SUPPLIER_ACCEPTED', message: `${t.supplier_ID} accepted ${offered} units; awaiting approver sign-off`, ref: id });
  ws.emit('status', { transferId: id, status, message: 'Supplier accepted' });
  if (offered < t.qty) await fallback(t.request_ID, actor); // route the remainder to the next ranked supplier
  return toOut({ ...(await load(id)) }, 'Accepted; awaiting approver sign-off');
}

async function supplierDecline(id, { reason, reasonCode }, actor, status = 'DECLINED') {
  const t = await load(id);
  expectStatus(t, 'PENDING_SUPPLIER');
  if (status === 'DECLINED' && !reason && !reasonCode) throw wfError(400, 'DECLINE_REASON_REQUIRED', 'A decline reason is required');
  await UPDATE(T).set({ status, declineReason: [reasonCode, reason].filter(Boolean).join(': ') || 'No response within ' + config.supplierResponseTimeoutMin + ' minutes' }).where({ ID: id });
  await audit.log(actor, status === 'DECLINED' ? 'SUPPLIER_DECLINED' : 'SUPPLIER_TIMEOUT', { transfer: id, supplier: t.supplier_ID, reasonCode, reason });
  ws.emit('status', { transferId: id, status, message: status === 'DECLINED' ? 'Supplier declined' : 'Supplier did not respond in time' });
  const next = await fallback(t.request_ID, actor);
  return toOut(await load(id), next ? `Routed to next ranked supplier ${next.map(n => n.supplier_ID).join(', ')}` : 'No other eligible supplier');
}

/**
 * FR-19: decline / silence routes the unmet quantity to the next ranked supplier automatically.
 * Re-ranks the remainder, excluding suppliers that declined, timed out, were rejected, or already hold an active transfer.
 */
async function fallback(requestId, actor = 'system:fallback') {
  const request = await SELECT.one.from('medilink.Requests').where({ ID: requestId });
  if (!request) return null;
  const ts = await SELECT.from(T).where({ request_ID: requestId });
  const covered = ts.filter(t => ACTIVE.includes(t.status)).reduce((s, t) => s + Number(t.qty), 0);
  const remaining = Number(request.qty) - covered;
  if (remaining <= 0) return null;
  const exclude = [...new Set(ts.map(t => t.supplier_ID))];
  const r = await matching.rankRequest(requestId, { excludeHospitals: exclude, qty: remaining, actor, resync: false });
  if (!r.plans.length) {
    if (!ts.some(t => ACTIVE.includes(t.status))) await UPDATE('medilink.Requests').set({ status: 'NO_MATCH' }).where({ ID: requestId });
    await notify({ hospital: request.hospital_ID, kind: 'FALLBACK', severity: 'HIGH', ref: requestId, message: `No further eligible supplier for the remaining ${remaining} units` });
    await audit.log(actor, 'FALLBACK_EXHAUSTED', { request: requestId, remaining });
    return null;
  }
  const plan = await SELECT.one.from('medilink.Plans').where({ request_ID: requestId, rank: 1 });
  const created = await createTransfersForPlan(request, plan, actor, { tag: 'FALLBACK_ROUTED' });
  await notify({ hospital: request.hospital_ID, kind: 'FALLBACK', severity: 'MEDIUM', ref: requestId, message: `Routed ${remaining} units to next ranked supplier ${created.map(c => c.supplier_ID).join(', ')}` });
  return created;
}

/** CAP-native 30-minute timer. Skips transfers that a BPA workflow instance owns. */
async function timeoutSweep(now = new Date()) {
  // compared in JS: an ISO "...Z" string against a TIMESTAMP column is not portable to HANA
  const due = (await SELECT.from(T).where({ status: 'PENDING_SUPPLIER' })).filter(t => t.supplierResponseDueAt && new Date(t.supplierResponseDueAt) < now);
  const out = [];
  for (const t of due) {
    if (t.workflowInstanceId && config.approvalMode === 'bpa') continue;
    out.push(await supplierDecline(t.ID, {}, 'system:timer', 'TIMED_OUT'));
  }
  return out;
}

async function approve(id, actor) {
  const t = await load(id);
  expectStatus(t, 'PENDING_APPROVAL', 'PENDING_SECOND_APPROVAL');
  const approvals = await SELECT.from('medilink.Approvals').where({ transfer_ID: id, decision: 'APPROVE' });
  const level = t.status === 'PENDING_APPROVAL' ? 1 : 2;
  if (level === 2 && approvals.some(a => a.approver === actor)) throw wfError(409, 'SECOND_SIGNOFF_SAME_USER', 'The second sign-off must come from a different approver');
  await INSERT.into('medilink.Approvals').entries({ ID: cds.utils.uuid(), transfer_ID: id, level, approver: actor, decision: 'APPROVE', decidedAt: new Date().toISOString() });
  const status = level === 1 && t.requiresSecondSignoff ? 'PENDING_SECOND_APPROVAL' : 'APPROVED';
  await UPDATE(T).set({ status }).where({ ID: id });
  await audit.log(actor, 'APPROVED', { transfer: id, level, risks: t.riskReasons, next: status });
  ws.emit('status', { transferId: id, status, message: level === 1 && status !== 'APPROVED' ? `Second sign-off required (${t.riskReasons})` : 'Approved' });
  if (status === 'APPROVED') {
    await require('./notes').writeTransferNote(id);
    const assigned = await delivery.assignPartner(id, actor);
    return toOut(await load(id), assigned ? `Approved; partner ${assigned.ID} assigned` : 'Approved; no eligible partner yet');
  }
  return toOut(await load(id), `First sign-off recorded; second sign-off required (${t.riskReasons})`);
}

async function reject(id, reason, actor) {
  const t = await load(id);
  expectStatus(t, 'PENDING_APPROVAL', 'PENDING_SECOND_APPROVAL');
  if (!reason) throw wfError(400, 'REJECT_REASON_REQUIRED', 'A reject reason is required');
  await INSERT.into('medilink.Approvals').entries({ ID: cds.utils.uuid(), transfer_ID: id, level: t.status === 'PENDING_APPROVAL' ? 1 : 2, approver: actor, decision: 'REJECT', reason, decidedAt: new Date().toISOString() });
  await UPDATE(T).set({ status: 'REJECTED' }).where({ ID: id });
  await UPDATE('medilink.Ledger').set({ status: 'CANCELLED' }).where({ transfer_ID: id, status: 'OPEN' });
  await audit.log(actor, 'REJECTED', { transfer: id, reason });
  ws.emit('status', { transferId: id, status: 'REJECTED', message: reason });
  await fallback(t.request_ID, actor);
  return toOut(await load(id), 'Rejected');
}

// ---------- SAP Build Process Automation ----------
async function bpaToken() {
  const res = await http.request(process.env.BPA_TOKEN_URL, {
    method: 'POST', headers: { Authorization: 'Basic ' + Buffer.from(`${process.env.BPA_CLIENT_ID}:${process.env.BPA_CLIENT_SECRET}`).toString('base64'), 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'grant_type=client_credentials',
  });
  if (res.status !== 200) throw new Error('BPA token failed: ' + res.status);
  return res.json.access_token;
}
async function bpaContext(id) {
  const t = await load(id);
  const review = await supplierReview(id);
  return { transferId: id, supplierId: t.supplier_ID, receiverId: t.receiver_ID, drugId: t.drug_ID, qty: t.qty, requiresSecondSignoff: !!t.requiresSecondSignoff, riskReasons: t.riskReasons, ownBookingsStayCovered: review.ownBookingsStayCovered, coverAfterPct: review.coverAfter.coverPct, timeoutMinutes: config.supplierResponseTimeoutMin, callbackBase: `${config.appBaseUrl}/workflow` };
}
async function startBpa(t) {
  if (!config.bpaApiUrl || !config.bpaDefinitionId) throw new Error('BPA_API_URL / BPA_DEFINITION_ID not configured');
  const token = await bpaToken();
  const res = await http.request(`${config.bpaApiUrl}/workflow/rest/v1/workflow-instances`, {
    method: 'POST', headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
    body: JSON.stringify({ definitionId: config.bpaDefinitionId, context: await bpaContext(t.ID) }),
  });
  if (res.status >= 300) throw new Error('BPA start returned ' + res.status);
  await UPDATE(T).set({ workflowInstanceId: res.json.id }).where({ ID: t.ID });
  t.workflowInstanceId = res.json.id;
}

module.exports = { choosePlan, supplierReview, supplierAccept, supplierDecline, fallback, timeoutSweep, approve, reject, bpaContext, riskReasons, toOut, load, wfError };
