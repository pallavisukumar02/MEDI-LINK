'use strict';
/*
 * One plain-language journey per medicine request (experience layer), seen from the viewer's side:
 * receiver (requesting hospital), supplier, partner (courier) or admin. Derived on every read from
 * Requests / Transfers / Approvals / ConditionLogs / RoadClosures / Ledger / Plans: nothing is stored separately.
 *   stages: 1 Shortfall found · 2 Request sent · 3 Waiting for supplier · 4 Waiting for approval
 *           5 On the way · 6 Arrived · 7 Done                     colour: green | amber | red | grey
 */
const cds = require('@sap/cds');
const config = require('./config');
const { t } = require('./messages');
const { haversineKm } = require('./routing');

const T = 'medilink.Transfers';
const ACTIVE = ['PENDING_SUPPLIER', 'PENDING_APPROVAL', 'PENDING_SECOND_APPROVAL', 'APPROVED', 'ASSIGNED', 'IN_TRANSIT', 'DELIVERED', 'QUARANTINED'];
const OPEN_LEG = ['PENDING_SUPPLIER', 'PENDING_APPROVAL', 'PENDING_SECOND_APPROVAL', 'APPROVED', 'ASSIGNED', 'IN_TRANSIT'];
const ARRIVED_KM = 0.5;   // last GPS fix this close to the receiver counts as "arrived"
const RECENT_DAYS = 7;    // finished journeys stay on the home screen this long (open loans keep them longer)
const COLOUR = {
  shortfall: 'red', finding: 'amber', choose_supplier: 'amber', no_match: 'red', recalled: 'red', cancelled: 'grey',
  waiting_supplier: 'amber', waiting_supplier_fallback: 'amber', waiting_approval: 'amber', waiting_second_approval: 'amber',
  finding_partner: 'amber', waiting_pickup: 'green', on_the_way: 'green', rerouted: 'amber', road_blocked: 'red', excursion: 'red',
  arrived: 'amber', done: 'green', quarantined: 'red', declined: 'grey', timed_out: 'grey', rejected: 'grey',
};

// ---------- formatting ----------
const shortName = h => String(h?.name || '').split(',')[0];
const drugName = d => (d ? `${d.genericName} ${String(d.strength || '').split('/')[0]}`.trim() : '');
const fmt = (opts, v) => new Intl.DateTimeFormat('en-IN', { timeZone: config.timeZone, ...opts }).format(new Date(v));
const fmtDate = v => (v ? fmt({ day: 'numeric', month: 'short' }, String(v).length === 10 ? v + 'T12:00:00Z' : v) : '');
const fmtDateLong = v => (v ? fmt({ day: 'numeric', month: 'short', year: 'numeric' }, String(v).length === 10 ? v + 'T12:00:00Z' : v) : '');
const fmtClock = v => fmt({ hour: 'numeric', minute: '2-digit', hour12: true }, v).replace(/\s?([AP]M)$/i, (_, m) => ' ' + m.toLowerCase());
function fmtTime(v) {
  if (!v) return '';
  const sameDay = fmt({ year: 'numeric', month: 'numeric', day: 'numeric' }, v) === fmt({ year: 'numeric', month: 'numeric', day: 'numeric' }, Date.now());
  return sameDay ? fmtClock(v) : `${fmtDate(v)}, ${fmtClock(v)}`;
}
const temp = c => (c === null || c === undefined ? '' : t('journey.temp', { value: Number(c).toFixed(1) }));
const by = k => (a, b) => String(a[k] || '').localeCompare(String(b[k] || ''));
const group = (rows, k) => rows.reduce((m, r) => ((m[r[k]] ||= []).push(r), m), {});

// ---------- viewer ----------
function viewerOf(user, locale) {
  const attr = k => { const v = user?.attr?.[k]; return Array.isArray(v) ? v[0] : v; };
  const is = r => !!user?.is?.(r);
  const role = is('admin') ? 'admin' : is('partner') ? 'partner' : is('approver') ? 'approver' : is('pharmacist') ? 'pharmacist' : 'other';
  return { userId: user?.id, role, hospitalId: attr('hospital') || null, partnerId: attr('partner') || null, locale };
}

