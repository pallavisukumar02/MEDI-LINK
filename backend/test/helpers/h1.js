'use strict';
// Loads H1's synthetic MediSoft stock + bookings through the normal ingest path (what the Allow flow would pull),
// so tests can raise requests for H1 without running the OAuth popup.
const cds = require('@sap/cds');
const gen = require('../../../seed/generate');

module.exports = async function ingestH1() {
  const data = gen.build(gen.anchorDate());
  const salt = process.env.PATIENT_REF_HASH_SALT || 'test-salt';
  const lots = data.lots.H1.map(l => ({ lotRef: l.ID, drugId: l.drug_ID, brandName: l.brandName, manufacturer: l.manufacturer, batchNo: l.batchNo, quantity: l.quantity, expiryDate: l.expiryDate, storageClass: l.storageClass, sealed: l.sealed }));
  const bookings = data.bookings.H1.map(b => ({ bookingId: b.srcId, patientRef: gen.hashRef(salt, b.mrn), drugId: b.drug_ID, doseUnits: b.doseUnits, scheduledDate: b.scheduledDate, intent: b.intent }));
  const { ingestSnapshot } = require('../../srv/lib/ingest');
  return cds.tx(() => ingestSnapshot('H1', 'MEDISOFT', { lots, bookings }, { actor: 'test:h1-seed' }));
};
