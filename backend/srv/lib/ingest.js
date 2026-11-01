'use strict';
// Normalised snapshot ingestion used by every source: connector (/ingest), MediSoft, SAP sandbox, sheet upload.
const cds = require('@sap/cds');
const crypto = require('crypto');
const audit = require('./audit');
const coverdb = require('./coverdb');
const monitor = require('./monitor');
const { notify, sendDigest } = require('./notify');
const LOG = cds.log('ingest');

const HASHED = /^[a-f0-9]{64}$/;
const STORAGE = { AMBIENT: 'AMBIENT', ROOM: 'AMBIENT', RT: 'AMBIENT', COLD: 'COLD', FRIDGE: 'COLD', '2-8': 'COLD', '2-8C': 'COLD', FROZEN: 'FROZEN', FREEZER: 'FROZEN' };
const norm = s => String(s ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');

class IngestError extends Error {
  constructor(status, code, message) { super(message); this.status = status; this.code = code; }
}

function resolveDrug(item, drugs) {
  if (item.drugId && drugs[item.drugId]) return drugs[item.drugId];
  const g = norm(item.generic || item.genericName), s = norm(item.strength), f = norm(item.form || item.dosageForm);
  return Object.values(drugs).find(d => norm(d.genericName) === g && norm(d.strength) === s && (!f || norm(d.dosageForm) === f)) || null;
}

function parseDate(v) {
  if (!v) return null;
  const s = String(v).trim();
  let m;
  if ((m = s.match(/^(\d{4})-(\d{2})-(\d{2})/))) return `${m[1]}-${m[2]}-${m[3]}`;
  if ((m = s.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/))) return `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`; // DD/MM/YYYY (India)
  if ((m = s.match(/^(\d{1,2})[/.-](\d{4})$/))) { // MM/YYYY -> last day of month
    const d = new Date(Date.UTC(Number(m[2]), Number(m[1]), 0)); return d.toISOString().slice(0, 10);
  }
  return null;
}
const parseBool = v => (typeof v === 'boolean' ? v : /^(y|yes|true|1|sealed|intact)$/i.test(String(v ?? '').trim()));
const storageOf = (v, drug) => STORAGE[String(v ?? '').toUpperCase().replace(/\s|°/g, '')] || drug?.storageClass || 'AMBIENT';

/**
 * One row per lot ID (F6): a feed may list a lot more than once (one row per bin, a batch written twice on a sheet).
 * Rows of the same lot are summed (earliest expiry wins); an opened part keeps its own row so the sealed part stays usable.
 */
function mergeLots(lots) {
  const groups = new Map();
  for (const l of lots) {
    const k = `${l.ID}|${l.sealed}`;
    const g = groups.get(k);
    if (!g) groups.set(k, { ...l });
    else { g.quantity += l.quantity; if (l.expiryDate < g.expiryDate) g.expiryDate = l.expiryDate; }
  }
  const out = [...groups.values()];
  const sealed = new Set(out.filter(l => l.sealed).map(l => l.ID));
  return out.map(l => (!l.sealed && sealed.has(l.ID) ? { ...l, ID: `${l.ID}-opened` } : l));
}

/**
 * Replace the hospital's snapshot for `source`.
 * payload = { lots?: [...], bookings?: [...] }  (bookings omitted => bookings untouched)
 * merge: true = only the lots in the payload are replaced, the source's other lots stay (a photo of one register page, F13).
 */