// ---------- loading ----------
const inList = (k, ids) => ({ [k]: { in: [...ids] } });
async function load({ requestIds = [], transferIds = [] }) {
  const ts = [];
  if (requestIds.length) ts.push(...await SELECT.from(T).where(inList('request_ID', requestIds)));
  const missing = transferIds.filter(id => !ts.some(x => x.ID === id));
  if (missing.length) ts.push(...await SELECT.from(T).where(inList('ID', missing)));
  const reqIds = [...new Set([...requestIds, ...ts.map(x => x.request_ID).filter(Boolean)])];
  const tIds = ts.map(x => x.ID);
  const q = (entity, where) => (Object.values(where)[0].in.length ? SELECT.from(entity).where(where) : []);
  const inTransit = ts.filter(x => x.status === 'IN_TRANSIT').map(x => x.ID);
  const [requests, approvals, loans, closures, transferLots, plans, excursions, hospitals, drugs, partners] = await Promise.all([
    q('medilink.Requests', inList('ID', reqIds)), q('medilink.Approvals', inList('transfer_ID', tIds)), q('medilink.Ledger', inList('transfer_ID', tIds)),
    q('medilink.RoadClosures', inList('transfer_ID', tIds)), q('medilink.TransferLots', inList('transfer_ID', tIds)), q('medilink.Plans', inList('request_ID', reqIds)),
    tIds.length ? SELECT.from('medilink.ConditionLogs').where({ ...inList('transfer_ID', tIds), excursion: true }).orderBy('loggedAt') : [],
    SELECT.from('medilink.Hospitals').columns('ID', 'name', 'lat', 'long'), SELECT.from('medilink.Drugs'), SELECT.from('medilink.DeliveryPartners').columns('ID', 'name'),
  ]);
  // latest GPS / temperature fix per in-transit shipment
  const lastLog = {};
  for (const id of inTransit) lastLog[id] = await SELECT.one.from('medilink.ConditionLogs').where({ transfer_ID: id }).orderBy('loggedAt desc');
  return {
    requests, transfers: ts, byRequest: group(ts, 'request_ID'), approvals: group(approvals, 'transfer_ID'), loans: group(loans, 'transfer_ID'),
    closures: group(closures, 'transfer_ID'), lots: group(transferLots, 'transfer_ID'), plans: group(plans, 'request_ID'),
    firstExcursion: Object.fromEntries(Object.entries(group(excursions, 'transfer_ID')).map(([k, v]) => [k, v[0]])), lastLog,
    hospitals: Object.fromEntries(hospitals.map(h => [h.ID, h])), drugs: Object.fromEntries(drugs.map(d => [d.ID, d])),
    partners: Object.fromEntries(partners.map(p => [p.ID, p])), reviews: {}, covers: {},
  };
}

/** Extra per-journey facts that need the cover engine (supplier review, receiver coverage). */
async function enrich(ctx, list) {
  const workflow = require('./workflow');
  const coverdb = require('./coverdb');
  for (const { r, persp, lead } of list) {
    if (persp === 'supplier' && lead?.status === 'PENDING_SUPPLIER' && !ctx.reviews[lead.ID]) {
      ctx.reviews[lead.ID] = await workflow.supplierReview(lead.ID).catch(() => null);
    }
    if ((persp === 'receiver' || persp === 'admin') && ['DELIVERED', 'QUARANTINED'].includes(lead?.status) && !ctx.covers[r.ID]) {
      ctx.covers[r.ID] = (await coverdb.rowFor(r.hospital_ID, r.drug_ID).catch(() => null))?.row;
    }
    const loan = lead && (ctx.loans[lead.ID] || [])[0];
    if (loan?.status === 'OPEN' && lead.status === 'DELIVERED') {
      // deliveries that could settle the loan in kind: same drug, borrower -> lender, delivered
      const back = await SELECT.from(T).columns('ID', 'qty', 'qtyReceived', 'deliveredAt').where({ supplier_ID: loan.borrower_ID, receiver_ID: loan.lender_ID, drug_ID: loan.drug_ID, status: 'DELIVERED' });
      (ctx.returns ||= {})[loan.ID] = back.map(b => ({ value: b.ID, label: `${fmtDate(b.deliveredAt)} · ${b.qtyReceived ?? b.qty} vials` }));
    }
  }
}

