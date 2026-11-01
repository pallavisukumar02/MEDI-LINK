'use strict';
/*
 * "What needs me now": the home screen (GET /me/home), the onboarding checklist (GET /me/onboarding) and the
 * plain-language city view (GET /me/city). Everything is derived from existing state and filtered to the
 * user's role and hospital. Task cards come from journeys, so a card and its journey never disagree.
 */
const config = require('./config');
const coverdb = require('./coverdb');
const journey = require('./journey');
const llm = require('./llm');
const monitor = require('./monitor');
const { t } = require('./messages');
const { matchFlag } = require('./rules');
const { action, field } = require('./actions');

const today = () => new Date().toISOString().slice(0, 10);
const daysUntil = d => Math.round((Date.parse(String(d).slice(0, 10)) - Date.parse(today())) / 86400000);
const URGENCY = { high: 0, medium: 1, low: 2 };
// within a severity: what can hurt a patient today comes first
const ALERT_ORDER = { EXCURSION: 0, RECALL: 1, SHORTFALL: 2, LICENCE_EXPIRY: 3, STALE_FEED: 4, BELOW_MARGIN: 5, EXPIRED: 6, OUT_OF_STOCK: 7, EXPIRING: 8, LOW_STOCK: 9 };

function ago(ts) {
  const min = Math.max(0, Math.round((Date.now() - new Date(ts).getTime()) / 60000));
  if (min < 1) return t('home.ago.now');
  if (min < 60) return t('home.ago.minutes', { n: min });
  if (min < 48 * 60) return t('home.ago.hours', { n: Math.round(min / 60) });
  return t('home.ago.days', { n: Math.round(min / 1440) });
}

async function hospitalAndLicence(id) {
  const h = await SELECT.one.from('medilink.Hospitals').where({ ID: id });
  const lic = h && await SELECT.one.from('medilink.Licences').where({ partyId: id, partyType: 'HOSPITAL' });
  return { h, validTill: lic?.validTill || h?.licenceValidTill };
}
function licenceState(validTill) {
  const left = validTill ? daysUntil(validTill) : -1;
  const status = left < 0 ? 'expired' : left <= config.licenceReminderDays ? 'expiring' : 'valid';
  return { status, validTill, text: t(`home.licence.${status}`, { date: journey.fmtDateLong(validTill) }) };
}

// ---------------------------------------------------------------- onboarding checklist
const SOFTWARE = ['MEDISOFT', 'SAP_SANDBOX', 'CONNECTOR', 'SHEET', 'IT'];
function fallbacks() {
  const out = [
    action('pick-software', { style: 'secondary', fields: [field('software', 'choice', { options: SOFTWARE.map(v => ({ value: v, label: t(`software.${v}`) })) }), { ...field('itContact', 'text'), required: false }] }),
    action('ask-it-team', { style: 'secondary', fields: [field('itContact', 'text')] }),
    action('upload-sheet', { style: 'secondary', fields: [field('csv', 'file', { accept: '.csv,text/csv' })] }),
  ];
  const photo = action('upload-photo', { style: 'secondary', fields: [field('imageBase64', 'file', { label: 'image', accept: 'image/*' })] });
  if (!llm.enabled()) Object.assign(photo, { available: false, unavailableReason: t('error.LLM_DISABLED.message') });
  out.push(photo);
  return out;
}