async function ingestSnapshot(hospitalId, source, payload, { actor = 'system:' + source.toLowerCase(), merge = false } = {}) {
  const hospital = await SELECT.one.from('medilink.Hospitals').where({ ID: hospitalId });
  if (!hospital) throw new IngestError(404, 'HOSPITAL_UNKNOWN', `Unknown hospital ${hospitalId}`);
  const drugs = await coverdb.drugsById();
  const now = new Date().toISOString();
  let skipped = 0;

  // Privacy gate: refuse any un-hashed patient reference outright.
  for (const b of payload.bookings || []) {
    if (!HASHED.test(String(b.patientRef || ''))) throw new IngestError(422, 'PATIENT_REF_NOT_HASHED', 'Every booking patientRef must be a SHA-256 hex digest hashed at source; nothing was stored');
  }

  let lots = [];
  for (const it of payload.lots || []) {
    const drug = resolveDrug(it, drugs);
    const qty = Number(it.quantity ?? it.qty);
    const expiry = parseDate(it.expiryDate ?? it.expiry);
    if (!drug || !expiry || !(qty >= 0) || !it.batchNo && !it.batch) { skipped++; continue; }
    const batchNo = String(it.batchNo ?? it.batch);
    const ref = it.lotRef || crypto.createHash('sha1').update(`${drug.ID}|${batchNo}|${it.manufacturer ?? ''}`).digest('hex').slice(0, 12);
    lots.push({
      ID: String(ref).startsWith(hospitalId + '-') ? String(ref) : `${hospitalId}-${ref}`,
      hospital_ID: hospitalId, drug_ID: drug.ID, brandName: it.brandName ?? it.brand ?? null, manufacturer: it.manufacturer ?? it.mfr ?? null,
      batchNo, quantity: qty, expiryDate: expiry, storageClass: storageOf(it.storageClass ?? it.storage, drug), sealed: parseBool(it.sealed ?? true),
      source, lastSynced: now,
    });
  }

  lots = mergeLots(lots);

  const bookings = [];
  for (const b of payload.bookings || []) {
    const drug = resolveDrug(b, drugs);
    const date = parseDate(b.scheduledDate ?? b.date);
    if (!drug || !date || !(Number(b.doseUnits ?? b.units) > 0)) { skipped++; continue; }
    bookings.push({ ID: `${hospitalId}:${b.bookingId ?? b.appointmentId}`, hospital_ID: hospitalId, patientRef: b.patientRef, drug_ID: drug.ID, doseUnits: Number(b.doseUnits ?? b.units), scheduledDate: date, intent: String(b.intent || 'CURATIVE').toUpperCase(), source });
  }

  // Keep MediLink-side quarantine decisions across syncs
  const existing = await SELECT.from('medilink.Lots').columns('ID', 'quarantined').where({ hospital_ID: hospitalId, source });
  const quarantined = new Set(existing.filter(l => l.quarantined).map(l => l.ID));
  if (payload.lots && (!merge || lots.length)) {
    await DELETE.from('medilink.Lots').where({ hospital_ID: hospitalId, source, ...(merge ? { ID: { in: lots.map(l => l.ID) } } : {}) });
    if (lots.length) await INSERT.into('medilink.Lots').entries(lots.map(l => ({ ...l, quarantined: quarantined.has(l.ID) })));
    if (source !== 'TRANSFER') await require('./receipt').reconcileReceived(hospitalId, lots); // received stock now in this feed: count it once
  }
  if (payload.bookings) {
    await DELETE.from('medilink.Bookings').where({ hospital_ID: hospitalId, source });
    // de-duplicate by ID (last one wins)
    const uniq = Object.values(Object.fromEntries(bookings.map(b => [b.ID, b])));
    if (uniq.length) await INSERT.into('medilink.Bookings').entries(uniq);
  }
  await UPDATE('medilink.Hospitals').set({ lastSyncedAt: now, feedStale: false, connected: true }).where({ ID: hospitalId });
  await audit.log(actor, 'INGEST', { hospital: hospitalId, source, lots: payload.lots ? lots.length : null, bookings: payload.bookings ? bookings.length : null, skipped });
  const digest = []; // a sheet upload or connector push alerts at once: one email for its shortfalls, low stock and expiry
  await recomputeAndAlert([hospitalId], digest);
  // the stock update must not fail because of alerting (e.g. a parallel check raised the same alert a moment earlier)
  await monitor.run([hospitalId], digest).catch(e => LOG.warn(`stock and expiry check failed for ${hospitalId}: ${e.message}`));
  await sendDigest(digest);
  return { hospitalId, source, lots: lots.length, bookings: bookings.length, skipped };
}

async function recomputeAndAlert(hospitalIds, digest) {
  const red = await coverdb.recompute(hospitalIds);
  for (const r of red) {
    await notify({ hospital: r.hospital.ID, kind: 'SHORTFALL', severity: 'HIGH', ref: r.drug.ID, dueDate: r.cover.firstAffectedDate,
      message: `${r.drug.genericName} ${r.drug.strength}: ${r.cover.shortfall} of ${r.cover.booked} booked doses cannot be covered in the next ${r.cover.windowDays} days (${r.cover.patientsAffected} patients affected first, from ${r.cover.firstAffectedDate})` }, { digest });
  }
  return red;
}

module.exports = { ingestSnapshot, recomputeAndAlert, mergeLots, resolveDrug, parseDate, parseBool, storageOf, IngestError, HASHED };