// ---------- derivation ----------
function arrived(x, ctx) {
  const log = ctx.lastLog[x.ID], to = ctx.hospitals[x.receiver_ID];
  if (log && to && haversineKm({ lat: Number(log.lat), long: Number(log.long) }, { lat: Number(to.lat), long: Number(to.long) }) <= ARRIVED_KM) return true;
  return !!x.eta && new Date(x.eta) <= new Date();
}

function legStage(x, ctx) {
  switch (x.status) {
    case 'PENDING_SUPPLIER': return { stage: 3, key: 'waiting_supplier' };
    case 'PENDING_APPROVAL': return { stage: 4, key: 'waiting_approval' };
    case 'PENDING_SECOND_APPROVAL': return { stage: 4, key: 'waiting_second_approval' };
    case 'APPROVED': return { stage: 4, key: 'finding_partner' };
    case 'ASSIGNED': return { stage: 5, key: 'waiting_pickup' };
    case 'IN_TRANSIT': {
      const s = arrived(x, ctx) ? 6 : 5;
      if (x.excursion) return { stage: s, key: 'excursion' };
      const closure = (ctx.closures[x.ID] || []).filter(c => c.active !== false).sort(by('createdAt')).at(-1);
      if (closure && /^No open route/.test(x.routeNote || '')) return { stage: s, key: 'road_blocked', closure };
      if (closure && s === 5) return { stage: 5, key: 'rerouted', closure };
      return { stage: s, key: s === 6 ? 'arrived' : 'on_the_way' };
    }
    case 'DELIVERED': return { stage: 7, key: 'done' };
    case 'QUARANTINED': return { stage: 7, key: 'quarantined' };
    default: return { stage: 2, key: 'cancelled' };
  }
}
const recalled = x => x?.status === 'CANCELLED' && /^Lot flagged/.test(x.declineReason || '');

function perspective(r, legs, viewer) {
  if (viewer.role === 'admin') return 'admin';
  if (viewer.role === 'partner') return 'partner';
  if (r.hospital_ID === viewer.hospitalId) return 'receiver';
  if (legs.some(x => x.supplier_ID === viewer.hospitalId)) return 'supplier';
  return null;
}

/** Pick the transfer the journey is about, for this viewer. */
function leadOf(r, legs, persp, viewer, ctx) {
  if (persp === 'supplier') return legs.filter(x => x.supplier_ID === viewer.hospitalId).at(-1);
  if (persp === 'partner') return legs.filter(x => x.partner_ID === viewer.partnerId).at(-1);
  const active = legs.filter(x => ACTIVE.includes(x.status));
  // multi-leg plans: the journey moves at the pace of its slowest active leg
  if (active.length) return active.map(x => ({ x, s: legStage(x, ctx).stage })).sort((a, b) => a.s - b.s || by('createdAt')(b.x, a.x))[0].x;
  return legs.at(-1);
}

function previousText(legs, lead, ctx) {
  const prev = legs.filter(x => x !== lead && ['DECLINED', 'TIMED_OUT', 'REJECTED'].includes(x.status)).at(-1);
  if (!prev) return null;
  const k = { DECLINED: 'declined', TIMED_OUT: 'timed_out', REJECTED: 'rejected' }[prev.status];
  const reason = (ctx.approvals[prev.ID] || []).find(a => a.decision === 'REJECT')?.reason;
  return t(`journey.previous.${k}`, { other: shortName(ctx.hospitals[prev.supplier_ID]), reason });
}

