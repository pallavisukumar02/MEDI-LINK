'use strict';
// Database-facing cover calculations (wraps the pure functions in cover.js).
const cds = require('@sap/cds');
const config = require('./config');
const { computeCover, maxGivable, isUsable, toDay, daysBetween, STATUS_ORDER } = require('./cover');
const { matchFlag } = require('./rules');

const today = () => new Date().toISOString().slice(0, 10);
const VALID_WINDOWS = [7, 14, 21];
const windowOf = w => (VALID_WINDOWS.includes(Number(w)) ? Number(w) : config.coverWindowDays);

async function loadFlags() { return SELECT.from('medilink.Flags').where({ active: true }); }
async function drugsById() {
  const drugs = await SELECT.from('medilink.Drugs');
  return Object.fromEntries(drugs.map(d => [d.ID, d]));
}
function flagChecker(flags, drugs) {
  return lot => !!matchFlag(lot, drugs[lot.drug_ID], flags);
}

/** Everything needed to compute cover for one or more hospitals. */
async function loadContext(hospitalIds) {
  const where = hospitalIds ? { hospital_ID: { in: hospitalIds } } : {};
  const [lots, bookings, flags, drugs, hospitals] = await Promise.all([
    SELECT.from('medilink.Lots').where(where),
    SELECT.from('medilink.Bookings').where({ ...where, scheduledDate: { '>=': today() } }),
    loadFlags(), drugsById(),
    hospitalIds ? SELECT.from('medilink.Hospitals').where({ ID: { in: hospitalIds } }) : SELECT.from('medilink.Hospitals'),
  ]);
  return { lots, bookings, flags, drugs, hospitals, isFlagged: flagChecker(flags, drugs) };
}

function coverFor(ctx, hospital, drugId, windowDays, removals) {
  return computeCover({
    lots: ctx.lots.filter(l => l.hospital_ID === hospital.ID && l.drug_ID === drugId),
    bookings: ctx.bookings.filter(b => b.hospital_ID === hospital.ID && b.drug_ID === drugId),
    today: today(), windowDays, safetyMarginPct: hospital.safetyMarginPct ?? config.safetyMarginPct, isFlagged: ctx.isFlagged, removals,
  });
}

function row(ctx, hospital, drug, c) {
  const nearExpiryQty = ctx.lots
    .filter(l => l.hospital_ID === hospital.ID && l.drug_ID === drug.ID && isUsable(l, today(), ctx.isFlagged) && daysBetween(today(), l.expiryDate) <= config.nearExpiryDays)
    .reduce((s, l) => s + Number(l.quantity), 0);
  const message = c.status === 'RED'
    ? `${c.shortfall} of ${c.booked} booked doses short, ${c.patientsAffected} patient${c.patientsAffected === 1 ? '' : 's'} affected first`
    : c.belowMargin ? `Covered, but below the ${hospital.safetyMarginPct ?? config.safetyMarginPct}% safety margin` : c.status === 'NONE' ? 'No stock or bookings' : 'Covered';
  return {
    hospitalId: hospital.ID, hospitalName: hospital.name, drugId: drug.ID, genericName: drug.genericName, strength: drug.strength, dosageForm: drug.dosageForm, storageClass: drug.storageClass,
    windowDays: c.windowDays, status: c.status, belowMargin: c.belowMargin, booked: c.booked, covered: c.covered, shortfall: c.shortfall, coverPct: c.coverPct, usableStock: c.usableStock,
    margin: c.margin, surplus: c.surplus, patientsAffected: c.patientsAffected, firstAffectedDate: c.firstAffectedDate, nearExpiryQty,
    lastSyncedAt: hospital.lastSyncedAt, feedStale: !!hospital.feedStale, message,
  };
}

async function board(hospitalId, window) {
  const w = windowOf(window);
  const ctx = await loadContext([hospitalId]);
  const hospital = ctx.hospitals[0];
  if (!hospital) return [];
  const drugIds = new Set([...ctx.lots.map(l => l.drug_ID), ...ctx.bookings.map(b => b.drug_ID)]);
  return [...drugIds].map(id => ctx.drugs[id]).filter(Boolean).filter(d => d.criticalFlag !== false)
    .map(d => row(ctx, hospital, d, coverFor(ctx, hospital, d.ID, w)))
    .sort((a, b) => STATUS_ORDER[a.status] - STATUS_ORDER[b.status] || Number(b.belowMargin) - Number(a.belowMargin) || b.shortfall - a.shortfall || a.genericName.localeCompare(b.genericName));
}

async function shortfallCard(hospitalId, drugId, window) {
  const w = windowOf(window);
  const ctx = await loadContext([hospitalId]);
  const hospital = ctx.hospitals[0];
  const drug = ctx.drugs[drugId];
  if (!hospital || !drug) return null;
  const c = coverFor(ctx, hospital, drugId, w);
  // preferred brand = brand the hospital holds most of for this drug
  const byBrand = {};
  for (const l of ctx.lots.filter(l => l.hospital_ID === hospitalId && l.drug_ID === drugId)) byBrand[l.brandName] = (byBrand[l.brandName] || 0) + Number(l.quantity);
  const preferredBrand = Object.entries(byBrand).sort((a, b) => b[1] - a[1])[0]?.[0] || null;
  return {
    cover: row(ctx, hospital, drug, c),
    affected: c.affected.map(a => ({ bookingId: a.bookingId, patientRefShort: String(a.patientRef || '').slice(0, 10), scheduledDate: a.scheduledDate, doseUnits: a.doseUnits, uncoveredUnits: a.uncoveredUnits, intent: a.intent, curative: a.curative })),
    prefill: { drugId, genericName: drug.genericName, strength: drug.strength, dosageForm: drug.dosageForm, qty: c.shortfall, neededBy: c.firstAffectedDate, allowBrandSwitch: false, preferredBrand },
  };
}

