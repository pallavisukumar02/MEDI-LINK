'use strict';
/*
 * Price vs distance for one open request (GET /me/journeys/:id/prices, docs/PRICING.md).
 * One point per hospital that can lend right now: only stock that passes all 8 hard rules is shown (matching.evaluate,
 * nothing is written). For each point: how many vials it can give (up to the request), the medicine price at that
 * hospital's tier (near-expiry batches first, as the matcher takes them), the courier quote for the distance, the
 * total, and the price per vial including delivery. Points nobody beats on both distance and price form the
 * "best trade-off" line (Pareto frontier). The pharmacist can ask any point, or split the order over up to three
 * (choose-suppliers -> workflow.chooseSuppliers, which runs the 8 rules again on live stock before anything is sent).
 */
const config = require('./config');
const pricing = require('./pricing');
const { action } = require('./actions');

const err = (status, code, message) => Object.assign(new Error(`${code}: ${message}`), { status, code });
const shortName = n => String(n || '').split(',')[0];
const OPEN = ['OPEN', 'MATCHED', 'NO_MATCH'];

async function forRequest(requestId, viewer) {
  const request = await SELECT.one.from('medilink.Requests').where({ ID: requestId });
  if (!request || (viewer.role !== 'admin' && request.hospital_ID !== viewer.hospitalId)) throw err(404, 'REQUEST_NOT_FOUND', 'Request unknown');
  const { evaluate } = require('./matching');
  const ev = await evaluate(request);
  const drug = ev.requestDrug;
  const plans = await SELECT.from('medilink.Plans').where({ request_ID: requestId }).orderBy('rank');
  const planOf = hid => plans.find(p => { const legs = JSON.parse(p.legs || '[]'); return legs.length === 1 && legs[0].hospitalId === hid; });

  const active = await SELECT.one.from('medilink.Transfers').columns('ID').where({ request_ID: requestId, status: { in: ['PENDING_SUPPLIER', 'PENDING_APPROVAL', 'PENDING_SECOND_APPROVAL', 'APPROVED', 'ASSIGNED', 'IN_TRANSIT'] } });
  const canChoose = OPEN.includes(request.status) && !active && viewer.role === 'pharmacist';
  const byH = {};
  for (const c of ev.candidates) (byH[c.hospitalId] ||= []).push(c);
  const points = [];
  for (const [hid, lots] of Object.entries(byH)) {
    let left = Math.min(Number(request.qty), Math.max(0, Number(ev.hospitalCaps[hid] ?? Infinity)));
    const parts = [];
    for (const c of [...lots].sort((a, b) => a.daysToExpiry - b.daysToExpiry)) { // same order the matcher takes them
      if (left <= 0) break;
      const q = Math.min(c.maxQty, left);
      if (q > 0) { parts.push({ ...c, qty: q }); left -= q; }
    }
    if (!parts.length) continue;
    const m = pricing.medicineCost(parts);
    const first = parts[0];
    const delivery = pricing.deliveryCost(drug.storageClass, first.distanceKm);
    const plan = planOf(hid);
    const name = shortName(first.hospitalName);
    points.push({
      hospitalId: hid, hospitalName: name, pharma: [...new Set(parts.map(p => [p.brandName, p.manufacturer && String(p.manufacturer).replace(/\s*\(synthetic\)/, '')].filter(Boolean).join(' / ')))].join('; '),
      distanceKm: Math.round(Number(first.distanceKm) * 10) / 10, etaMin: first.etaMin,
      qty: m.qty, fullyCovers: m.qty >= Number(request.qty), unitPrice: m.perUnit, medicineCost: m.medicine, deliveryCost: delivery,
      totalCost: pricing.round2(m.medicine + delivery), costPerUnit: pricing.round2((m.medicine + delivery) / m.qty),
      nearExpiry: parts.some(p => p.nearExpiry), batches: parts.map(p => ({ batchNo: p.batchNo, qty: p.qty, expiryDate: p.expiryDate, unitPrice: p.unitPrice, nearExpiry: p.nearExpiry })),
      tags: [], planRank: plan?.rank ?? null,
      // any safe hospital can be chosen (the rules run again when it is sent); split orders add more hospitals in the UI
      action: canChoose ? action('choose-suppliers', { body: { requestId, hospitals: hid }, params: { other: name, qty: m.qty }, confirm: true }) : null,
    });
  }
  const best = (key, label) => { const p = [...points].sort((a, b) => a[key] - b[key] || a.distanceKm - b.distanceKm)[0]; if (p) p.tags.push(label); return p; };
  const nearest = best('distanceKm', 'Nearest');
  best('costPerUnit', 'Lowest price');
  const fastest = [...points].sort((a, b) => a.etaMin - b.etaMin)[0];
  if (fastest && fastest !== nearest) fastest.tags.push('Fastest');
  const frontier = pricing.paretoFrontier(points);
  for (const p of frontier) if (!p.tags.length) p.tags.push('Good trade-off');

  // how far a courier can come and still arrive before the end of the needed-by day (urgency line), at the observed speed
  const minutesLeft = (new Date(String(request.neededBy).slice(0, 10) + 'T23:59:59Z').getTime() - Date.now()) / 60000;
  const kmPerMin = points.length ? points.reduce((s, p) => s + p.distanceKm, 0) / Math.max(1, points.reduce((s, p) => s + Number(p.etaMin || 0), 0)) : 0;
  return {
    requestId, canChoose, maxSuppliers: 3, drug: { id: drug.ID, name: `${drug.genericName} ${String(drug.strength).split('/')[0]}`, storageClass: drug.storageClass },
    qty: Number(request.qty), neededBy: String(request.neededBy).slice(0, 10), status: request.status,
    landedCost: Number(drug.unitCost || 0), // reference line: the most any hospital may charge per vial
    urgencyKm: kmPerMin > 0 && minutesLeft > 0 ? Math.round(kmPerMin * minutesLeft) : null,
    delivery: pricing.rates()[drug.storageClass] || null, nearExpiryDiscountPct: config.nearExpiryDiscountPct,
    points: points.sort((a, b) => a.distanceKm - b.distanceKm), paretoFrontier: frontier.map(p => p.hospitalId),
    ruledOut: ev.exclusions.length, // lots the safety rules kept off the chart
    asOf: new Date().toISOString(), synthetic: true, currency: 'INR'
  };
}

module.exports = { forRequest };