async function onboarding(viewer) {
  if (!viewer.hospitalId || viewer.role !== 'pharmacist') return null;
  const { h, validTill } = await hospitalAndLicence(viewer.hospitalId);
  if (!h) return null;
  const checked = !!(h.licenceCheckedAt || h.connected);
  const expired = !validTill || daysUntil(validTill) < 0;
  const synced = !!(h.connected && h.lastSyncedAt);
  const software = t(`software.${h.software || 'NONE'}`);
  const steps = [
    { id: 'licence', done: checked, detail: t('onboarding.detail.licence') },
    { id: 'checked', done: checked && !expired, blocked: checked && expired, detail: expired ? t('onboarding.detail.expired', { date: journey.fmtDateLong(validTill) }) : t('onboarding.detail.checked', { hospital: h.name, date: String(validTill).slice(0, 4) }) },
    { id: 'connect', done: !!h.connected, detail: t(`onboarding.detail.connect.${h.software || 'NONE'}`, { software }) },
    { id: 'sync', done: synced, detail: synced ? t('onboarding.detail.synced', { ago: ago(h.lastSyncedAt) }) : t('onboarding.detail.sync') },
  ];
  steps.push({ id: 'ready', done: steps.every(s => s.done), detail: t('onboarding.detail.ready') });
  const current = steps.find(s => !s.done);
  const out = steps.map(s => ({ id: s.id, label: t(`onboarding.step.${s.id}`), status: s.done ? 'done' : s.blocked ? 'blocked' : s === current ? 'current' : 'todo', detail: s.detail }));
  let nextAction = null, fb = [];
  if (current?.id === 'licence') nextAction = action('enter-licence', { fields: [field('licenceNo', 'text', { placeholder: 'KA-BLR-20B-1001' })] });
  if (current?.id === 'connect') {
    const sw = h.software || 'NONE';
    nextAction = sw === 'SHEET' ? fallbacks().find(a => a.id === 'upload-sheet')
      : sw === 'CONNECTOR' ? action('ask-it-team', { fields: [{ ...field('itContact', 'text'), required: false }] })
        : sw === 'NONE' ? fallbacks()[0] : action('allow-access');
    nextAction.style = 'primary';
    fb = fallbacks().filter(a => a.id !== nextAction.id);
  }
  return {
    done: !current, current: current?.id || null, steps: out, nextAction, fallbacks: fb,
    message: !current ? t('onboarding.done') : current.blocked ? t('error.LICENCE_EXPIRED.fix') : current.detail,
    error: current?.blocked ? require('./messages').error('LICENCE_EXPIRED', { licenceNo: h.licenceNo, validTill: journey.fmtDateLong(validTill) }) : undefined,
  };
}

// ---------------------------------------------------------------- tasks
function taskOf(j, viewer) {
  const primary = j.actions.find(a => a.style === 'primary');
  if (!primary) return null;
  const secondary = j.actions.find(a => a !== primary && a.style === 'secondary' && a.id !== 'report-road-closed') || null;
  const p = { qty: j.qty, drug: j.drug.name, other: j.counterpart, date: journey.fmtDate(j.neededBy) };
  const card = (kind, urgency, dueBy, extra = {}) => ({
    id: `${j.id}:${kind}`, kind, journeyId: j.id, title: t(`task.${kind}.title`, { ...p, ...extra }), subtitle: t(extra.subtitleKey || `task.${kind}.subtitle`, { ...p, ...extra }),
    urgency, dueBy: dueBy || null, colour: j.colour, primaryAction: primary, secondaryAction: secondary,
  });
  const soon = j.neededBy && daysUntil(j.neededBy) <= 3 ? 'high' : 'medium';
  switch (j.key) {
    case 'shortfall': return card('send_request', soon, j.neededBy, { patients: j.patientsAffected });
    case 'choose_supplier': return card('choose_plan', 'high', j.neededBy, j.planHint || {});
    case 'no_match': case 'recalled': return card('find_again', 'medium', j.neededBy);
    case 'waiting_supplier': return j.perspective === 'supplier' ? card('accept_request', 'high', j.respondBy, j.supplierShort ? { subtitleKey: 'task.accept_request.subtitle_short' } : {}) : null;
    case 'waiting_approval': case 'waiting_second_approval': {
      if (j.perspective !== 'supplier') return null;
      const risks = (j.risks || []).map(r => t(`risk.${r}`)).join(', ');
      return card('approve', 'high', j.neededBy, { risks: j.key === 'waiting_second_approval' ? t('task.approve.second', { risks }) : risks ? `Check: ${risks}.` : '' });
    }
    case 'arrived': return j.perspective === 'receiver' ? card('arrival', 'high', null) : null;
    case 'excursion': return j.perspective === 'receiver' && j.stage === 6 ? card('arrival', 'high', null, { subtitleKey: 'task.arrival.subtitle_excursion' }) : null;
    case 'done': return j.loan?.status === 'OPEN' && j.perspective === 'receiver' && primary.id === 'mark-loan-paid' ? card('repay', 'low', null, { amount: j.loan.amount.toLocaleString('en-IN') }) : null;
    default: return null;
  }
}