function stateOf(r, legs, lead, persp, ctx) {
  if (r.status === 'CANCELLED') return { stage: lead ? Math.min(legStage(lead, ctx).stage, 4) : 2, key: 'cancelled' };
  if (persp === 'supplier' || persp === 'partner') {
    if (!lead) return { stage: 2, key: 'cancelled' };
    if (ACTIVE.includes(lead.status)) return legStage(lead, ctx);
    if (recalled(lead)) return { stage: 2, key: 'recalled' };
    return { stage: lead.status === 'REJECTED' ? 4 : 3, key: { DECLINED: 'declined', TIMED_OUT: 'timed_out', REJECTED: 'rejected' }[lead.status] || 'cancelled' };
  }
  if (lead && ACTIVE.includes(lead.status)) {
    const s = legStage(lead, ctx);
    if (s.key === 'waiting_supplier' && previousText(legs, lead, ctx)) return { ...s, key: 'waiting_supplier_fallback' };
    return s;
  }
  const plans = ctx.plans[r.ID] || [];
  const plansFresh = plans.length && (!lead || String(plans[0].createdAt || '') >= String(lead.modifiedAt || ''));
  if (plansFresh && r.status !== 'NO_MATCH') return { stage: 2, key: 'choose_supplier' };
  if (recalled(lead)) return { stage: 2, key: 'recalled' };
  if (r.status === 'OPEN') return { stage: 2, key: 'finding' };
  return { stage: 2, key: 'no_match' };
}

function timeline(r, legs, persp, viewer, ctx) {
  const ev = [];
  const add = (at, key, params = {}, kind = key) => at && ev.push({ at: new Date(at).toISOString(), time: fmtTime(at), kind, text: t(`timeline.${key}`, params) });
  const drug = drugName(ctx.drugs[r.drug_ID]);
  const own = viewer.hospitalId;
  add(r.createdAt, 'requested', { who: r.hospital_ID === own ? 'You' : shortName(ctx.hospitals[r.hospital_ID]), qty: r.qty, drug });
  const visible = persp === 'supplier' ? legs.filter(x => x.supplier_ID === own) : persp === 'partner' ? legs.filter(x => x.partner_ID === viewer.partnerId) : legs;
  for (const x of visible) {
    const other = x.supplier_ID === own ? 'you' : shortName(ctx.hospitals[x.supplier_ID]);
    const partner = ctx.partners[x.partner_ID]?.name;
    add(x.createdAt, 'asked', { other });
    if (x.status === 'DECLINED') add(x.modifiedAt, 'declined', { other });
    if (x.status === 'TIMED_OUT') add(x.modifiedAt, 'timed_out', { other, minutes: config.supplierResponseTimeoutMin });
    const loan = (ctx.loans[x.ID] || [])[0];
    if (loan && x.repaymentMode) add(loan.createdAt, 'accepted', { other, repay: t(`repay.${loan.repaymentMode}`) });
    const aps = (ctx.approvals[x.ID] || []).sort(by('decidedAt'));
    for (const a of aps) {
      if (a.decision === 'REJECT') add(a.decidedAt, 'rejected', { reason: a.reason });
      else add(a.decidedAt, 'signed', { level: a.level, levels: x.requiresSecondSignoff ? 2 : 1 });
    }
    if (x.partner_ID && ['ASSIGNED', 'IN_TRANSIT', 'DELIVERED', 'QUARANTINED'].includes(x.status)) add(aps.at(-1)?.decidedAt || x.modifiedAt, 'partner', { partner });
    add(x.pickedUpAt, 'picked_up', { partner });
    for (const c of (ctx.closures[x.ID] || [])) add(c.createdAt, 'rerouted', { closure: c.name });
    const ex = ctx.firstExcursion[x.ID];
    if (ex) add(ex.loggedAt, 'excursion', { temp: temp(ex.temperatureC) });
    if (x.status === 'DELIVERED') add(x.deliveredAt, 'delivered');
    if (x.status === 'QUARANTINED') add(x.deliveredAt, 'quarantined');
    if (x.status === 'CANCELLED') add(x.modifiedAt, recalled(x) ? 'recalled' : 'cancelled');
    if (loan?.status === 'SETTLED') add(loan.settledAt, 'repaid');
  }
  return ev.sort(by('at'));
}

function headline(key, persp, p, ctx, lead) {
  const side = persp === 'admin' ? 'receiver' : persp;
  let k = `journey.${key}.${side}`;
  if (key === 'waiting_supplier' && side === 'supplier' && ctx.reviews[lead?.ID] && !ctx.reviews[lead.ID].ownBookingsStayCovered) k += '_short';
  if (key === 'done' && side === 'supplier' && p.loanStatus === 'SETTLED') k += '_settled';
  if (key === 'done' && side === 'receiver' && !(p.booked > 0)) k += '_nobookings';
  const text = t(k, p) ?? t(`journey.${key}.receiver`, p) ?? '';
  return persp === 'admin' ? `${p.receiverName}: ${text}` : text;
}

