'use strict';
/*
 * Plan review (Agentic AI step 4): three agents look at the supplier plans the OR-Tools matcher produced.
 *   compliance  re-runs the 8 hard rules on every batch of every plan against the stock as it is now
 *               (a plan that fails here can never be recommended, whatever the LLM says)
 *   critic      looks for what the rules do not cover: would the lending hospital drop below its own safety
 *               margin, is a closed or flooded road near the way, are the cold-chain partners already busy,
 *               does the plan cover the full quantity
 *   planner     picks the best verified plan and writes "why this plan" with the trade-offs.
 *               LLM on: the model proposes {recommend, why}; its pick must be a verified plan and every number in
 *               its text must come from the facts, otherwise the rules pick and template text are used.
 * The pharmacist still decides: the review ends in the usual "Ask <hospital>" button (choose-plan).
 */
const cds = require('@sap/cds');
const runner = require('./runner');
const audit = require('../audit');
const llm = require('../llm');
const coverdb = require('../coverdb');
const { partnerCanCarry, licenceValid } = require('../rules');
const { t } = require('../messages');
const { shortName } = require('./tools');
const pricing = require('../pricing');

const err = (status, code, message) => Object.assign(new Error(`${code}: ${message}`), { status, code });
const PENALTY = { donor_short: 5, partial_cover: 4, road_closure: 3, donor_below_margin: 2, partners_busy: 1 };
const WARN_TEXT = {
  donor_short: h => `${h} would run short of its own booked doses after lending`,
  donor_below_margin: h => `${h} would drop below its own safety margin after lending`,
  road_closure: h => `a closed or flooded road is close to the way from ${h}`,
  partners_busy: () => 'every certified delivery partner already has 2 or more deliveries',
  partial_cover: () => 'covers only part of the quantity',
  uses_near_expiry: h => `uses batches from ${h} that would otherwise expire soon (good: less waste)`,
};

/** km from point p to the straight segment a-b (flat-earth approximation, fine at city scale). */
function kmToSegment(p, a, b) {
  const kx = 111.32 * Math.cos((Number(a.lat) * Math.PI) / 180), ky = 110.57;
  const P = [Number(p.long) * kx, Number(p.lat) * ky], A = [Number(a.long) * kx, Number(a.lat) * ky], B = [Number(b.long) * kx, Number(b.lat) * ky];
  const AB = [B[0] - A[0], B[1] - A[1]], L = AB[0] ** 2 + AB[1] ** 2;
  const u = L ? Math.max(0, Math.min(1, ((P[0] - A[0]) * AB[0] + (P[1] - A[1]) * AB[1]) / L)) : 0;
  return Math.hypot(P[0] - (A[0] + u * AB[0]), P[1] - (A[1] + u * AB[1]));
}

// ---------------------------------------------------------------- compliance agent (hard rules as a tool)
async function compliance(request, plans) {
  const { evaluate } = require('../matching');
  const ev = await evaluate(request);
  const byLot = Object.fromEntries(ev.candidates.map(c => [c.lotId, c]));
  return {
    ev,
    results: plans.map(p => {
      const failures = [];
      for (const leg of p.legs) {
        const name = shortName(leg.hospitalName || ev.hospitals[leg.hospitalId]?.name);
        for (const l of leg.lots || []) {
          const c = byLot[l.lotId];
          if (!c) {
            const ex = ev.exclusions.find(e => e.lotId === l.lotId);
            failures.push(`${name}, batch ${l.batchNo || ''}: ${ex ? t(`error.${ex.code}.title`) : 'no longer in stock'}`);
          } else if (Number(l.qty) > Number(c.maxQty)) failures.push(`${name}, batch ${l.batchNo}: only ${c.maxQty} can be given now`);
        }
        const legQty = (leg.lots || []).reduce((s, l) => s + Number(l.qty), 0);
        if (ev.hospitalCaps[leg.hospitalId] !== undefined && legQty > ev.hospitalCaps[leg.hospitalId]) failures.push(`${name}: its spare stock is now ${Math.max(0, ev.hospitalCaps[leg.hospitalId])}`);
      }
      return { rank: p.rank, verified: failures.length === 0, failures };
    }),
  };
}