// ---------------------------------------------------------------- alerts
async function hospitalAlerts(h, validTill, board, viewer) {
  const out = [];
  for (const r of board.filter(r => r.status === 'RED')) {
    out.push({ kind: 'SHORTFALL', severity: 'red', drugId: r.drugId, message: t('alert.shortfall', { drug: `${r.genericName} ${String(r.strength).split('/')[0]}`, short: r.shortfall, booked: r.booked, date: journey.fmtDate(r.firstAffectedDate) }) });
  }
  const lic = licenceState(validTill);
  if (lic.status !== 'valid') out.push({ kind: 'LICENCE_EXPIRY', severity: lic.status === 'expired' ? 'red' : 'amber', message: t(`alert.licence_${lic.status}`, { date: journey.fmtDateLong(validTill) }) });
  if (h.feedStale) out.push({ kind: 'STALE_FEED', severity: 'amber', message: t('alert.stale', { hospital: journey.shortName(h) }) });
  // flagged batches sitting in this hospital's stock
  const ctx = await coverdb.loadContext([h.ID]);
  const seen = new Set();
  for (const l of ctx.lots) {
    const m = Number(l.quantity) > 0 && matchFlag(l, ctx.drugs[l.drug_ID], ctx.flags);
    if (!m || seen.has(l.batchNo)) continue;
    seen.add(l.batchNo);
    out.push({ kind: 'RECALL', severity: 'red', drugId: l.drug_ID, message: t('alert.recall', { batch: l.batchNo, drug: journey.drugName(ctx.drugs[l.drug_ID]), reason: t(`reason.${m.flag.reason}`) }) });
  }
  for (const r of board.filter(r => r.status === 'GREEN' && r.belowMargin)) {
    out.push({ kind: 'BELOW_MARGIN', severity: 'amber', drugId: r.drugId, message: t('alert.below_margin', { drug: `${r.genericName} ${String(r.strength).split('/')[0]}` }) });
  }
  out.push(...await monitor.homeAlerts(h.ID)); // low stock and expiry, until resolved or acknowledged
  return out;
}

function coverSummary(board, windowDays) {
  const c = { red: 0, amber: 0, green: 0 };
  for (const r of board) {
    if (r.status === 'RED') c.red++;
    else if (r.status === 'GREEN' && r.belowMargin) c.amber++;
    else if (r.status === 'GREEN') c.green++;
  }
  return { ...c, windowDays, text: t('cover.summary', c), emptyText: c.red === 0 ? t('empty.cover', { days: windowDays }) : null };
}

