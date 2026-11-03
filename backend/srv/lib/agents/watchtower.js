'use strict';
/*
 * Logistics watchtower (Agentic AI step 5). The thresholds stay fixed rules in delivery.js (temperature range per
 * storage class, broken seal, Open-Meteo rain >= WEATHER_CLOSE_MM_PER_H, no open road, ETA after needed-by).
 * When one fires, the watchtower works out the options and writes a proposal for the receiving pharmacist:
 *   EXCURSION       -> HOLD_FOR_QA: keep sealed, hold for QA on arrival; with a drafted incident report
 *   no open road    -> REROUTE_CHECK: wait at a safe place, re-check the route (approve = re-plan now);
 *                      names a free backup carrier certified for the medicine, when there is one
 *   ETA too late    -> LATE_DELIVERY: tell the ward, or find a nearer lender
 * Nothing changes until a person approves (actions approve-proposal / reject-proposal). Never throws: a watchtower
 * problem must not block telemetry or re-routing.
 */
const cds = require('@sap/cds');
const llm = require('../llm');
const audit = require('../audit');
const ws = require('../ws');
const runner = require('./runner');
const { partnerCanCarry, licenceValid } = require('../rules');
const { shortName, drugLabel } = require('./tools');
const LOG = cds.log('agents');

async function propose({ kind, hospitalId, transferId, title, detail, report = null, actionId = null, body = null, mode = 'rules' }) {
  const dedupeKey = `${kind}:${transferId}`;
  const open = await SELECT.one.from('medilink.AgentProposals').columns('ID').where({ dedupeKey, status: 'PENDING' });
  if (open) return null; // one open proposal per problem
  const row = { ID: cds.utils.uuid(), agent: 'watchtower', hospital_ID: hospitalId, kind, title: title.slice(0, 200), detail: detail.slice(0, 2000), report: report && report.slice(0, 2000), actionId, body: body ? JSON.stringify(body) : null, ref: transferId, dedupeKey, status: 'PENDING', createdAt: new Date().toISOString() };
  await INSERT.into('medilink.AgentProposals').entries(row);
  await audit.log('agent:watchtower', 'AGENT_PROPOSED', { proposal: row.ID, kind, transfer: transferId, hospital: hospitalId, actionId });
  await runner.record({ agent: 'watchtower', hospitalId, actor: 'agent:watchtower', mode, input: `${kind} on transfer ${transferId}`, output: { proposal: row.ID, kind }, steps: 1 });
  ws.emit('alert', { hospitalId, kind: 'AGENT', severity: 'HIGH', message: title, ref: transferId });
  return row;
}

async function facts(t) {
  const [drug, from, to, partner] = await Promise.all([
    SELECT.one.from('medilink.Drugs').where({ ID: t.drug_ID }), SELECT.one.from('medilink.Hospitals').where({ ID: t.supplier_ID }),
    SELECT.one.from('medilink.Hospitals').where({ ID: t.receiver_ID }), t.partner_ID ? SELECT.one.from('medilink.DeliveryPartners').where({ ID: t.partner_ID }) : null,
  ]);
  return { drug, from, to, partner, name: drugLabel(drug), fromName: shortName(from?.name), toName: shortName(to?.name) };
}

/** Free, licensed partner certified for this medicine, other than the one carrying it now (nearest to the supplier). */
async function backupCarrier(t, drug, from) {
  const today = new Date().toISOString().slice(0, 10);
  const [partners, lic, busy] = await Promise.all([
    SELECT.from('medilink.DeliveryPartners'), SELECT.from('medilink.Licences').where({ partyType: 'PARTNER' }),
    SELECT.from('medilink.Transfers').columns('partner_ID').where({ status: { in: ['ASSIGNED', 'IN_TRANSIT'] } }),
  ]);
  const lm = Object.fromEntries(lic.map(l => [l.partyId, l]));
  const free = partners.filter(p => p.ID !== t.partner_ID && p.active !== false && partnerCanCarry(p, drug.storageClass) && licenceValid(lm[p.ID]?.validTill, today) && !busy.some(b => b.partner_ID === p.ID));
  const km = p => Math.hypot(Number(p.lat) - Number(from.lat), Number(p.long) - Number(from.long));
  return free.sort((a, b) => km(a) - km(b))[0] || null;
}

