'use strict';
/*
 * GET /admin/metrics: PRD section 3 success metrics, computed from what MediLink already records.
 *   alert lead time         shortfall alert -> first affected booking (Notifications.dueDate)      target >= 7 days
 *   request -> acceptance   transfer created -> supplier accepted (loan recorded)                   target median < 2 h
 *   flagged lots moved      picked-up lots that matched a flag known before pickup                   target 0
 *   trace completeness      arrivals whose temperature trace had no gaps                            target 100 %
 *   onboarding time         licence first checked -> first consent granted                          target < 2 min
 */
const { matchFlag } = require('./rules');

const median = xs => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b), m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const round = (n, d = 1) => (n === null ? null : Math.round(n * 10 ** d) / 10 ** d);
const ms = v => new Date(v).getTime();
// numeric goal per metric for drawing it (dir: min = at least, max = at most)
const GOALS = { alertLeadTimeDays: { value: 7, dir: 'min' }, requestToAcceptanceMin: { value: 120, dir: 'max' }, flaggedLotsMoved: { value: 0, dir: 'max' }, traceCompletenessPct: { value: 100, dir: 'min' }, onboardingTimeSec: { value: 120, dir: 'max' } };
const metric = (id, label, value, unit, target, met, count, text) => ({ id, label, value, unit, target, goal: GOALS[id], met, count, text });

async function compute() {
  const out = [];

  const alerts = (await SELECT.from('medilink.Notifications').columns('createdAt', 'dueDate').where({ kind: 'SHORTFALL' })).filter(a => a.dueDate && a.createdAt);
  const lead = alerts.map(a => (Date.parse(String(a.dueDate).slice(0, 10)) - Date.parse(String(a.createdAt).slice(0, 10))) / 86400000);
  const leadMed = median(lead);
  out.push(metric('alertLeadTimeDays', 'Lead time from shortfall alert to first affected booking', round(leadMed), 'days', '>= 7 days for scheduled drugs', leadMed === null ? null : leadMed >= 7, lead.length,
    lead.length ? `Median ${round(leadMed)} days over ${lead.length} alerts (shortest ${round(Math.min(...lead))}).` : 'No shortfall alerts yet.'));

  const loans = await SELECT.from('medilink.Ledger').columns('transfer_ID', 'createdAt');
  const ts = loans.length ? await SELECT.from('medilink.Transfers').columns('ID', 'createdAt').where({ ID: { in: loans.map(l => l.transfer_ID) } }) : [];
  const created = Object.fromEntries(ts.map(x => [x.ID, x.createdAt]));
  const accept = loans.filter(l => created[l.transfer_ID] && l.createdAt).map(l => (ms(l.createdAt) - ms(created[l.transfer_ID])) / 60000).filter(m => m >= 0);
  const accMed = median(accept);
  out.push(metric('requestToAcceptanceMin', 'Request to supplier acceptance', round(accMed), 'minutes', 'median under 120 minutes', accMed === null ? null : accMed < 120, accept.length,
    accept.length ? `Median ${round(accMed)} minutes over ${accept.length} accepted transfers.` : 'No accepted transfers yet.'));

  const moved = await SELECT.from('medilink.Transfers').columns('ID', 'pickedUpAt').where({ status: { in: ['IN_TRANSIT', 'DELIVERED', 'QUARANTINED'] } });
  let flaggedMoved = 0;
  if (moved.length) {
    const [tls, flags, drugs] = await Promise.all([SELECT.from('medilink.TransferLots').where({ transfer_ID: { in: moved.map(m => m.ID) } }), SELECT.from('medilink.Flags'), SELECT.from('medilink.Drugs')]);
    const lots = tls.length ? Object.fromEntries((await SELECT.from('medilink.Lots').where({ ID: { in: [...new Set(tls.map(x => x.lot_ID))] } })).map(l => [l.ID, l])) : {};
    const drug = Object.fromEntries(drugs.map(d => [d.ID, d]));
    for (const m of moved) {
      const known = flags.filter(f => f.active !== false && (!m.pickedUpAt || String(f.createdAt || f.date || '') <= String(m.pickedUpAt)));
      if (tls.some(x => x.transfer_ID === m.ID && lots[x.lot_ID] && matchFlag(lots[x.lot_ID], drug[lots[x.lot_ID].drug_ID], known))) flaggedMoved++;
    }
  }
  out.push(metric('flaggedLotsMoved', 'Flagged, expired or unlicensed lots moved', flaggedMoved, 'transfers', '0', flaggedMoved === 0, moved.length,
    flaggedMoved ? `${flaggedMoved} picked-up transfer(s) carried a lot that was already flagged.` : `None of ${moved.length} picked-up transfers carried a flagged lot.`));

  const arrived = (await SELECT.from('medilink.Transfers').columns('proofDetail').where({ status: { in: ['DELIVERED', 'QUARANTINED'] } })).filter(x => x.proofDetail);
  const complete = arrived.filter(x => { try { return JSON.parse(x.proofDetail).checks?.traceComplete; } catch { return false; } }).length;
  const pct = arrived.length ? (complete / arrived.length) * 100 : null;
  out.push(metric('traceCompletenessPct', 'Deliveries with a complete temperature trace', round(pct), '%', '100 %', pct === null ? null : pct === 100, arrived.length,
    arrived.length ? `${complete} of ${arrived.length} arrivals had a complete trace.` : 'No arrivals yet.'));

  const hs = await SELECT.from('medilink.Hospitals').columns('ID', 'licenceCheckedAt').where({ licenceCheckedAt: { '!=': null } });
  const consents = hs.length ? await SELECT.from('medilink.Consents').columns('hospital_ID', 'grantedAt').where({ hospital_ID: { in: hs.map(h => h.ID) } }) : [];
  const onboard = hs.map(h => {
    const first = consents.filter(c => c.hospital_ID === h.ID && c.grantedAt && ms(c.grantedAt) >= ms(h.licenceCheckedAt)).map(c => ms(c.grantedAt)).sort((a, b) => a - b)[0];
    return first ? (first - ms(h.licenceCheckedAt)) / 1000 : null;
  }).filter(x => x !== null);
  const obMed = median(onboard);
  out.push(metric('onboardingTimeSec', 'Pharmacist onboarding time (licence to connected)', round(obMed, 0), 'seconds', 'under 120 seconds', obMed === null ? null : obMed < 120, onboard.length,
    onboard.length ? `Median ${round(obMed, 0)} seconds over ${onboard.length} onboardings.` : 'No live onboardings yet.'));

  return { generatedAt: new Date().toISOString(), synthetic: true, metrics: out };
}

module.exports = { compute };