// ---------------------------------------------------------------- home
async function home(viewer) {
  const res = { user: { id: viewer.userId, role: viewer.role }, greeting: t(`home.greeting.${viewer.role}`) || '', hospital: null, onboarding: null, alerts: [], tasks: [], journeys: [], coverSummary: null, empty: {} };
  res.stockSummary = null; // { out, low, expiring, expired, text, emptyText } for hospital users
  let board = [];
  if (viewer.hospitalId) {
    const { h, validTill } = await hospitalAndLicence(viewer.hospitalId);
    if (h) {
      const window = h.coverWindowDays || config.coverWindowDays;
      board = await coverdb.board(h.ID, window);
      const conn = !h.connected ? 'disconnected' : h.feedStale ? 'stale' : h.lastSyncedAt ? 'connected' : 'never';
      res.hospital = {
        id: h.ID, name: h.name, licence: licenceState(validTill),
        connection: { status: conn, connected: !!h.connected, lastSyncedAt: h.lastSyncedAt || null, text: t(`home.connection.${conn}`, { ago: h.lastSyncedAt ? ago(h.lastSyncedAt) : '' }) },
      };
      res.coverSummary = coverSummary(board, window);
      res.stockSummary = await monitor.summary(h.ID);
      res.alerts.push(...await hospitalAlerts(h, validTill, board, viewer));
      const ob = await onboarding(viewer);
      if (ob && !ob.done) {
        res.onboarding = { current: ob.current, step: ob.steps.find(s => s.status === 'current' || s.status === 'blocked')?.label, message: ob.message, nextAction: ob.nextAction };
        if (ob.nextAction) res.tasks.push({ id: 'onboarding', kind: 'connect', journeyId: null, title: t('task.connect.title'), subtitle: t('task.connect.subtitle', { step: ob.message }), urgency: 'medium', dueBy: null, colour: 'amber', primaryAction: ob.nextAction, secondaryAction: ob.fallbacks[0] || null });
        if (!h.connected && ob.nextAction) res.hospital.connection.action = ob.nextAction;
      }
    }
  }
  if (viewer.role === 'admin') {
    const hs = await SELECT.from('medilink.Hospitals');
    for (const h of hs.filter(x => x.feedStale)) res.alerts.push({ kind: 'STALE_FEED', severity: 'amber', message: t('alert.stale', { hospital: journey.shortName(h) }) });
  }

  const journeys = await journey.forViewer(viewer);
  if (viewer.role === 'pharmacist') {
    const live = j => j.perspective === 'receiver' && !['cancelled', 'done', 'quarantined'].includes(j.key);
    for (const r of board.filter(r => r.status === 'RED')) {
      if (!journeys.some(j => live(j) && j.drug.id === r.drugId)) journeys.unshift(journey.shortfallJourney(r, viewer));
    }
  }
  for (const j of journeys) {
    if (j.key === 'excursion') res.alerts.push({ kind: 'EXCURSION', severity: 'red', journeyId: j.id, drugId: j.drug.id, message: t('alert.excursion', { drug: j.drug.name }) });
    const card = taskOf(j, viewer);
    if (card) res.tasks.push(card);
  }
  res.journeys = journeys;
  res.alerts.sort((a, b) => (a.severity === 'red' ? 0 : 1) - (b.severity === 'red' ? 0 : 1) || ALERT_ORDER[a.kind] - ALERT_ORDER[b.kind]);
  res.tasks.sort((a, b) => URGENCY[a.urgency] - URGENCY[b.urgency] || String(a.dueBy || '9').localeCompare(String(b.dueBy || '9')));
  if (!res.tasks.length) res.empty.tasks = t('empty.tasks');
  if (!res.alerts.length) res.empty.alerts = t('empty.alerts');
  if (!res.journeys.length) res.empty.journeys = t('empty.journeys');
  return res;
}

// ---------------------------------------------------------------- city view (aggregated, anonymised)
async function city() {
  const rows = await coverdb.cityView(config.coverWindowDays);
  const out = rows.map(r => ({ drugId: r.drugId, drug: `${r.genericName} ${String(r.strength).split('/')[0]}`, hospitalsShort: r.hospitalsShort, dosesShort: r.dosesShort, dosesBooked: r.dosesBooked, citySurplus: r.citySurplus, earliestNeed: r.earliestNeed,
    text: t('city.row', { drug: `${r.genericName} ${String(r.strength).split('/')[0]}`, hospitals: r.hospitalsShort, short: r.dosesShort, surplus: r.citySurplus }) }));
  return { windowDays: config.coverWindowDays, rows: out, emptyText: out.some(r => r.dosesShort > 0) ? null : t('city.empty') };
}

module.exports = { home, onboarding, city, taskOf, ago };