function incidentTemplate(f, t, { temperatureC, range, sealBroken, at }) {
  const what = sealBroken ? 'the seal was reported broken' : `the logger read ${temperatureC} °C, outside the ${range} °C range for this medicine`;
  return `Incident report (draft). Shipment of ${f.name}, ${t.qty} vials, from ${f.fromName} to ${f.toName}${f.partner ? `, carried by ${f.partner.name}` : ''}. `
    + `At ${new Date(at || Date.now()).toISOString().slice(11, 16)} UTC ${what}. Proposed handling: keep the box sealed, hold the stock for a quality check on arrival `
    + 'and do not give it to patients until the check clears it. Supplier and receiver were alerted.';
}

/** A temperature excursion or broken seal (delivery.telemetry). */
async function onExcursion(transferId, info = {}) {
  if (!runner.enabled()) return null;
  try {
    const t = await SELECT.one.from('medilink.Transfers').where({ ID: transferId });
    if (!t) return null;
    const f = await facts(t);
    let report = incidentTemplate(f, t, info), mode = 'rules';
    if (llm.enabled()) { // reword only; thrown away if a number or batch changes (same guard as transfer notes)
      const reply = await llm.safeChat([
        { role: 'system', content: 'You tidy pharmacy incident reports. Keep every number, unit and name exactly as given. Do not add facts. Reply with the report only.' },
        { role: 'user', content: report },
      ], { maxTokens: 300 });
      if (reply && require('../notes').factsPreserved(report, reply.trim())) { report = reply.trim(); mode = 'llm'; }
    }
    const backup = await backupCarrier(t, f.drug, f.from);
    return await propose({
      kind: 'HOLD_FOR_QA', hospitalId: t.receiver_ID, transferId,
      title: `Hold ${f.name} from ${f.fromName} for a quality check`,
      detail: `${info.sealBroken ? 'The seal was reported broken' : `The temperature went to ${info.temperatureC} °C (allowed ${info.range} °C)`} on the way. `
        + `Options: 1) hold it for a quality check on arrival (recommended); 2) accept and inspect at once; 3) ask another hospital for a fresh supply${backup ? `, ${backup.name} is free to carry it` : ''}. `
        + 'Approve to file the incident report and tell both pharmacies.',
      report, mode,
    });
  } catch (e) { LOG.warn('watchtower (excursion) skipped:', e.message); return null; }
}

/** After every re-plan (road closed, flood, manual report): no open road or a late arrival needs a person. */
async function onReplan(transferId, r) {
  if (!runner.enabled()) return null;
  try {
    const t = await SELECT.one.from('medilink.Transfers').where({ ID: transferId });
    if (!t || !['ASSIGNED', 'IN_TRANSIT'].includes(t.status)) return null;
    const f = await facts(t);
    if (!r.open) {
      const backup = await backupCarrier(t, f.drug, f.from);
      return await propose({
        kind: 'REROUTE_CHECK', hospitalId: t.receiver_ID, transferId, actionId: 'agent-recheck-route', body: { transferId },
        title: `No open road for ${f.name} from ${f.fromName}`,
        detail: `Every road MediLink knows is closed on the way to ${f.toName}. The courier waits at a safe place. `
          + `Options: 1) re-check the route now (approve) once roads reopen; 2) ${backup ? `hand over to ${backup.name}, a free certified carrier` : 'no other certified carrier is free right now'}; 3) ask a nearer hospital.`,
      });
    }
    if (/misses the needed-by date/.test(r.note || '')) {
      return await propose({
        kind: 'LATE_DELIVERY', hospitalId: t.receiver_ID, transferId,
        title: `${f.name} from ${f.fromName} will arrive after it is needed`,
        detail: `The new route takes about ${r.etaMin} minutes, which misses the needed-by date. Options: 1) tell the ward and move the dose; 2) ask a nearer hospital for part of it. Approve to record your decision and tell both pharmacies.`,
      });
    }
    return null;
  } catch (e) { LOG.warn('watchtower (route) skipped:', e.message); return null; }
}

module.exports = { onExcursion, onReplan, propose, backupCarrier, incidentTemplate };
