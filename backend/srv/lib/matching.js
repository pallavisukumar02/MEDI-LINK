'use strict';
// Hard rules over city-wide lots (FR-16) + ranking via the OR-Tools matcher (FR-17).
const cds = require('@sap/cds');
const config = require('./config');
const http = require('./http');
const audit = require('./audit');
const routing = require('./routing');
const geo = require('./geo');
const coverdb = require('./coverdb');
const sync = require('./sync');
const { maxGivable, isUsable, toDay, daysBetween } = require('./cover');
const { evaluateLot } = require('./rules');
const LOG = cds.log('matching');

async function licenceMap() {
  const lics = await SELECT.from('medilink.Licences');
  return Object.fromEntries(lics.map(l => [l.partyId, l]));
}

/**
 * Evaluate every candidate lot city-wide for a request.
 * @returns {{ candidates: Array, exclusions: Array, ctx }}
 */
async function evaluate(request, { excludeHospitals = [], now = new Date() } = {}) {
  const today = now.toISOString().slice(0, 10);
  const drugs = await coverdb.drugsById();
  const requestDrug = drugs[request.drug_ID];
  const sameGeneric = Object.values(drugs).filter(d => d.genericName.toLowerCase() === requestDrug.genericName.toLowerCase()).map(d => d.ID);
  const ctx = await coverdb.loadContext();
  const hospitals = Object.fromEntries(ctx.hospitals.map(h => [h.ID, h]));
  const receiver = hospitals[request.hospital_ID];
  const [licences, partners, closures, reserved] = await Promise.all([licenceMap(), SELECT.from('medilink.DeliveryPartners'), SELECT.from('medilink.RoadClosures').where({ active: true }), coverdb.reservations()]);

  const candidatesLots = ctx.lots.filter(l => sameGeneric.includes(l.drug_ID) && l.hospital_ID !== receiver.ID && Number(l.quantity) > 0 && !excludeHospitals.includes(l.hospital_ID) && hospitals[l.hospital_ID]?.connected); // disconnected = consent withdrawn: its last stock is frozen
  const routeCache = {};
  const straight = await geo.distancesKm(receiver, [...new Set(candidatesLots.map(l => l.hospital_ID))].map(id => hospitals[id]));
  const candidates = [], exclusions = [];
  for (const lot of candidatesLots) {
    const supplier = hospitals[lot.hospital_ID];
    if (supplier.feedStale) { exclusions.push(exclusion(lot, supplier, { rule: 1, ruleName: 'GENUINE_SURPLUS', code: 'STALE_FEED', detail: 'Supplier feed is stale; stock cannot be trusted until it re-syncs' })); continue; }
    routeCache[supplier.ID] ||= await routing.route(supplier, receiver, closures, straight[supplier.ID]);
    const route = routeCache[supplier.ID];
    const own = { lots: ctx.lots.filter(l => l.hospital_ID === supplier.ID && l.drug_ID === lot.drug_ID), bookings: ctx.bookings.filter(b => b.hospital_ID === supplier.ID && b.drug_ID === lot.drug_ID) };
    const usable = isUsable(lot, today, ctx.isFlagged);
    const givable = usable ? maxGivable({ ...own, today, windowDays: supplier.coverWindowDays || config.coverWindowDays, safetyMarginPct: supplier.safetyMarginPct ?? config.safetyMarginPct, isFlagged: ctx.isFlagged, lotId: lot.ID, alreadyRemoved: reserved }) : 0;
    const result = evaluateLot({
      request: { ...request, neededBy: toDay(request.neededBy) }, requestDrug, lotDrug: drugs[lot.drug_ID], lot,
      maxGivable: givable, surplusApplicable: usable, flags: ctx.flags, partners, partnerLicences: licences,
      supplierLicence: licences[supplier.ID] || { validTill: supplier.licenceValidTill, licenceNo: supplier.licenceNo },
      receiverLicence: licences[receiver.ID] || { validTill: receiver.licenceValidTill, licenceNo: receiver.licenceNo },
      transferDate: today, expiryBufferDays: config.expiryBufferDays, route, now,
    });
    if (result.eligible) {
      const dte = daysBetween(today, lot.expiryDate);
      candidates.push({ lotId: lot.ID, hospitalId: supplier.ID, hospitalName: supplier.name, lat: Number(supplier.lat), long: Number(supplier.long), maxQty: result.maxQty, distanceKm: route.distanceKm, etaMin: route.etaMin, expiryDate: toDay(lot.expiryDate), daysToExpiry: dte, nearExpiry: dte <= config.nearExpiryDays, batchNo: lot.batchNo, brandName: lot.brandName });
    } else {
      for (const e of result.exclusions) exclusions.push(exclusion(lot, supplier, e));
    }
  }
  // Hospital-level cap = genuine surplus (lots from one supplier must not jointly exceed it)
  const hospitalCaps = {};
  for (const c of candidates) {
    if (hospitalCaps[c.hospitalId] !== undefined) continue;
    const h = hospitals[c.hospitalId];
    const cov = coverdb.coverFor(ctx, h, request.drug_ID, h.coverWindowDays || config.coverWindowDays, reserved);
    hospitalCaps[c.hospitalId] = cov.surplus;
  }
  return { candidates, exclusions, hospitalCaps, receiver, requestDrug, hospitals };
}

