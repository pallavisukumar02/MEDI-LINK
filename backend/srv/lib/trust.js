'use strict';
// Trust feed (FR-15): LLM-parsed CDSCO alert PDFs -> Flag rows (behind a flag), plus manual flag / recall.
const cds = require('@sap/cds');
const config = require('./config');
const llm = require('./llm');
const audit = require('./audit');
const ws = require('./ws');
const { notify } = require('./notify');
const { matchFlag } = require('./rules');
const err = (status, code, message) => Object.assign(new Error(`${code}: ${message}`), { status, code });
const REASONS = { SPURIOUS: 'SPURIOUS', NSQ: 'NSQ', 'NOT OF STANDARD QUALITY': 'NSQ', RECALL: 'RECALL', ADULTERATED: 'SPURIOUS', MISBRANDED: 'NSQ' };

async function pdfText(base64) {
  let pdfParse;
  try { pdfParse = require('pdf-parse/lib/pdf-parse.js'); } catch { throw err(501, 'PDF_PARSER_MISSING', 'pdf-parse is not installed; send the alert as text'); }
  const r = await pdfParse(Buffer.from(base64, 'base64'));
  return r.text;
}

async function parseAlert({ pdfBase64, text, source }, actor) {
  if (!config.trustFeedLlmEnabled || !llm.enabled()) throw err(409, 'LLM_DISABLED', 'LLM trust-feed parsing is disabled (LLM_PROVIDER=none or TRUST_FEED_LLM_ENABLED=false); add flags with the manual recall endpoint');
  const body = text || (pdfBase64 ? await pdfText(pdfBase64) : '');
  if (!body.trim()) throw err(400, 'EMPTY_ALERT', 'No alert text');
  const drugs = await SELECT.from('medilink.Drugs');
  const reply = await llm.chat([
    { role: 'system', content: 'You extract drug quality alerts into JSON. Output a JSON array only. Never invent rows.' },
    { role: 'user', content: `Extract each listed drug as {"genericName","strength","batchNo","manufacturer","reason"} where reason is one of SPURIOUS, NSQ, RECALL.\nAlert text:\n${body.slice(0, 12000)}` },
  ]);
  const rows = llm.extractJson(reply);
  if (!Array.isArray(rows)) throw err(502, 'LLM_UNPARSEABLE', 'LLM reply was not a JSON array');
  const created = [], dropped = [];
  const norm = s => String(s ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');
  const haystack = norm(body);
  for (const r of rows) {
    if (!r.batchNo && !r.manufacturer) continue;
    // Guard against hallucination: the batch (or, if no batch, the manufacturer) must appear verbatim in the alert.
    const anchor = r.batchNo || r.manufacturer;
    if (!haystack.includes(norm(anchor))) { dropped.push(anchor); continue; }
    const reason = REASONS[String(r.reason || '').toUpperCase()] || 'NSQ';
    const drug = drugs.find(d => norm(d.genericName) === norm(r.genericName) && (!r.strength || norm(r.strength).startsWith(norm(d.strength).slice(0, 5)))) || drugs.find(d => norm(d.genericName) === norm(r.genericName));
    const f = { ID: cds.utils.uuid(), batchNo: r.batchNo || null, manufacturer: r.manufacturer || null, drug_ID: drug?.ID || null, genericName: r.genericName || null, reason, source: `${source || 'CDSCO drug alert'} (LLM-parsed; review)`, date: new Date().toISOString().slice(0, 10), active: true, synthetic: false };
    await INSERT.into('medilink.Flags').entries(f);
    created.push(f);
    await quarantineMatching(f, actor);
  }
  await audit.log(actor, 'FLAGS_IMPORTED', { source: source || 'CDSCO', count: created.length, dropped, flags: created.map(f => ({ batchNo: f.batchNo, manufacturer: f.manufacturer, reason: f.reason })) });
  return { created: created.length, flags: JSON.stringify(created), llm: config.llmProvider === 'aicore' ? 'aicore' : 'injected' };
}

/** Quarantine lots matching a flag; cancel not-yet-picked-up transfers that carry them; alert in-transit ones. */
async function quarantineMatching(flag, actor) {
  const drugs = Object.fromEntries((await SELECT.from('medilink.Drugs')).map(d => [d.ID, d]));
  const lots = (await SELECT.from('medilink.Lots')).filter(l => matchFlag(l, drugs[l.drug_ID], [flag]));
  let transfersCancelled = 0, inTransitAlerts = 0;
  for (const l of lots) {
    await UPDATE('medilink.Lots').set({ quarantined: true }).where({ ID: l.ID });
    await notify({ hospital: l.hospital_ID, kind: 'RECALL', severity: 'HIGH', ref: l.ID, message: `Lot ${l.batchNo} (${drugs[l.drug_ID]?.genericName}) is flagged ${flag.reason}; quarantined in MediLink` });
  }
  const lotIds = lots.map(l => l.ID);
  if (lotIds.length) {
    const tls = await SELECT.from('medilink.TransferLots').where({ lot_ID: { in: lotIds } });
    const ts = tls.length ? await SELECT.from('medilink.Transfers').where({ ID: { in: [...new Set(tls.map(x => x.transfer_ID))] } }) : [];
    for (const t of ts) {
      if (['PENDING_SUPPLIER', 'PENDING_APPROVAL', 'PENDING_SECOND_APPROVAL', 'APPROVED', 'ASSIGNED'].includes(t.status)) {
        await UPDATE('medilink.Transfers').set({ status: 'CANCELLED', declineReason: 'Lot flagged: ' + flag.reason }).where({ ID: t.ID });
        await UPDATE('medilink.Ledger').set({ status: 'CANCELLED' }).where({ transfer_ID: t.ID, status: 'OPEN' });
        await audit.log(actor, 'TRANSFER_CANCELLED', { transfer: t.ID, reason: 'FLAGGED_LOT' });
        transfersCancelled++;
      } else if (t.status === 'IN_TRANSIT') {
        await UPDATE('medilink.Transfers').set({ quarantineSuggested: true }).where({ ID: t.ID });
        for (const h of [t.supplier_ID, t.receiver_ID]) await notify({ hospital: h, kind: 'RECALL', severity: 'HIGH', ref: t.ID, message: 'A lot on this in-transit shipment was just flagged; quarantine on arrival' });
        ws.emit('status', { transferId: t.ID, status: t.status, message: 'Lot flagged in transit: quarantine on arrival' });
        inTransitAlerts++;
      }
    }
  }
  return { lotsQuarantined: lots.length, transfersCancelled, inTransitAlerts };
}

async function recall({ batchNo, manufacturer, drug, reason, source }, actor) {
  if (!batchNo && !manufacturer) throw err(400, 'FLAG_TARGET_REQUIRED', 'batchNo or manufacturer is required');
  const r = String(reason || 'RECALL').toUpperCase();
  if (!['SPURIOUS', 'NSQ', 'RECALL'].includes(r)) throw err(400, 'INVALID_REASON', 'reason must be SPURIOUS, NSQ or RECALL');
  const f = { ID: cds.utils.uuid(), batchNo: batchNo || null, manufacturer: manufacturer || null, drug_ID: drug || null, reason: r, source: source || 'Manual entry', date: new Date().toISOString().slice(0, 10), active: true, synthetic: false };
  await INSERT.into('medilink.Flags').entries(f);
  await audit.log(actor, 'FLAG_ADDED', { flag: f.ID, batchNo, manufacturer, drug, reason: r, source: f.source });
  const res = await quarantineMatching(f, actor);
  return { flagId: f.ID, ...res };
}

module.exports = { parseAlert, recall, quarantineMatching };
