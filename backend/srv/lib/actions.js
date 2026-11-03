'use strict';
/*
 * Self-describing actions for the experience layer. Every button a UI shows comes from here as data:
 *   { id, label, style, method, path, body, fields[], confirm }
 * and POST /me/actions/{id} runs it: role check -> input validation -> the existing CAP service action,
 * called with the user's own identity, so every existing authorisation and business rule still applies.
 * body   = values the backend already knows; send them back unchanged.
 * fields = only what the user genuinely has to decide or scan, prefilled where the backend knows the answer.
 */
const cds = require('@sap/cds');
const { t } = require('./messages');

const PHARM = ['pharmacist', 'admin'];
const err = (status, code, params) => Object.assign(new Error(code), { status, code, params });

// ---------- descriptor helpers ----------
function action(id, { style = 'primary', body = {}, fields = [], params = {}, confirm = false } = {}) {
  const a = { id, label: t(`action.${id}`, params), style, method: 'POST', path: `/me/actions/${id}`, body, fields };
  if (confirm) a.confirm = t(`confirm.${id}`, params);
  return a;
}
function field(name, type, extra = {}) {
  const { label = name, hint, ...rest } = extra;
  const f = { name, label: t(`field.${label}`), type, required: true, ...rest };
  if (hint) f.hint = hint;
  return f;
}
const optional = f => ({ ...f, required: false });
const canAct = (viewer, roles) => roles.includes(viewer.role);

// ---------- actions shown on journeys ----------
function forShortfall(j, viewer) {
  if (!canAct(viewer, ['pharmacist'])) return [];
  const p = { qty: j.qty, drug: j.drug.name, date: require('./journey').fmtDate(j.neededBy) };
  return [action('send-request', {
    body: { drugId: j.drug.id, qty: j.qty, neededBy: j.neededBy }, params: p, confirm: true,
    fields: [field('allowBrandSwitch', 'boolean', { default: false }), optional(field('note', 'text'))],
  })];
}