function exclusion(lot, supplier, e) {
  return { lotId: lot.ID, hospitalId: supplier.ID, hospitalName: supplier.name, batchNo: lot.batchNo, rule: e.rule, ruleName: e.ruleName, code: e.code, detail: e.detail };
}

/** Call the Python OR-Tools matcher; greedy fallback if it is unreachable (and fallback is enabled). */
async function callMatcher(payload) {
  try {
    const res = await http.request(`${config.matcherUrl}/rank`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(config.matcherToken ? { 'X-Matcher-Token': config.matcherToken } : {}) }, body: JSON.stringify(payload), timeoutMs: config.matcherTimeoutMs });
    if (res.status === 200 && res.json) return res.json;
    throw new Error('matcher status ' + res.status);
  } catch (e) {
    if (!config.matcherFallback) { const err = new Error('MATCHER_UNAVAILABLE: ' + e.message); err.status = 503; throw err; }
    LOG.warn('matcher unavailable, using built-in greedy fallback:', e.message);
    return greedyRank(payload);
  }
}

/** Minimal fallback: nearest hospital first, near-expiry lots first within a hospital. */
function greedyRank({ qty, candidates, hospitalCaps = {}, maxPlans = 3 }) {
  const byH = {};
  for (const c of candidates) (byH[c.hospitalId] ||= []).push(c);
  const order = Object.keys(byH).sort((a, b) => byH[a][0].distanceKm - byH[b][0].distanceKm);
  const plans = [];
  for (let start = 0; start < order.length && plans.length < maxPlans; start++) {
    let need = qty; const legs = [];
    for (const h of [order[start], ...order.filter((_, i) => i !== start)]) {
      if (need <= 0) break;
      let cap = Math.min(hospitalCaps[h] ?? Infinity, need);
      const lots = [];
      for (const c of [...byH[h]].sort((a, b) => a.daysToExpiry - b.daysToExpiry)) {
        if (cap <= 0) break;
        const q = Math.min(c.maxQty, cap); if (q <= 0) continue;
        lots.push({ lotId: c.lotId, batchNo: c.batchNo, brandName: c.brandName, qty: q, expiryDate: c.expiryDate, daysToExpiry: c.daysToExpiry, nearExpiry: c.nearExpiry });
        cap -= q; need -= q;
      }
      if (lots.length) legs.push({ hospitalId: h, hospitalName: byH[h][0].hospitalName, distanceKm: byH[h][0].distanceKm, etaMin: byH[h][0].etaMin, qty: lots.reduce((s, l) => s + l.qty, 0), lots });
    }
    const totalQty = legs.reduce((s, l) => s + l.qty, 0);
    const key = legs.map(l => l.hospitalId).sort().join(',');
    if (!legs.length || plans.some(p => p._key === key)) continue;
    plans.push({ _key: key, rank: plans.length + 1, legs, totalQty, transfers: legs.length, fullyCovers: totalQty >= qty, score: legs.reduce((s, l) => s + l.distanceKm, 0),
      reason: `${legs[0].hospitalName} is ${legs[0].distanceKm} km away (~${legs[0].etaMin} min); ${legs.length === 1 ? 'one transfer' : legs.length + ' transfers'} cover ${totalQty} of ${qty} doses.`, reasonSource: 'template' });
  }
  return { engine: 'fallback-greedy', plans: plans.map(({ _key, ...p }) => p) };
}