async function nearExpiry(hospitalId, days) {
  const d = Number(days) || config.nearExpiryDays;
  const ctx = await loadContext([hospitalId]);
  const hospital = ctx.hospitals[0];
  if (!hospital) return [];
  return ctx.lots
    .filter(l => isUsable(l, today(), ctx.isFlagged) && daysBetween(today(), l.expiryDate) <= d)
    .map(l => {
      const drug = ctx.drugs[l.drug_ID];
      const surplus = maxGivable({ lots: ctx.lots.filter(x => x.hospital_ID === hospitalId && x.drug_ID === l.drug_ID), bookings: ctx.bookings.filter(b => b.hospital_ID === hospitalId && b.drug_ID === l.drug_ID), today: today(), windowDays: hospital.coverWindowDays || config.coverWindowDays, safetyMarginPct: hospital.safetyMarginPct, isFlagged: ctx.isFlagged, lotId: l.ID });
      return { lotId: l.ID, drugId: l.drug_ID, genericName: drug?.genericName, strength: drug?.strength, brandName: l.brandName, batchNo: l.batchNo, quantity: l.quantity, expiryDate: toDay(l.expiryDate), daysToExpiry: daysBetween(today(), l.expiryDate), surplus };
    })
    .sort((a, b) => a.daysToExpiry - b.daysToExpiry);
}

/** Aggregated, anonymised: counts only, no hospital names or patient data (FR-28). */
async function cityView(window) {
  const w = windowOf(window);
  const ctx = await loadContext();
  const agg = {};
  for (const h of ctx.hospitals.filter(x => x.connected)) { // a disconnected hospital's frozen stock is not city supply
    const drugIds = new Set([...ctx.lots.filter(l => l.hospital_ID === h.ID).map(l => l.drug_ID), ...ctx.bookings.filter(b => b.hospital_ID === h.ID).map(b => b.drug_ID)]);
    for (const id of drugIds) {
      const d = ctx.drugs[id]; if (!d) continue;
      const c = coverFor(ctx, h, id, w);
      const a = agg[id] ||= { drugId: id, genericName: d.genericName, strength: d.strength, hospitalsShort: 0, dosesShort: 0, dosesBooked: 0, citySurplus: 0, earliestNeed: null };
      a.dosesBooked += c.booked; a.citySurplus += c.surplus;
      if (c.shortfall > 0) { a.hospitalsShort++; a.dosesShort += c.shortfall; if (!a.earliestNeed || c.firstAffectedDate < a.earliestNeed) a.earliestNeed = c.firstAffectedDate; }
    }
  }
  return Object.values(agg).sort((a, b) => b.dosesShort - a.dosesShort || a.genericName.localeCompare(b.genericName));
}

/**
 * Recompute cover snapshots and return rows that newly turned RED (for alerts).
 * Called by the scheduled job and after every ingest.
 */
async function recompute(hospitalIds) {
  const ctx = await loadContext(hospitalIds);
  const newlyRed = [];
  const now = new Date().toISOString();
  for (const h of ctx.hospitals) {
    const w = h.coverWindowDays || config.coverWindowDays;
    const drugIds = new Set([...ctx.lots.filter(l => l.hospital_ID === h.ID).map(l => l.drug_ID), ...ctx.bookings.filter(b => b.hospital_ID === h.ID).map(b => b.drug_ID)]);
    for (const id of drugIds) {
      if (!ctx.drugs[id]) continue;
      const c = coverFor(ctx, h, id, w);
      const key = { hospital_ID: h.ID, drug_ID: id, windowDays: w };
      const prev = await SELECT.one.from('medilink.CoverSnapshots').where(key);
      const data = { booked: c.booked, covered: c.covered, shortfall: c.shortfall, status: c.status, computedAt: now };
      if (prev) await UPDATE('medilink.CoverSnapshots').set(data).where(key);
      else await INSERT.into('medilink.CoverSnapshots').entries({ ...key, ...data });
      if (c.status === 'RED' && prev?.status !== 'RED') newlyRed.push({ hospital: h, drug: ctx.drugs[id], cover: c });
    }
  }
  return newlyRed;
}

/** One CoverRow for a hospital/drug, optionally after subtracting stock (post-transfer view). */
async function rowFor(hospitalId, drugId, removals = {}, window) {
  const ctx = await loadContext([hospitalId]);
  const h = ctx.hospitals[0], d = ctx.drugs[drugId];
  const c = coverFor(ctx, h, drugId, windowOf(window || h.coverWindowDays), removals);
  return { row: row(ctx, h, d, c), cover: c };
}

/** Stock already promised by open transfers that have not been picked up yet: { lotId: qty }. */
async function reservations({ excludeTransfer, includePendingSupplier = true } = {}) {
  const statuses = ['PENDING_APPROVAL', 'PENDING_SECOND_APPROVAL', 'APPROVED', 'ASSIGNED'];
  if (includePendingSupplier) statuses.push('PENDING_SUPPLIER');
  const ts = await SELECT.from('medilink.Transfers').columns('ID').where({ status: { in: statuses } });
  const ids = ts.map(t => t.ID).filter(id => id !== excludeTransfer);
  if (!ids.length) return {};
  const tl = await SELECT.from('medilink.TransferLots').where({ transfer_ID: { in: ids } });
  const out = {};
  for (const l of tl) out[l.lot_ID] = (out[l.lot_ID] || 0) + Number(l.qty);
  return out;
}

module.exports = { rowFor, reservations, board, shortfallCard, nearExpiry, cityView, recompute, loadContext, coverFor, flagChecker, drugsById, loadFlags, today, windowOf };