function forJourney(j, { r, lead, legs, viewer, ctx }) {
  const out = [];
  const { fmtDate } = require('./journey');
  const shortName = h => String(h?.name || '').split(',')[0];
  const role = viewer.role;
  const tid = lead?.ID;
  const p = { qty: j.qty, drug: j.drug.name, other: j.counterpart, date: fmtDate(r.neededBy) };
  const batches = (ctx.lots[tid] || []).map(l => l.batchNo).join(', ');
  const live = !['CANCELLED', 'FULFILLED'].includes(r.status);

  if (j.perspective === 'receiver' && role === 'pharmacist' && live) {
    if (j.key === 'choose_supplier') {
      const plans = (ctx.plans[r.ID] || []).sort((a, b) => a.rank - b.rank);
      const options = plans.map(pl => {
        const leg = JSON.parse(pl.legs || '[]')[0] || {};
        return { value: pl.rank, label: t('plan.option', { other: shortName(ctx.hospitals[leg.hospitalId]) || leg.hospitalName, distance: leg.distanceKm, minutes: leg.etaMin, qty: pl.totalQty }), reason: pl.reason };
      });
      const fields = options.length > 1 ? [field('plan', 'choice', { default: 1, options })] : [];
      out.push(action('choose-plan', { body: { requestId: r.ID, plan: 1 }, params: { ...p, qty: plans[0]?.totalQty ?? j.qty }, confirm: true, fields }));
      if (plans.length && require('./config').agentsEnabled) out.push(action('review-plans', { style: 'secondary', body: { requestId: r.ID } })); // planner + compliance + critic agents
    }
    if (['no_match', 'recalled'].includes(j.key)) out.push(action('find-supplier-again', { body: { requestId: r.ID } }));
    if (j.stage <= 4 && !['cancelled'].includes(j.key)) out.push(action('cancel-request', { style: 'secondary', body: { requestId: r.ID }, confirm: true }));
    if (lead?.status === 'IN_TRANSIT') {
      const scan = [field('batchNo', 'barcode', { hint: t('field.batchNo.hint', { batches }) }), field('sealIntact', 'boolean', { default: true }), field('qtyReceived', 'number', { default: lead.qty, min: 0, max: lead.qty })];
      const accept = action('accept-delivery', { body: { transferId: tid }, params: p, confirm: true, fields: scan });
      const quarantine = action('quarantine-delivery', { style: lead.excursion ? 'primary' : 'secondary', body: { transferId: tid }, fields: scan });
      out.push(...(lead.excursion ? [quarantine] : [accept, quarantine]));
    }
  }
  if (j.perspective === 'supplier' && lead) {
    if (lead.status === 'PENDING_SUPPLIER' && role === 'pharmacist') {
      const items = (ctx.lots[tid] || []).map(l => ({ lot: ctx.stockLots?.[l.lot_ID], qty: l.qty }));
      const amount = Math.round(require('./pricing').loanValue(ctx.drugs[lead.drug_ID], ctx.hospitals[lead.supplier_ID], items, new Date().toISOString().slice(0, 10)).medicine); // supplier's price tier
      out.push(action('accept-request', {
        body: { transferId: tid }, params: p, confirm: true,
        fields: [
          field('quantity', 'number', { default: lead.qty, min: 1, max: lead.qty }),
          field('repaymentMode', 'choice', { default: 'IN_KIND', options: [{ value: 'IN_KIND', label: t('field.repay.IN_KIND') }, { value: 'LANDED_COST', label: t('field.repay.LANDED_COST', { amount: amount.toLocaleString('en-IN') }) }] }),
        ],
      }));
      out.push(action('decline-request', {
        style: 'secondary', body: { transferId: tid },
        fields: [field('reasonCode', 'choice', { options: ['OWN_PATIENTS', 'RESERVED', 'QUALITY', 'OTHER'].map(v => ({ value: v, label: t(`field.reason.${v}`) })) }), optional(field('note', 'text', { label: 'declineNote' }))],
      }));
    }
    if (['PENDING_APPROVAL', 'PENDING_SECOND_APPROVAL'].includes(lead.status) && role === 'approver') {
      const signed = (ctx.approvals[tid] || []).some(a => a.approver === viewer.userId && a.decision === 'APPROVE');
      if (!signed) {
        out.push(action('approve-transfer', { body: { transferId: tid }, params: p, confirm: true }));
        out.push(action('reject-transfer', { style: 'secondary', body: { transferId: tid }, fields: [field('reason', 'text', { label: 'rejectReason' })] }));
      }
    }
  }
  // the courier has no account: the sending hospital (or admin) shares its per-delivery link, or replaces it
  if (['ASSIGNED', 'IN_TRANSIT'].includes(lead?.status) && (j.perspective === 'admin' || (j.perspective === 'supplier' && ['pharmacist', 'approver'].includes(role)))) {
    out.push(action('courier-link', { style: 'secondary', body: { transferId: tid } }));
    out.push(action('reissue-courier-link', { style: 'secondary', body: { transferId: tid }, confirm: true }));
  }
  // road closures can be reported by either hospital's pharmacist (the courier reports through its link)
  if (['ASSIGNED', 'IN_TRANSIT'].includes(lead?.status) && role === 'pharmacist' && j.perspective !== 'admin') {
    out.push(action('report-road-closed', { style: 'secondary', body: { transferId: tid }, confirm: true, fields: [optional(field('note', 'text', { label: 'roadNote' }))] }));
  }
  // loans: either pharmacist may settle (PRD section 10, "Settle loan")
  if (j.loan?.status === 'OPEN' && lead?.status === 'DELIVERED' && role === 'pharmacist' && ['receiver', 'supplier'].includes(j.perspective)) {
    out.push(action('mark-loan-paid', { style: j.perspective === 'receiver' ? 'primary' : 'secondary', body: { loanId: j.loan.id }, fields: [field('reference', 'text')] }));
    const returns = ctx.returns?.[j.loan.id] || [];
    if (returns.length) out.push(action('repay-in-kind', { style: 'secondary', body: { loanId: j.loan.id }, fields: [field('settlementTransfer', 'choice', { options: returns })] }));
  }
  return out;
}

// ---------- dispatcher ----------
const call = async (service, event, data) => (await cds.connect.to(service)).send(event, data);
const ownLicence = async viewer => (await SELECT.one.from('medilink.Hospitals').columns('licenceNo').where({ ID: viewer.hospitalId }))?.licenceNo;