// ---------------------------------------------------------------- critic agent
async function critic(request, plans, ev) {
  const drug = ev.requestDrug, receiver = ev.receiver;
  const [reserved, closures, partners, partnerLic, active] = await Promise.all([
    coverdb.reservations(), SELECT.from('medilink.RoadClosures').where({ active: true }), SELECT.from('medilink.DeliveryPartners'),
    SELECT.from('medilink.Licences').where({ partyType: 'PARTNER' }), SELECT.from('medilink.Transfers').columns('partner_ID').where({ status: { in: ['ASSIGNED', 'IN_TRANSIT'] } }),
  ]);
  const lic = Object.fromEntries(partnerLic.map(l => [l.partyId, l]));
  const today = coverdb.today();
  const capable = partners.filter(p => p.active !== false && partnerCanCarry(p, drug.storageClass) && licenceValid(lic[p.ID]?.validTill, today));
  const load = id => active.filter(x => x.partner_ID === id).length;
  const busy = capable.length > 0 && capable.every(p => load(p.ID) >= 2);
  const out = [];
  for (const p of plans) {
    const warnings = [], notes = [];
    if (Number(p.totalQty) < Number(request.qty)) warnings.push({ code: 'partial_cover', text: WARN_TEXT.partial_cover() });
    if (busy) warnings.push({ code: 'partners_busy', text: WARN_TEXT.partners_busy() });
    for (const leg of p.legs) {
      const h = ev.hospitals[leg.hospitalId];
      const name = shortName(leg.hospitalName || h?.name);
      const removals = { ...reserved };
      for (const l of leg.lots || []) removals[l.lotId] = (removals[l.lotId] || 0) + Number(l.qty);
      const { row } = await coverdb.rowFor(leg.hospitalId, request.drug_ID, removals);
      if (row.status === 'RED') warnings.push({ code: 'donor_short', text: WARN_TEXT.donor_short(name) });
      else if (row.belowMargin) warnings.push({ code: 'donor_below_margin', text: WARN_TEXT.donor_below_margin(name) });
      if (h && closures.some(c => kmToSegment(c, h, receiver) <= Number(c.radiusKm) + 0.5)) warnings.push({ code: 'road_closure', text: WARN_TEXT.road_closure(name) });
      if ((leg.lots || []).some(l => l.nearExpiry)) notes.push({ code: 'uses_near_expiry', text: WARN_TEXT.uses_near_expiry(name) });
    }
    out.push({ rank: p.rank, warnings, notes, penalty: warnings.reduce((s, w) => s + (PENALTY[w.code] || 0), 0) });
  }
  return out;
}

// ---------------------------------------------------------------- planner agent
function summarise(p) {
  return { rank: p.rank, totalQty: p.totalQty, legs: p.legs.map(l => ({ hospital: shortName(l.hospitalName), qty: (l.lots || []).reduce((s, x) => s + Number(x.qty), 0), distanceKm: Math.round(Number(l.distanceKm) * 10) / 10, etaMin: l.etaMin })) };
}
const legText = s => s.legs.map(l => `${l.qty} from ${l.hospital} (${l.distanceKm} km, about ${l.etaMin} min)`).join(' and ');

function templateWhy(best, others, request) {
  const lines = [`Plan ${best.rank} is recommended: ${legText(best)}${best.totalQty < request.qty ? `, ${best.totalQty} of ${request.qty} vials` : ''}${best.cost ? `, about ₹${inr(best.cost.total)} with delivery (₹${inr(best.cost.perUnit)} a vial)` : ''}.`];
  lines.push('Every batch passed all 8 safety rules again just now.');
  if (best.warnings.length) lines.push(`Watch out: ${best.warnings.map(w => w.text).join('; ')}.`);
  else lines.push('The lending hospital stays covered for its own patients, no closed road is near the way, and a certified partner is free.');
  if (best.notes.length) lines.push(cap(best.notes.map(n => n.text).join('; ')) + '.');
  const next = others.find(o => o.verified);
  if (next) {
    const dKm = Math.round((next.legs.reduce((s, l) => s + l.distanceKm, 0) - best.legs.reduce((s, l) => s + l.distanceKm, 0)) * 10) / 10;
    const why = next.warnings.length ? next.warnings.map(w => w.text).join('; ') : dKm > 0 ? `${dKm} km farther` : next.legs.length > best.legs.length ? 'needs more deliveries' : 'ranked lower by the matcher';
    const save = best.cost && next.cost ? Math.round(best.cost.perUnit - next.cost.perUnit) : 0;
    lines.push(`Plan ${next.rank} is the backup: ${why}${save > 0 ? `, though it costs ₹${inr(save)} less per vial with delivery` : save < 0 ? `, and it costs ₹${inr(-save)} more per vial` : ''}.`);
  }
  const failed = others.filter(o => !o.verified);
  if (failed.length) lines.push(`Not offered: plan ${failed.map(f => f.rank).join(', ')} (${failed[0].failures[0]}).`);
  return lines.join(' ');
}
const cap = s => s.charAt(0).toUpperCase() + s.slice(1);
const inr = v => Math.round(Number(v)).toLocaleString('en-IN');