/** Build one journey. Returns null if the viewer has no part in the request. */
function build(r, viewer, ctx) {
  const legs = (ctx.byRequest[r.ID] || []).sort(by('createdAt'));
  const persp = perspective(r, legs, viewer);
  if (!persp) return null;
  const lead = leadOf(r, legs, persp, viewer, ctx);
  const st = stateOf(r, legs, lead, persp, ctx);
  const drug = ctx.drugs[r.drug_ID];
  const log = lead && ctx.lastLog[lead.ID];
  const loan = lead && (ctx.loans[lead.ID] || [])[0];
  const cover = ctx.covers[r.ID];
  const counterpart = persp === 'supplier' ? ctx.hospitals[r.hospital_ID] : lead ? ctx.hospitals[lead.supplier_ID] : null;
  const p = {
    drug: drugName(drug), qty: lead?.qty ?? r.qty, date: fmtDate(r.neededBy), other: shortName(counterpart),
    from: shortName(ctx.hospitals[lead?.supplier_ID]), to: shortName(ctx.hospitals[r.hospital_ID]), receiverName: shortName(ctx.hospitals[r.hospital_ID]),
    partner: ctx.partners[lead?.partner_ID]?.name || '', eta: lead?.eta ? fmtClock(lead.eta) : '', temp: temp(log?.temperatureC),
    closure: st.closure?.name || '', reason: (ctx.approvals[lead?.ID] || []).find(a => a.decision === 'REJECT')?.reason || lead?.declineReason || '',
    previous: previousText(legs, lead, ctx) || '', covered: cover?.covered, booked: cover?.booked, loanStatus: loan?.status,
  };
  const planLeg = st.key === 'choose_supplier' ? JSON.parse((ctx.plans[r.ID] || []).sort(by('rank'))[0]?.legs || '[]')[0] : null;
  if (planLeg) p.other = shortName(ctx.hospitals[planLeg.hospitalId]) || planLeg.hospitalName || '';
  const items = timeline(r, legs, persp, viewer, ctx);
  const j = {
    id: r.ID, requestId: r.ID, transferId: lead?.ID || null, perspective: persp,
    drug: { id: r.drug_ID, name: p.drug }, qty: p.qty, neededBy: r.neededBy,
    stage: st.stage, of: 7, stageLabel: t(`journey.stage.${st.stage}`), key: st.key, colour: COLOUR[st.key] || 'amber',
    headline: headline(st.key, persp, p, ctx, lead),
    counterpart: p.other || null, from: p.from || null, to: p.to || null,
    respondBy: lead?.status === 'PENDING_SUPPLIER' ? lead.supplierResponseDueAt : null,
    risks: lead?.riskReasons ? String(lead.riskReasons).split(',') : [],
    eta: lead?.status === 'IN_TRANSIT' ? lead.eta : null, temperatureC: log ? Number(log.temperatureC) : null,
    note: ['ASSIGNED', 'IN_TRANSIT'].includes(lead?.status) && persp !== 'supplier' ? lead.transferNote || null : null,
    loan: loan ? { id: loan.ID, status: loan.status, qty: loan.qty, amount: Number(loan.landedCost), mode: loan.repaymentMode, lender: loan.lender_ID, borrower: loan.borrower_ID } : null,
    timeline: items, updatedAt: items.at(-1)?.at || r.createdAt || null,
  };
  // task-card hints: not part of the journey JSON
  Object.defineProperty(j, 'supplierShort', { value: !!(ctx.reviews[lead?.ID] && !ctx.reviews[lead.ID].ownBookingsStayCovered) });
  Object.defineProperty(j, 'planHint', { value: planLeg ? { distance: planLeg.distanceKm, minutes: planLeg.etaMin } : null });
  j.actions = require('./actions').forJourney(j, { r, lead, legs, viewer, ctx });
  return j;
}