async function licenceErrorParams(licenceNo) {
  const { fmtDateLong } = require('./journey');
  const lic = await SELECT.one.from('medilink.Licences').where({ licenceNo: String(licenceNo || '').trim().toUpperCase(), partyType: 'HOSPITAL' });
  return { licenceNo: String(licenceNo || '').trim().toUpperCase(), validTill: fmtDateLong(lic?.validTill) };
}
async function onboardingCall(viewer, data) {
  try { return await call('OnboardingService', 'licence', data); } catch (e) { e.params = await licenceErrorParams(data.licenceNo); throw e; }
}
function onboardingNext(res) {
  if (res.next === 'OAUTH_ALLOW') return { type: 'open', url: res.authorizeUrl, label: t('action.allow-access') };
  if (res.next === 'WAIT_FOR_IT') return { type: 'show', pairingCode: res.pairingCode, setupLink: res.itSetupLink };
  return null;
}
async function journeyIdOfTransfer(id) { return (await SELECT.one.from('medilink.Transfers').columns('request_ID').where({ ID: id }))?.request_ID || id; }

// Input spec types: id | string | text | number | boolean | date | enum:<A|B>; a trailing ! means required.
const REGISTRY = {
  'enter-licence': {
    roles: PHARM, input: { licenceNo: 'string!' },
    async run({ licenceNo }, viewer) {
      const res = await onboardingCall(viewer, { licenceNo });
      return { message: res.message, next: onboardingNext(res), onboarding: true };
    },
  },
  'allow-access': {
    roles: ['pharmacist'],
    async run(_, viewer) {
      const res = await onboardingCall(viewer, { licenceNo: await ownLicence(viewer) });
      return { message: res.message, next: onboardingNext(res), onboarding: true };
    },
  },
  'pick-software': {
    roles: ['pharmacist'], input: { software: 'enum:MEDISOFT|SAP_SANDBOX|CONNECTOR|SHEET|IT!', itContact: 'string' },
    async run({ software, itContact }, viewer) {
      const res = await onboardingCall(viewer, { licenceNo: await ownLicence(viewer), software: software === 'IT' ? 'CONNECTOR' : software, itContact });
      return { message: res.message, next: onboardingNext(res), onboarding: true };
    },
  },
  'ask-it-team': {
    roles: ['pharmacist'], input: { itContact: 'string!' },
    async run({ itContact }, viewer) {
      const res = await onboardingCall(viewer, { licenceNo: await ownLicence(viewer), software: 'CONNECTOR', itContact });
      return { message: res.message, next: onboardingNext(res), onboarding: true };
    },
  },
  'upload-sheet': {
    roles: ['pharmacist'], input: { csv: 'text!', mapping: 'text', confirm: 'boolean' },
    async run({ csv, mapping, confirm }) {
      const preview = await call('SyncService', 'uploadSheet', { csv, mapping, confirm: false });
      if (preview.mappingSource === 'synonyms' || confirm) {
        const done = await call('SyncService', 'uploadSheet', { csv, mapping: mapping || preview.mapping, confirm: true });
        return { message: `Saved ${done.ingested.lots} stock rows from your sheet.`, result: { rows: done.rows, saved: done.ingested.lots, skipped: done.ingested.skipped }, onboarding: true };
      }
      return { message: 'Please check how we read your columns, then save.', result: { mapping: JSON.parse(preview.mapping), preview: JSON.parse(preview.preview) },
        next: { type: 'action', action: action('upload-sheet', { body: { csv, mapping: preview.mapping, confirm: true } }) } };
    },
  },
  'upload-photo': {
    roles: ['pharmacist'], input: { imageBase64: 'text!', mimeType: 'string' },
    async run({ imageBase64, mimeType }) {
      const r = await call('SyncService', 'uploadPhoto', { imageBase64, mimeType });
      return { message: `We read ${r.rows} rows from your photo. Check them, then save.`, result: { previewId: r.previewId, rows: JSON.parse(r.preview), dropped: JSON.parse(r.dropped) },
        next: { type: 'action', action: action('confirm-photo', { body: { previewId: r.previewId } }) } };
    },
  },
  'confirm-photo': {
    roles: ['pharmacist'], input: { previewId: 'id!' },
    async run({ previewId }) {
      const r = await call('SyncService', 'uploadPhoto', { previewId, confirm: true });
      return { message: `Saved ${r.ingested.lots} stock rows from your photo.`, result: { saved: r.ingested.lots, skipped: r.ingested.skipped }, onboarding: true };
    },
  },
  'disconnect': {
    roles: ['pharmacist'],
    async run() { const r = await call('OnboardingService', 'revokeAccess', {}); return { message: r.message, onboarding: true }; },
  },
  'send-request': {
    roles: ['pharmacist'], input: { drugId: 'string!', qty: 'number', neededBy: 'date', allowBrandSwitch: 'boolean', note: 'text' },
    async run({ drugId, qty, neededBy, allowBrandSwitch, note }, viewer) {
      // natural idempotency: one live request per medicine and hospital
      const live = await SELECT.one.from('medilink.Requests').columns('ID').where({ hospital_ID: viewer.hospitalId, drug_ID: drugId, status: { in: ['OPEN', 'MATCHED', 'IN_PROGRESS'] } });
      if (live) return { message: t('error.NOTHING_TO_REQUEST.message'), journeyId: live.ID };
      const drug = await SELECT.one.from('medilink.Drugs').where({ ID: drugId });
      const r = await call('RequestService', 'createRequest', { drug: drugId, qty, neededBy, allowBrandSwitch: !!allowBrandSwitch, note }).catch(e => { e.params = { drug: drug ? `${drug.genericName} ${String(drug.strength).split('/')[0]}` : '' }; throw e; });
      const n = r.ranking?.plans?.length || 0;
      return { message: n ? `Request sent. We found ${n} safe supplier option${n === 1 ? '' : 's'}.` : 'Request sent, but no safe supplier can help right now.', journeyId: r.request };
    },
  },
  'choose-plan': {
    roles: ['pharmacist'], input: { requestId: 'id!', plan: 'number' },
    async run({ requestId, plan }) {
      const ts = await call('RequestService', 'choosePlan', { request: requestId, rank: plan || 1 });
      const names = (await SELECT.from('medilink.Hospitals').columns('name').where({ ID: { in: ts.map(x => x.supplierId) } })).map(h => h.name.split(',')[0]);
      return { message: `Asked ${names.join(' and ')}. They have ${require('./config').supplierResponseTimeoutMin} minutes to answer.`, journeyId: requestId };
    },
  },
  'choose-suppliers': { // from the price vs distance chart: hospitals = "H5" or "H5,H2" (first gives what it can, the next the rest)
    roles: ['pharmacist'], input: { requestId: 'id!', hospitals: 'string!' },
    async run({ requestId, hospitals }) {
      const ids = hospitals.split(',').map(x => x.trim()).filter(Boolean);
      if (!ids.length || ids.length > 3 || ids.some(x => !/^[A-Za-z0-9_-]{1,10}$/.test(x))) throw err(400, 'INVALID_INPUT', { detail: 'Choose one to three hospitals from the chart.', field: 'hospitals' });
      const r = await call('RequestService', 'chooseSuppliers', { request: requestId, hospitals: ids }).catch(e => {
        if (/^(SUPPLIER_NOT_ELIGIBLE|SUPPLIER_NOT_NEEDED)$/.test(e.code)) e.params = { detail: String(e.message).replace(/^[A-Z_]+:\s*/, '') };
        throw e;
      });
      const short = r.totalQty < r.requested ? ` Together they give ${r.totalQty} of ${r.requested} vials.` : '';
      return { message: `Asked ${r.names.join(' and ')}.${short} They have ${require('./config').supplierResponseTimeoutMin} minutes to answer.`, journeyId: requestId };
    },
  },
  'find-supplier-again': {
    roles: ['pharmacist'], input: { requestId: 'id!' },
    async run({ requestId }) {
      const r = await call('RequestService', 'rank', { request: requestId, excludeRefused: true });
      return { message: r.plans.length ? 'Found a safe supplier. Tap to ask them.' : 'Still no safe supplier. Try again later.', journeyId: requestId };
    },
  },
  'cancel-request': {
    roles: ['pharmacist'], input: { requestId: 'id!' },
    async run({ requestId }) { await call('RequestService', 'cancelRequest', { request: requestId }); return { message: 'Request cancelled.', journeyId: requestId }; },
  },
  'accept-request': {
    roles: ['pharmacist'], input: { transferId: 'id!', quantity: 'number', repaymentMode: 'enum:IN_KIND|LANDED_COST!' },
    async run({ transferId, quantity, repaymentMode }) {
      const tr = await SELECT.one.from('medilink.Transfers').columns('qty').where({ ID: transferId });
      const out = await call('SupplierService', 'accept', { transfer: transferId, qty: quantity, repaymentMode }).catch(e => { e.params = { max: tr?.qty }; throw e; });
      return { message: `Thank you. ${out.qty} vials promised; waiting for your approver's sign-off.`, journeyId: await journeyIdOfTransfer(transferId) };
    },
  },
  'decline-request': {
    roles: ['pharmacist'], input: { transferId: 'id!', reasonCode: 'enum:OWN_PATIENTS|RESERVED|QUALITY|OTHER!', note: 'text' },
    async run({ transferId, reasonCode, note }) {
      await call('SupplierService', 'decline', { transfer: transferId, reasonCode, reason: note || t(`field.reason.${reasonCode}`) });
      return { message: 'Declined. MediLink will ask the next nearest hospital.', journeyId: await journeyIdOfTransfer(transferId) };
    },
  },
  'approve-transfer': {
    roles: ['approver', 'admin'], input: { transferId: 'id!' },
    async run({ transferId }) {
      const out = await call('ApprovalService', 'approveTransfer', { transfer: transferId });
      const msg = out.status === 'PENDING_SECOND_APPROVAL' ? 'First sign-off done. A second approver must also sign.' : out.status === 'ASSIGNED' ? 'Approved. A licensed courier has been assigned.' : 'Approved.';
      return { message: msg, journeyId: await journeyIdOfTransfer(transferId) };
    },
  },
  'reject-transfer': {
    roles: ['approver', 'admin'], input: { transferId: 'id!', reason: 'text!' },
    async run({ transferId, reason }) {
      await call('ApprovalService', 'rejectTransfer', { transfer: transferId, reason });
      return { message: 'Rejected. MediLink will ask the next nearest hospital.', journeyId: await journeyIdOfTransfer(transferId) };
    },
  },
  // secret: the response carries a capability link, so it is never stored as an idempotent replay
  'courier-link': {
    roles: ['pharmacist', 'approver', 'admin'], input: { transferId: 'id!' }, secret: true,
    async run({ transferId }, viewer) {
      const link = await require('./courier').show(transferId, viewer);
      return { message: t('courier.link.shown'), result: link, journeyId: await journeyIdOfTransfer(transferId) };
    },
  },
  'reissue-courier-link': {
    roles: ['pharmacist', 'approver', 'admin'], input: { transferId: 'id!' }, secret: true,
    async run({ transferId }, viewer) {
      const link = await require('./courier').reissue(transferId, viewer);
      return { message: t('courier.link.reissued'), result: link, journeyId: await journeyIdOfTransfer(transferId) };
    },
  },
  'report-road-closed': {
    roles: ['pharmacist', 'admin'], input: { transferId: 'id!', note: 'text' },
    async run({ transferId, note }) {
      const r = await call('RouteService', 'setRouteClosed', { transfer: transferId, closed: true, note: note || 'Road closed' });
      const { fmtClock } = require('./journey');
      const { eta } = await SELECT.one.from('medilink.Transfers').columns('eta').where({ ID: transferId }); // same time the journey shows
      return { message: r.open ? `Re-routed. New arrival time about ${fmtClock(eta || Date.now() + r.etaMin * 60000)}.` : 'No open road right now. The courier will wait at a safe place.', journeyId: await journeyIdOfTransfer(transferId) };
    },
  },
  'accept-delivery': {
    roles: PHARM, input: { transferId: 'id!', batchNo: 'string!', sealIntact: 'boolean!', qtyReceived: 'number' },
    async run(d) {
      const r = await call('ReceiptService', 'arrivalScan', { transfer: d.transferId, batchNo: d.batchNo, sealIntact: d.sealIntact, qtyReceived: d.qtyReceived, decision: 'ACCEPT' });
      return { message: `Accepted into stock. Checks passed. ${r.message}.`, journeyId: await journeyIdOfTransfer(d.transferId) };
    },
  },
  'quarantine-delivery': {
    roles: PHARM, input: { transferId: 'id!', batchNo: 'string!', sealIntact: 'boolean!', qtyReceived: 'number' },
    async run(d) {
      await call('ReceiptService', 'arrivalScan', { transfer: d.transferId, batchNo: d.batchNo, sealIntact: d.sealIntact, qtyReceived: d.qtyReceived, decision: 'QUARANTINE' });
      return { message: 'Set aside (quarantined). Do not use it until it has been checked.', journeyId: await journeyIdOfTransfer(d.transferId) };
    },
  },
  'mark-loan-paid': {
    roles: PHARM, input: { loanId: 'id!', reference: 'string!' },
    async run({ loanId, reference }) {
      await call('LedgerService', 'settleLoan', { loan: loanId, mode: 'LANDED_COST', reference });
      const l = await SELECT.one.from('medilink.Ledger').columns('transfer_ID').where({ ID: loanId });
      return { message: 'Loan marked as paid.', journeyId: l && await journeyIdOfTransfer(l.transfer_ID) };
    },
  },
  'repay-in-kind': {
    roles: PHARM, input: { loanId: 'id!', settlementTransfer: 'id!' },
    async run({ loanId, settlementTransfer }) {
      await call('LedgerService', 'settleLoan', { loan: loanId, mode: 'IN_KIND', settlementTransfer });
      const l = await SELECT.one.from('medilink.Ledger').columns('transfer_ID').where({ ID: loanId });
      return { message: 'Loan repaid with the return delivery.', journeyId: l && await journeyIdOfTransfer(l.transfer_ID) };
    },
  },
  // stock and expiry monitoring (lib/monitor.js); hospital checks happen there
  'ack-alert': {
    roles: ['pharmacist', 'approver', 'admin'], input: { notificationId: 'id!' },
    run: ({ notificationId }, viewer) => require('./monitor').ack(viewer, notificationId),
  },
  'set-reorder-level': {
    roles: ['pharmacist', 'approver', 'admin'], input: { drugId: 'string!', minUnits: 'number!', hospital: 'string' },
    run: (input, viewer) => require('./monitor').setReorderLevel(viewer, input),
  },
  'set-alert-email': {
    roles: ['pharmacist', 'approver', 'admin'], input: { email: 'string' },
    async run({ email }, viewer) {
      const u = await require('./accounts').setEmail(viewer.userId, email);
      await require('./audit').log(viewer.userId, 'ALERT_EMAIL_SET', { user: viewer.userId, email: u.email ? 'set' : 'cleared' });
      return { message: u.email ? t('home.email.set', { email: u.email }) : t('home.email.cleared'), result: { email: u.email || null } };
    },
  },

  // ---------- agentic AI (srv/lib/agents): agents propose, rules verify, humans approve ----------
  'ask-copilot': {
    roles: ['pharmacist', 'approver'], input: { question: 'text!' },
    async run({ question }, viewer) {
      if (question.length > 500) throw err(400, 'INVALID_INPUT', { detail: 'Please keep the question under 500 characters.', field: 'question' });
      const r = await require('./agents/copilot').ask(viewer, question, viewer.userId);
      return { message: r.answer, result: r };
    },
  },
  'review-plans': {
    roles: ['pharmacist'], input: { requestId: 'id!' },
    async run({ requestId }, viewer) {
      const r = await require('./agents/planner').review(requestId, viewer, viewer.userId);
      const best = r.plans.find(p => p.rank === r.recommended);
      const choose = best ? action('choose-plan', { body: { requestId, plan: best.rank }, params: { other: best.legs.map(l => l.hospital).join(' and '), qty: best.totalQty }, confirm: true }) : action('find-supplier-again', { body: { requestId } });
      return { message: r.explanation, result: r, journeyId: requestId, next: { type: 'review', review: r, action: choose } };
    },
  },
  'intake-text': {
    roles: ['pharmacist'], input: { stockText: 'text!' },
    async run({ stockText }, viewer) {
      if (stockText.length > 20000) throw err(400, 'INVALID_INPUT', { detail: 'Please paste at most one page (about 200 lines) at a time.', field: 'stockText' });
      const r = await require('./agents/intake').preview(viewer.hospitalId, stockText, viewer.userId);
      const fix = r.rejected.length ? ` ${r.rejected.length} line${r.rejected.length === 1 ? '' : 's'} could not be used.` : '';
      if (!r.rows.length) return { message: `We could not read any stock line.${fix}${r.question ? ' ' + r.question : ''}`, result: r };
      return { message: `We read ${r.rows.length} rows. Check them, then save.${fix}${r.question ? ' ' + r.question : ''}`, result: r,
        next: { type: 'action', action: action('confirm-photo', { body: { previewId: r.previewId } }) } };
    },
  },
  'approve-proposal': {
    roles: ['pharmacist', 'approver', 'admin'], input: { proposalId: 'id!', note: 'text' },
    async run({ proposalId, note }, viewer) {
      const r = await require('./agents/proposals').approve(proposalId, viewer, note && note.slice(0, 300));
      const j = r.proposal.ref && await journeyIdOfTransfer(r.proposal.ref).catch(() => null);
      return { message: r.message, ...(j ? { journeyId: j } : {}) };
    },
  },
  'reject-proposal': {
    roles: ['pharmacist', 'approver', 'admin'], input: { proposalId: 'id!', note: 'text' },
    async run({ proposalId, note }, viewer) {
      return require('./agents/proposals').reject(proposalId, viewer, note && note.slice(0, 300));
    },
  },
  'agent-recheck-route': {
    roles: ['pharmacist', 'admin'], input: { transferId: 'id!' },
    async run({ transferId }, viewer) {
      const tr = await SELECT.one.from('medilink.Transfers').where({ ID: transferId });
      if (!tr || (viewer.role !== 'admin' && ![tr.supplier_ID, tr.receiver_ID].includes(viewer.hospitalId))) throw err(404, 'TRANSFER_NOT_FOUND');
      if (!['ASSIGNED', 'IN_TRANSIT'].includes(tr.status)) throw err(409, 'INVALID_STATUS');
      const r = await require('./delivery').replan(transferId, viewer.userId);
      const { fmtClock } = require('./journey');
      return { message: r.open ? `A road is open again. New arrival time about ${fmtClock(Date.now() + r.etaMin * 60000)}.` : 'Still no open road. The courier keeps waiting at a safe place.', journeyId: await journeyIdOfTransfer(transferId) };
    },
  },
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Validate and coerce the request body against the action's input spec. Unknown keys are dropped. */
function validate(spec = {}, body = {}) {
  const out = {};
  for (const [name, raw] of Object.entries(spec)) {
    const required = raw.endsWith('!');
    const type = raw.replace(/!$/, '');
    let v = body[name];
    if (v === undefined || v === null || v === '') {
      if (required) throw err(400, 'INVALID_INPUT', { detail: `Please fill in "${t(`field.${name}`) || name}".`, field: name });
      continue;
    }
    const bad = () => err(400, 'INVALID_INPUT', { detail: `"${t(`field.${name}`) || name}" does not look right.`, field: name });
    if (type === 'number') { v = Number(v); if (!Number.isFinite(v)) throw bad(); }
    else if (type === 'boolean') { if (typeof v === 'string') v = /^(true|yes|1)$/i.test(v); else if (typeof v !== 'boolean') throw bad(); }
    else if (type === 'date') { if (!/^\d{4}-\d{2}-\d{2}$/.test(String(v))) throw bad(); v = String(v); }
    else if (type === 'id') { if (!UUID.test(String(v))) throw bad(); v = String(v); }
    else if (type.startsWith('enum:')) { if (!type.slice(5).split('|').includes(String(v))) throw bad(); v = String(v); }
    else { v = String(v); if (type === 'string' && v.length > 200) throw bad(); v = type === 'string' ? v.trim() : v; }
    out[name] = v;
  }
  return out;
}

module.exports = { REGISTRY, validate, forJourney, forShortfall, action, field, err };