/** Full ranking for a request; persists Plans + Exclusions and audits the rule exclusions. */
async function rankRequest(requestId, { excludeHospitals = [], qty, actor = 'system', resync = true } = {}) {
  const request = await SELECT.one.from('medilink.Requests').where({ ID: requestId });
  if (!request) { const e = new Error('REQUEST_NOT_FOUND'); e.status = 404; throw e; }
  if (resync) await sync.syncAll(); // NFR freshness: forced re-sync before any plan is shown
  const need = qty ?? request.qty;
  const ev = await evaluate(request, { excludeHospitals });
  const payload = {
    requestId, qty: need, neededBy: toDay(request.neededBy),
    receiver: { id: ev.receiver.ID, lat: Number(ev.receiver.lat), long: Number(ev.receiver.long) },
    drug: { id: ev.requestDrug.ID, genericName: ev.requestDrug.genericName, strength: ev.requestDrug.strength },
    candidates: ev.candidates, hospitalCaps: ev.hospitalCaps, maxPlans: 3, nearExpiryDays: config.nearExpiryDays,
  };
  const result = ev.candidates.length ? await callMatcher(payload) : { engine: 'none', plans: [] };

  await DELETE.from('medilink.Plans').where({ request_ID: requestId });
  await DELETE.from('medilink.Exclusions').where({ request_ID: requestId });
  if (ev.exclusions.length) await INSERT.into('medilink.Exclusions').entries(ev.exclusions.map(e => ({ ID: cds.utils.uuid(), request_ID: requestId, lot_ID: e.lotId, hospital_ID: e.hospitalId, rule: e.rule, code: e.code, detail: e.detail })));
  const now = new Date().toISOString();
  if (result.plans.length) await INSERT.into('medilink.Plans').entries(result.plans.map(p => ({ ID: cds.utils.uuid(), request_ID: requestId, rank: p.rank, legs: JSON.stringify(p.legs), totalQty: p.totalQty, transfers: p.transfers, score: p.score, reason: p.reason, engine: result.engine, createdAt: now })));
  if (!['IN_PROGRESS', 'FULFILLED'].includes(request.status)) await UPDATE('medilink.Requests').set({ status: result.plans.length ? 'MATCHED' : 'NO_MATCH' }).where({ ID: requestId });

  const summary = {};
  for (const e of ev.exclusions) summary[e.code] = (summary[e.code] || 0) + 1;
  await audit.log(actor, 'RULES_APPLIED', { request: requestId, qty: need, eligibleLots: ev.candidates.length, excluded: ev.exclusions.map(e => ({ lot: e.lotId, rule: e.rule, code: e.code })), summary, engine: result.engine, plans: result.plans.length });
  return { requestId, qty: need, neededBy: toDay(request.neededBy), engine: result.engine, eligible: ev.candidates.length, plans: result.plans, exclusions: ev.exclusions };
}

module.exports = { evaluate, rankRequest, callMatcher, greedyRank };
