'use strict';
// Arrival scan, proof of condition, coverage update (FR-25).
const cds = require('@sap/cds');
const config = require('./config');
const audit = require('./audit');
const ws = require('./ws');
const { recomputeAndAlert } = require('./ingest');
const coverdb = require('./coverdb');

const T = 'medilink.Transfers';
const err = (status, code, message) => Object.assign(new Error(`${code}: ${message}`), { status, code });
const maxGapMin = () => Number(process.env.TRACE_MAX_GAP_MIN || Math.max(15, (Number(process.env.SIM_TELEMETRY_INTERVAL_SEC || 5) * 3) / 60));

/** Proof of condition: seal intact, batch matches, no excursion, complete temperature trace (GPS-only fixes don't count). */
function proofOfCondition({ transfer, lots, logs, batchNo, sealIntact, arrivedAt = new Date() }) {
  const scanned = String(batchNo || '').split(/[,\s]+/).filter(Boolean).map(s => s.toUpperCase());
  const readings = logs.filter(l => l.temperatureC !== null && l.temperatureC !== undefined);
  const times = readings.map(l => new Date(l.loggedAt).getTime()).sort((a, b) => a - b);
  const gapLimit = maxGapMin() * 60000;
  const points = [new Date(transfer.pickedUpAt).getTime(), ...times, arrivedAt.getTime()];
  let maxGap = 0; for (let i = 1; i < points.length; i++) maxGap = Math.max(maxGap, points[i] - points[i - 1]);
  const checks = {
    sealIntact: !!sealIntact && !logs.some(l => l.sealStatus === 'BROKEN'),
    batchMatches: lots.every(l => scanned.includes(String(l.batchNo).toUpperCase())),
    noExcursion: !transfer.excursion && !logs.some(l => l.excursion),
    traceComplete: readings.length > 0 && maxGap <= gapLimit,
    sealIdRecorded: !!transfer.sealId,
  };
  const pass = Object.values(checks).every(Boolean);
  const temps = readings.map(l => Number(l.temperatureC));
  return { pass, checks, readings: readings.length, minC: temps.length ? Math.min(...temps) : null, maxC: temps.length ? Math.max(...temps) : null, maxGapMin: Math.round(maxGap / 600) / 100 };
}