async function review(requestId, viewer, actor) {
  const request = await SELECT.one.from('medilink.Requests').where({ ID: requestId });
  if (!request || (viewer.role !== 'admin' && request.hospital_ID !== viewer.hospitalId)) throw err(404, 'REQUEST_NOT_FOUND', 'Request unknown');
  const plans = (await SELECT.from('medilink.Plans').where({ request_ID: requestId }).orderBy('rank')).map(p => ({ ...p, legs: JSON.parse(p.legs || '[]') }));
  if (!plans.length) throw err(409, 'NO_PLANS_TO_REVIEW', 'No supplier plans yet');
  const runId = cds.utils.uuid();
  const log = (tool, payload) => audit.log('agent:planner', 'AGENT_TOOL', { run: runId, tool, request: requestId, ...payload });

  const comp = await compliance(request, plans);
  await log('compliance.hard_rules', { verified: comp.results.filter(r => r.verified).map(r => r.rank), failed: comp.results.filter(r => !r.verified).map(r => r.rank) });
  const crit = await critic(request, plans, comp.ev);
  await log('critic.checks', { warnings: crit.map(c => ({ rank: c.rank, codes: c.warnings.map(w => w.code) })) });

  const priceOf = Object.fromEntries(comp.ev.candidates.map(c => [c.lotId, c.unitPrice]));
  const costOf = p => { // price vs distance: what this plan costs the borrowing hospital (shown, never ranked on)
    const parts = p.legs.flatMap(l => (l.lots || []).map(x => ({ qty: x.qty, unitPrice: priceOf[x.lotId] })));
    if (!parts.length || parts.some(x => x.unitPrice === undefined)) return null;
    const m = pricing.medicineCost(parts), delivery = p.legs.reduce((s, l) => s + pricing.deliveryCost(comp.ev.requestDrug.storageClass, l.distanceKm), 0);
    return { medicine: m.medicine, delivery, total: pricing.round2(m.medicine + delivery), perUnit: pricing.round2((m.medicine + delivery) / m.qty) };
  };
  const all = plans.map(p => {
    const c = comp.results.find(r => r.rank === p.rank), k = crit.find(r => r.rank === p.rank);
    return { ...summarise(p), engine: p.engine, verified: c.verified, failures: c.failures, warnings: k.warnings, notes: k.notes, cost: c.verified ? costOf(p) : null, score: p.rank + k.penalty };
  });
  const verified = all.filter(p => p.verified).sort((a, b) => a.score - b.score || a.rank - b.rank);
  let best = verified[0] || null, why = best ? templateWhy(best, all.filter(p => p !== best), request) : `None of the ${all.length} plans passes the safety rules any more (${all[0].failures[0]}). Find a supplier again.`;
  let mode = 'rules', overridden = null;

  if (best && runner.enabled() && llm.enabled()) {
    const facts = { requested: request.qty, neededBy: String(request.neededBy).slice(0, 10), plans: all.map(({ engine, score, ...p }) => p) };
    const reply = llm.extractJson(await llm.safeChat([
      { role: 'system', content: 'You are the MediLink transfer planner. Pick the best plan for a cancer-medicine transfer between hospitals. Only plans with "verified": true may be picked: they passed the hard safety rules. Prefer no warnings, then shorter trips, then fewer deliveries. Reply with JSON only: {"recommend": <rank>, "why": "<3 short sentences for a pharmacist, with the trade-off against the backup>"}. Use only the numbers in the facts.' },
      { role: 'user', content: JSON.stringify(facts) }, // includes each verified plan's cost: the model may mention it, the rules decide
    ], { maxTokens: 300 }));
    await log('planner.llm', { recommend: reply?.recommend ?? null });
    const pick = reply && verified.find(p => p.rank === Number(reply.recommend));
    if (reply && !pick) overridden = `The AI suggested plan ${reply.recommend}, which did not pass the safety checks; MediLink picked plan ${best.rank} instead.`;
    else if (pick && reply.why && runner.numbersGrounded(reply.why, facts)) { best = pick; why = String(reply.why).trim().slice(0, 900); mode = 'llm'; }
    else if (pick) { best = pick; why = templateWhy(best, all.filter(p => p !== best), request); mode = 'llm'; }
  }

  const result = { requestId, recommended: best?.rank ?? null, explanation: overridden ? `${why} ${overridden}` : why, plans: all, mode, checkedAt: new Date().toISOString() };
  await runner.record({ runId, agent: 'planner', hospitalId: request.hospital_ID, actor, mode, input: `review plans for request ${requestId}`, output: { recommended: result.recommended, verified: verified.map(v => v.rank), overridden: !!overridden }, steps: 3 });
  return result;
}

module.exports = { review, compliance, critic, kmToSegment, templateWhy };