/** Stage-1 journey for a red cover row that has no active request yet. */
function shortfallJourney(row, viewer) {
  const j = {
    id: `shortfall:${row.drugId}`, requestId: null, transferId: null, perspective: 'receiver',
    drug: { id: row.drugId, name: `${row.genericName} ${String(row.strength).split('/')[0]}` }, qty: row.shortfall, neededBy: row.firstAffectedDate,
    stage: 1, of: 7, stageLabel: t('journey.stage.1'), key: 'shortfall', colour: 'red',
    headline: t('journey.shortfall.receiver', { qty: row.shortfall, drug: `${row.genericName} ${String(row.strength).split('/')[0]}`, date: fmtDate(row.firstAffectedDate) }),
    counterpart: null, eta: null, temperatureC: null, note: null, loan: null, timeline: [], updatedAt: row.lastSyncedAt || null,
    patientsAffected: row.patientsAffected, booked: row.booked,
  };
  j.actions = require('./actions').forShortfall(j, viewer);
  return j;
}

// ---------- scoping ----------
const recent = (row, now = Date.now()) => !row.modifiedAt || now - new Date(row.modifiedAt).getTime() < RECENT_DAYS * 86400000;
const LIVE_REQUEST = ['OPEN', 'MATCHED', 'IN_PROGRESS', 'NO_MATCH'];

/** Request IDs this viewer should see on their home screen. */
async function scope(viewer) {
  const ids = new Set();
  const take = rows => rows.forEach(x => x && ids.add(x));
  const reqs = viewer.role === 'admin' ? await SELECT.from('medilink.Requests').columns('ID', 'status', 'modifiedAt')
    : viewer.hospitalId ? await SELECT.from('medilink.Requests').columns('ID', 'status', 'modifiedAt').where({ hospital_ID: viewer.hospitalId }) : [];
  take(reqs.filter(r => LIVE_REQUEST.includes(r.status) || recent(r)).map(r => r.ID));
  const legs = viewer.role === 'partner' && viewer.partnerId ? await SELECT.from(T).columns('ID', 'request_ID', 'status', 'modifiedAt').where({ partner_ID: viewer.partnerId })
    : viewer.hospitalId ? await SELECT.from(T).columns('ID', 'request_ID', 'status', 'modifiedAt').where({ supplier_ID: viewer.hospitalId }) : [];
  take(legs.filter(x => OPEN_LEG.includes(x.status) || recent(x)).map(x => x.request_ID));
  // open loans keep a finished journey visible to both sides
  if (viewer.hospitalId) {
    const loans = await SELECT.from('medilink.Ledger').columns('transfer_ID').where({ status: 'OPEN', lender_ID: viewer.hospitalId }).or({ status: 'OPEN', borrower_ID: viewer.hospitalId });
    if (loans.length) take((await SELECT.from(T).columns('request_ID').where(inList('ID', loans.map(l => l.transfer_ID)))).map(x => x.request_ID));
  }
  return [...ids];
}

async function buildAll(requestIds, viewer) {
  if (!requestIds.length) return [];
  const ctx = await load({ requestIds });
  const plan = ctx.requests.map(r => {
    const legs = (ctx.byRequest[r.ID] || []).sort(by('createdAt'));
    const persp = perspective(r, legs, viewer);
    return persp && { r, persp, lead: leadOf(r, legs, persp, viewer, ctx) };
  }).filter(Boolean);
  await enrich(ctx, plan);
  return plan.map(x => build(x.r, viewer, ctx)).filter(Boolean);
}

/** Active journeys for the viewer, newest first. */
async function forViewer(viewer) {
  const list = await buildAll(await scope(viewer), viewer);
  return list.sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')));
}

/** One journey by request ID (or transfer ID) for the viewer; null if not theirs. */
async function forId(id, viewer) {
  if (!id) return null;
  let reqId = id;
  const r = await SELECT.one.from('medilink.Requests').columns('ID').where({ ID: id });
  if (!r) { const x = await SELECT.one.from(T).columns('request_ID').where({ ID: id }); reqId = x?.request_ID; }
  return reqId ? (await buildAll([reqId], viewer))[0] || null : null;
}

module.exports = { viewerOf, forViewer, forId, shortfallJourney, buildAll, fmtDate, fmtDateLong, fmtTime, fmtClock, shortName, drugName, ACTIVE, COLOUR };