async function arrivalScan(id, { batchNo, sealIntact, qtyReceived, decision }, actor, userHospital) {
  const t = await SELECT.one.from(T).where({ ID: id });
  if (!t) throw err(404, 'TRANSFER_NOT_FOUND', id);
  if (userHospital && t.receiver_ID !== userHospital) throw err(403, 'NOT_RECEIVER', 'Only the receiving hospital can scan this arrival');
  if (t.status !== 'IN_TRANSIT') throw err(409, 'INVALID_STATUS', `Transfer is ${t.status}; expected IN_TRANSIT`);
  decision = String(decision || 'ACCEPT').toUpperCase();
  if (!['ACCEPT', 'QUARANTINE'].includes(decision)) throw err(400, 'INVALID_DECISION', 'decision must be ACCEPT or QUARANTINE');
  const qty = qtyReceived === undefined || qtyReceived === null ? Number(t.qty) : Number(qtyReceived);
  if (!(qty >= 0) || qty > t.qty) throw err(400, 'INVALID_QUANTITY', `Quantity received must be 0..${t.qty}`);

  const lots = await SELECT.from('medilink.TransferLots').where({ transfer_ID: id });
  const logs = await SELECT.from('medilink.ConditionLogs').where({ transfer_ID: id }).orderBy('loggedAt');
  const poc = proofOfCondition({ transfer: t, lots, logs, batchNo, sealIntact });
  if (decision === 'ACCEPT' && !poc.pass) throw err(409, 'PROOF_OF_CONDITION_FAILED', `Cannot accept into usable stock: ${Object.entries(poc.checks).filter(([, v]) => !v).map(([k]) => k).join(', ')} failed. Quarantine instead.`);

  const status = decision === 'ACCEPT' ? 'DELIVERED' : 'QUARANTINED';
  const deliveredAt = new Date().toISOString();
  if (!await UPDATE(T).set({ status, deliveredAt, qtyReceived: qty, proofOfCondition: poc.pass ? 'PASS' : 'FAIL', proofDetail: JSON.stringify(poc) }).where({ ID: id, status: 'IN_TRANSIT' })) throw err(409, 'INVALID_STATUS', 'Transfer is no longer IN_TRANSIT'); // a double scan books stock once
  // Receiver lots carry the full batch passport; split received quantity across transfer lots in order.
  let left = qty; const newLotIds = [];
  for (const l of lots) {
    const take = Math.min(left, Number(l.qty)); left -= take;
    if (take <= 0) continue;
    const src = await SELECT.one.from('medilink.Lots').where({ ID: l.lot_ID });
    const lotId = `${t.receiver_ID}-RX-${id.slice(0, 8)}-${newLotIds.length + 1}`;
    await INSERT.into('medilink.Lots').entries({ ID: lotId, hospital_ID: t.receiver_ID, drug_ID: src.drug_ID, brandName: src.brandName, manufacturer: src.manufacturer, batchNo: src.batchNo, quantity: take, expiryDate: src.expiryDate, storageClass: src.storageClass, sealed: true, quarantined: decision === 'QUARANTINE', source: 'TRANSFER', lastSynced: new Date().toISOString() });
    newLotIds.push(lotId);
  }
  await require('./courier').closeAfterDelivery(id, deliveredAt);
  if (qty !== Number(t.qty)) {
    const loan = await SELECT.one.from('medilink.Ledger').where({ transfer_ID: id });
    if (loan) await UPDATE('medilink.Ledger').set({ qty, landedCost: Math.round(Number(loan.landedCost) / Number(loan.qty || 1) * qty * 100) / 100 }).where({ ID: loan.ID });
  }
  if (t.request_ID) {
    const all = await SELECT.from(T).where({ request_ID: t.request_ID, status: 'DELIVERED' });
    const req = await SELECT.one.from('medilink.Requests').where({ ID: t.request_ID });
    const delivered = all.reduce((s, x) => s + Number(x.qtyReceived ?? x.qty), 0);
    if (req && delivered >= req.qty) await UPDATE('medilink.Requests').set({ status: 'FULFILLED' }).where({ ID: t.request_ID });
  }
  await audit.log(actor, 'ARRIVAL', { transfer: id, decision, qtyReceived: qty, proofOfCondition: poc.pass ? 'PASS' : 'FAIL', checks: poc.checks, readings: poc.readings, lots: newLotIds });
  await recomputeAndAlert([t.receiver_ID]);
  const row = await coverdb.rowFor(t.receiver_ID, t.drug_ID);
  ws.emit('status', { transferId: id, status, message: `Arrived: proof of condition ${poc.pass ? 'PASS' : 'FAIL'}` });
  return { transferId: id, status, proofOfCondition: poc.pass ? 'PASS' : 'FAIL', checks: JSON.stringify(poc), lotIds: JSON.stringify(newLotIds), coverStatus: row.row.status, message: row.row.message };
}

/**
 * Received stock is booked as source TRANSFER until the receiver's own system reports it. On each new snapshot a TRANSFER
 * lot is dropped once the snapshot lists the same drug + batch with at least the quantity received: the hospital system
 * has booked it in, and counting both would double it. Quarantined TRANSFER lots stay (they are not usable stock anyway).
 * shortcut: no MediLink reference reaches the hospital's system, so if the receiver already held that batch in at least
 * that quantity the TRANSFER lot goes early (stock reads low until the receipt is booked there; never double). Likewise the
 * supplier's pickup decrement is replaced by its next system figure. A transfer reference in the feed would make this exact.
 */
async function reconcileReceived(hospitalId, lots) {
  const received = await SELECT.from('medilink.Lots').where({ hospital_ID: hospitalId, source: 'TRANSFER', quarantined: false });
  if (!received.length) return [];
  const key = l => `${l.drug_ID}|${String(l.batchNo).toUpperCase()}`;
  const sum = rows => { const m = {}; for (const l of rows) m[key(l)] = (m[key(l)] || 0) + Number(l.quantity); return m; };
  const reported = sum(lots), transferred = sum(received);
  const done = received.filter(l => reported[key(l)] >= transferred[key(l)]).map(l => l.ID);
  if (done.length) {
    await DELETE.from('medilink.Lots').where({ ID: { in: done } });
    await audit.log('system:reconcile', 'TRANSFER_STOCK_RECONCILED', { hospital: hospitalId, lots: done });
  }
  return done;
}

module.exports = { arrivalScan, proofOfCondition, reconcileReceived };
