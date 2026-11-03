'use strict';
/*
 * Price vs distance (docs/PRICING.md). What a borrowing hospital pays for one supplier's stock, next to how far
 * away it is. Price is shown to help the pharmacist decide; it never changes which lots pass the 8 hard rules and
 * never changes the matcher's ranking (nearest safe stock, near-expiry first).
 *
 *   medicine price per unit = Lot.unitPrice, or Drug.unitCost x Hospital.pricingMultiplier
 *                             minus NEAR_EXPIRY_DISCOUNT_PCT for batches inside the near-expiry window,
 *                             and never above Drug.unitCost (the landed cost: hospitals lend at cost, not for profit;
 *                             most of these medicines are also under DPCO ceiling prices)
 *   delivery quote          = base fee + rate per km, by storage class (DELIVERY_RATES, synthetic)
 *   total                   = medicine price x qty + delivery
 * All prices in INR, synthetic.
 */
const config = require('./config');

const round2 = v => Math.round(Number(v) * 100) / 100;
const clampMult = m => (Number.isFinite(Number(m)) && m !== null && m !== '' ? Math.min(1, Math.max(0.5, Number(m))) : 1);

function rates() {
  const out = {};
  for (const part of String(config.deliveryRates || '').split(',')) {
    const [cls, base, perKm] = part.split(':').map(s => s.trim());
    if (cls && Number.isFinite(Number(base)) && Number.isFinite(Number(perKm))) out[cls.toUpperCase()] = { base: Number(base), perKm: Number(perKm) };
  }
  return out;
}

/** Price per unit of one lot from one hospital. nearExpiry = the lot is inside the near-expiry window. */
function unitPrice({ lot = {}, drug, hospital = {}, nearExpiry = false }) {
  const cost = Number(drug?.unitCost || 0);
  let p = lot.unitPrice !== null && lot.unitPrice !== undefined && lot.unitPrice !== '' ? Number(lot.unitPrice) : cost * clampMult(hospital.pricingMultiplier);
  if (nearExpiry) p *= 1 - Math.min(90, Math.max(0, config.nearExpiryDiscountPct)) / 100;
  return round2(Math.max(0, cost ? Math.min(p, cost) : p));
}

/** Courier quote for one delivery of this storage class over distanceKm. */
function deliveryCost(storageClass, distanceKm) {
  const r = rates();
  const k = r[String(storageClass || 'AMBIENT').toUpperCase()] || r.AMBIENT || { base: 0, perKm: 0 };
  return Math.round(k.base + k.perKm * Math.max(0, Number(distanceKm) || 0));
}

/** Weighted price of lots taken in order: [{qty, unitPrice}] -> { medicine, perUnit }. */
function medicineCost(parts) {
  const qty = parts.reduce((s, p) => s + Number(p.qty), 0);
  const medicine = round2(parts.reduce((s, p) => s + Number(p.qty) * Number(p.unitPrice), 0));
  return { qty, medicine, perUnit: qty ? round2(medicine / qty) : 0 };
}

/** Points not beaten on both distance and price per unit (lower is better on both). */
function paretoFrontier(points) {
  const front = points.filter(p => !points.some(q => q !== p && q.distanceKm <= p.distanceKm && q.costPerUnit <= p.costPerUnit && (q.distanceKm < p.distanceKm || q.costPerUnit < p.costPerUnit)));
  return front.sort((a, b) => a.distanceKm - b.distanceKm);
}

/** Loan value of the lots in a transfer: [{lot, qty}] with the supplier and drug. */
function loanValue(drug, hospital, items, today) {
  const { daysBetween } = require('./cover');
  return medicineCost(items.map(({ lot, qty }) => ({ qty, unitPrice: unitPrice({ lot, drug, hospital, nearExpiry: lot?.expiryDate ? daysBetween(today, lot.expiryDate) <= config.nearExpiryDays : false }) })));
}

module.exports = { unitPrice, deliveryCost, medicineCost, paretoFrontier, loanValue, rates, clampMult, round2 };
