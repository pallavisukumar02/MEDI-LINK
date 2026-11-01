'use strict';
/*
 * Scheduled-demand cover and surplus (PRD section 9, FR-11).
 *
 *   Shortfall = booked doses in window - sealed, in-date stock expiring after each dose date
 *   Surplus   = stock - own booked demand in window - safety margin
 *
 * Interpretation choices (documented in README):
 *  - Window = [today, today + windowDays), i.e. 14 days = today plus the next 13 days.
 *  - Usable stock = lots that are sealed, not quarantined, not flagged, quantity > 0 and expiry > today.
 *  - A lot can serve a dose only if lot.expiryDate > dose.scheduledDate (strictly after).
 *  - Allocation is earliest-expiry-first over bookings in date order, which maximises covered doses
 *    for this "deadline" structure, so the shortfall is exact, not a heuristic.
 *  - Safety margin = ceil(demand * pct / 100), i.e. a buffer on booked demand.
 */

const toDay = d => (typeof d === 'string' ? d.slice(0, 10) : new Date(d).toISOString().slice(0, 10));
const addDays = (day, n) => new Date(Date.parse(toDay(day) + 'T00:00:00Z') + n * 86400000).toISOString().slice(0, 10);
const daysBetween = (a, b) => Math.round((Date.parse(toDay(b)) - Date.parse(toDay(a))) / 86400000);

function isUsable(lot, today, isFlagged = () => false) {
  return !!lot.sealed && !lot.quarantined && Number(lot.quantity) > 0 && toDay(lot.expiryDate) > toDay(today) && !isFlagged(lot);
}

function bookingsInWindow(bookings, today, windowDays) {
  const start = toDay(today), end = addDays(today, windowDays);
  return bookings
    .filter(b => toDay(b.scheduledDate) >= start && toDay(b.scheduledDate) < end && Number(b.doseUnits) > 0)
    .sort((a, b) => toDay(a.scheduledDate).localeCompare(toDay(b.scheduledDate)) || String(a.ID).localeCompare(String(b.ID)));
}

/**
 * @param {object} p
 * @param {Array} p.lots       lots of ONE hospital and ONE drug
 * @param {Array} p.bookings   bookings of the same hospital and drug
 * @param {string} p.today     YYYY-MM-DD
 * @param {number} p.windowDays 7 | 14 | 21
 * @param {number} p.safetyMarginPct
 * @param {Function} [p.isFlagged] lot => boolean
 * @param {object} [p.removals] { lotId: qty } stock to subtract first (post-transfer view)
 */
function computeCover({ lots, bookings, today, windowDays = 14, safetyMarginPct = 20, isFlagged, removals = {} }) {
  const usable = lots
    .filter(l => isUsable(l, today, isFlagged))
    .map(l => ({ ID: l.ID, expiryDate: toDay(l.expiryDate), remaining: Math.max(0, Number(l.quantity) - Number(removals[l.ID] || 0)) }))
    .sort((a, b) => a.expiryDate.localeCompare(b.expiryDate) || String(a.ID).localeCompare(String(b.ID)));
  const usableStock = usable.reduce((s, l) => s + l.remaining, 0);
  const window = bookingsInWindow(bookings, today, windowDays);

  let booked = 0, covered = 0;
  const affected = [];
  for (const b of window) {
    const need = Number(b.doseUnits);
    booked += need;
    let got = 0;
    for (const l of usable) {
      if (got >= need) break;
      if (l.remaining <= 0 || l.expiryDate <= toDay(b.scheduledDate)) continue;
      const take = Math.min(l.remaining, need - got);
      l.remaining -= take; got += take;
    }
    covered += got;
    if (got < need) affected.push({ bookingId: b.ID, patientRef: b.patientRef, scheduledDate: toDay(b.scheduledDate), doseUnits: need, uncoveredUnits: need - got, intent: b.intent, curative: b.intent === 'CURATIVE' });
  }
  const shortfall = booked - covered;
  const margin = Math.ceil(booked * Number(safetyMarginPct) / 100);
  const surplus = shortfall > 0 ? 0 : Math.max(0, usableStock - booked - margin);
  // PRD board semantics: RED = booked doses cannot be covered; GREEN = covered.
  // Being below the safety margin is reported separately (belowMargin) and only limits what can be given away.
  let status = 'GREEN';
  if (shortfall > 0) status = 'RED';
  else if (booked === 0 && usableStock === 0) status = 'NONE';
  const belowMargin = shortfall === 0 && usableStock - booked < margin;
  const patientsAffected = new Set(affected.map(a => a.patientRef || a.bookingId)).size;
  return {
    windowDays, booked, covered, shortfall, usableStock, margin, surplus, status, belowMargin,
    coverPct: booked ? Math.round((covered / booked) * 1000) / 10 : 100,
    affected, patientsAffected,
    firstAffectedDate: affected.length ? affected[0].scheduledDate : null,
  };
}

/**
 * Largest quantity that can be taken from `lotId` while the hospital's own bookings stay fully covered
 * and the safety margin is kept (rule 1, per lot). Monotone in q, so binary search.
 */
function maxGivable({ lots, bookings, today, windowDays = 14, safetyMarginPct = 20, isFlagged, lotId, alreadyRemoved = {} }) {
  const lot = lots.find(l => l.ID === lotId);
  if (!lot || !isUsable(lot, today, isFlagged)) return 0;
  const ok = q => {
    const removals = { ...alreadyRemoved, [lotId]: Number(alreadyRemoved[lotId] || 0) + q };
    const c = computeCover({ lots, bookings, today, windowDays, safetyMarginPct, isFlagged, removals });
    return c.shortfall === 0 && (c.usableStock - c.booked) >= c.margin;
  };
  const avail = Number(lot.quantity) - Number(alreadyRemoved[lotId] || 0);
  if (avail <= 0 || !ok(0)) return 0;
  let lo = 0, hi = avail;
  while (lo < hi) { const mid = Math.ceil((lo + hi) / 2); if (ok(mid)) lo = mid; else hi = mid - 1; }
  return lo;
}

/** Status ordering for the board: red first. */
const STATUS_ORDER = { RED: 0, GREEN: 1, NONE: 2 };

module.exports = { computeCover, maxGivable, isUsable, bookingsInWindow, toDay, addDays, daysBetween, STATUS_ORDER };
