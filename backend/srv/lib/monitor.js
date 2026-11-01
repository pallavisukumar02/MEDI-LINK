'use strict';
/*
 * Stock and expiry monitoring: "this item is getting expired / the stock is low".
 *   OUT_OF_STOCK / LOW_STOCK  usable units (cover.isUsable: sealed, not quarantined, in date, not flagged) are 0 / at or
 *                             below the reorder level: StockThresholds (hospital + drug), else Drugs.reorderLevel; neither = not watched
 *   EXPIRING                  a usable lot inside an EXPIRY_ALERT_DAYS tier (default 90,60,30,7); only the tightest tier reached
 *   EXPIRED                   a lot at or past its expiry date with units left that is not quarantined yet
 * Each condition is one open Notifications row (dedupeKey) while it lasts: it alerts once, alerts again only when it gets
 * worse (LOW -> OUT, tier 30 -> 7) or comes back after it cleared, and resolves itself when it is gone (reconcile).
 * Runs after every ingest and in the scheduled sync cycle; the new alerts of one run go out as one digest per hospital.
 * Also the experience views GET /me/stock and GET /me/notifications and their actions (ack-alert, set-reorder-level).
 */
const config = require('./config');
const coverdb = require('./coverdb');
const audit = require('./audit');
const notify = require('./notify');
const { isUsable, maxGivable, toDay, daysBetween } = require('./cover');
const { drugName, fmtDateLong } = require('./journey');
const { t } = require('./messages');
const { action, field } = require('./actions');

const N = 'medilink.Notifications';
const KINDS = ['OUT_OF_STOCK', 'LOW_STOCK', 'EXPIRED', 'EXPIRING'];
const SEVERITY = { HIGH: 3, MEDIUM: 2, LOW: 1 };
const STATUS_ORDER = { out: 0, low: 1, ok: 2, untracked: 3 };
const SETTERS = ['pharmacist', 'approver', 'admin'];
const MAX_LEVEL = 100000;
const err = (status, code, params) => Object.assign(new Error(code), { status, code, params });

const expiryTiers = () => [...new Set(String(config.expiryAlertDays).split(',').map(Number).filter(n => Number.isInteger(n) && n > 0))].sort((a, b) => b - a);
/** The tightest tier (in days) that `daysLeft` has reached, or null. `tiers` widest first. */
const tierOf = (daysLeft, tiers = expiryTiers()) => tiers.filter(x => daysLeft <= x).pop() ?? null;
const lotSeverity = tier => (tier <= 7 ? 'HIGH' : tier <= 30 ? 'MEDIUM' : 'LOW'); // tier 0 = expired
// how bad a condition is, compared within one dedupeKey: OUT > LOW; a tighter expiry or licence tier > a wider one; 0 = expired
const rank = c => (c.kind === 'OUT_OF_STOCK' ? 2 : c.kind === 'LOW_STOCK' ? 1 : -(c.tier ?? 0));
const vials = n => t(n === 1 ? 'home.stock.vial' : 'home.stock.vials', { n });
const levelsOf = (rows, hospitalId) => Object.fromEntries(rows.filter(r => r.hospital_ID === hospitalId).map(r => [r.drug_ID, r.minUnits]));

/**
 * Stock and expiry state of one hospital, worst first. ctx = coverdb.loadContext.
 * levels = { drugId: minUnits } set for this hospital; watched = drug IDs with an open low-stock alert, so a drug whose
 * last lot vanished from the feed stays "out" instead of quietly dropping off the list.
 */
function assess(ctx, hospitalId, levels = {}, watched = [], today = coverdb.today()) {
  const lots = ctx.lots.filter(l => l.hospital_ID === hospitalId);
  const h = ctx.hospitals?.find(x => x.ID === hospitalId) || {};
  const tiers = expiryTiers();
  const rows = [];
  for (const id of new Set([...lots.map(l => l.drug_ID), ...Object.keys(levels), ...watched])) {
    const d = ctx.drugs[id];
    if (!d) continue;
    const mine = lots.filter(l => l.drug_ID === id);
    const usable = mine.filter(l => isUsable(l, today, ctx.isFlagged));
    const onHand = usable.reduce((s, l) => s + Number(l.quantity), 0);
    const threshold = levels[id] ?? d.reorderLevel ?? null;
    const status = threshold === null ? 'untracked' : onHand === 0 ? 'out' : onHand <= threshold ? 'low' : 'ok';
    const lotRows = [];
    for (const l of mine) {
      const daysLeft = daysBetween(today, l.expiryDate);
      const tier = usable.includes(l) ? tierOf(daysLeft, tiers) : Number(l.quantity) > 0 && !l.quarantined && daysLeft <= 0 ? 0 : null;
      if (tier === null) continue;
      const nearExpiry = tier > 0 && daysLeft <= config.nearExpiryDays;
      // spare = what can leave without uncovering the hospital's own bookings (same check as matching); only then suggest surplus
      const spare = nearExpiry ? maxGivable({ lots: mine, bookings: (ctx.bookings || []).filter(b => b.hospital_ID === hospitalId && b.drug_ID === id), today,
        windowDays: h.coverWindowDays || config.coverWindowDays, safetyMarginPct: h.safetyMarginPct ?? config.safetyMarginPct, isFlagged: ctx.isFlagged, lotId: l.ID }) : 0;
      lotRows.push({ lotId: l.ID, batchNo: l.batchNo, brandName: l.brandName, qty: Number(l.quantity), expiryDate: toDay(l.expiryDate), daysLeft, tier,
        status: tier === 0 ? 'expired' : 'expiring', nearExpiry, spare, severity: lotSeverity(tier) });
    }
    lotRows.sort((a, b) => a.daysLeft - b.daysLeft);
    const severity = [status === 'out' ? 'HIGH' : status === 'low' ? 'MEDIUM' : null, ...lotRows.map(l => l.severity)]
      .filter(Boolean).sort((a, b) => SEVERITY[b] - SEVERITY[a])[0] || null;
    rows.push({ drugId: id, drug: drugName(d), onHand, threshold, thresholdSource: threshold === null ? null : levels[id] !== undefined ? 'hospital' : 'default', status, severity, lots: lotRows });
  }
  const soonest = r => r.lots[0]?.daysLeft ?? Infinity;
  return rows.sort((a, b) => (SEVERITY[b.severity] || 0) - (SEVERITY[a.severity] || 0) || STATUS_ORDER[a.status] - STATUS_ORDER[b.status] || soonest(a) - soonest(b) || a.drug.localeCompare(b.drug));
}

/** The alert conditions in an assessment, one per dedupeKey. */
function conditions(hospitalId, rows) {
  const out = [];
  for (const r of rows) {
    if (r.status === 'out' || r.status === 'low') {
      out.push({ hospital: hospitalId, dedupeKey: `STOCK:${hospitalId}:${r.drugId}`, ref: r.drugId, kind: r.status === 'out' ? 'OUT_OF_STOCK' : 'LOW_STOCK',
        severity: r.status === 'out' ? 'HIGH' : 'MEDIUM', message: t(`alert.stock_${r.status}`, { drug: r.drug, onHand: r.onHand, level: r.threshold }) });
    }
    for (const l of r.lots) {
      const key = l.tier === 0 ? 'alert.lot_expired' : l.spare > 0 ? 'alert.lot_expiring_surplus' : 'alert.lot_expiring';
      out.push({ hospital: hospitalId, dedupeKey: `LOT:${hospitalId}:${l.lotId}`, ref: l.lotId, tier: l.tier, dueDate: l.expiryDate, kind: l.tier === 0 ? 'EXPIRED' : 'EXPIRING',
        severity: l.severity, message: t(key, { batch: l.batchNo, drug: r.drug, qty: vials(l.qty), date: fmtDateLong(l.expiryDate) }) });
    }
  }
  return out;
}

/**
 * Brings the open alerts (rows with a dedupeKey) in line with the conditions found now. A new condition, or one worse
 * than its open row, raises a new alert (the old row is resolved); same or better refreshes the open row quietly;
 * an open row whose condition is gone is resolved. Also used for licence reminders (sync.licenceWatch).
 */
async function reconcile(open, conds, digest) {
  const now = new Date().toISOString();
  const left = new Map(open.map(r => [r.dedupeKey, r]));
  const raised = [], resolved = [];
  const resolve = async r => { await UPDATE(N).set({ dedupeKey: null, resolvedAt: now }).where({ ID: r.ID }); resolved.push(r); };
  for (const c of conds) {
    const prev = left.get(c.dedupeKey);
    left.delete(c.dedupeKey);
    if (prev && rank(c) <= rank(prev)) {
      const set = { kind: c.kind, severity: c.severity, message: c.message, tier: c.tier ?? null, dueDate: c.dueDate || null };
      if (Object.keys(set).some(k => String(set[k] ?? '') !== String(prev[k] ?? ''))) await UPDATE(N).set(set).where({ ID: prev.ID });
      continue;
    }
    if (prev) await resolve(prev); // first, so the new row can take the dedupeKey
    raised.push(await notify.notify(c, { digest }));
  }
  for (const r of left.values()) await resolve(r);
  return { raised, resolved };
}

/**
 * Checks stock and expiry of these hospitals (default: every hospital that has sent stock) and alerts on what is new.
 * With `digest` the new rows are collected for the caller's digest; without, this run sends its own. Returns the new rows.
 */
async function run(hospitalIds, digest) {
  const own = !digest;
  digest ??= [];
  const ctx = await coverdb.loadContext(hospitalIds);
  const hs = ctx.hospitals.filter(h => h.lastSyncedAt); // never synced: no stock known yet, so nothing can be low
  const ids = hs.map(h => h.ID);
  const [levels, open] = ids.length ? await Promise.all([
    SELECT.from('medilink.StockThresholds').where({ hospital_ID: { in: ids } }),
    SELECT.from(N).where({ hospital_ID: { in: ids }, kind: { in: KINDS }, dedupeKey: { '!=': null } }),
  ]) : [[], []];
  const raised = [];
  for (const h of hs) {
    const mine = open.filter(r => r.hospital_ID === h.ID);
    const rows = assess(ctx, h.ID, levelsOf(levels, h.ID), mine.filter(r => r.dedupeKey.startsWith('STOCK:')).map(r => r.ref));
    const r = await reconcile(mine, conditions(h.ID, rows), digest);
    if (r.raised.length || r.resolved.length) await audit.log('system:stock-monitor', 'STOCK_ALERTS', { hospital: h.ID, raised: r.raised.map(x => x.dedupeKey), resolved: r.resolved.map(x => x.dedupeKey) });
    raised.push(...r.raised);
  }
  if (own) await notify.sendDigest(digest);
  return raised;
}

// ---------------------------------------------------------------- experience layer
/** The hospital a /me request acts for: own hospital; an admin must name one. */
async function hospitalFor(viewer, requested) {
  const want = requested ? String(requested).slice(0, 10) : null;
  if (viewer.role === 'admin') {
    if (!want) throw err(400, 'CHOOSE_HOSPITAL');
    if (!await SELECT.one.from('medilink.Hospitals').columns('ID').where({ ID: want })) throw err(404, 'NOT_FOUND');
    return want;
  }
  if (!viewer.hospitalId) throw err(403, 'NO_HOSPITAL');
  if (want && want !== viewer.hospitalId) throw err(403, 'FORBIDDEN_HOSPITAL');
  return viewer.hospitalId;
}

async function stateOf(hospitalId) {
  const [ctx, levels, open] = await Promise.all([
    coverdb.loadContext([hospitalId]),
    SELECT.from('medilink.StockThresholds').where({ hospital_ID: hospitalId }),
    SELECT.from(N).columns('ref').where({ hospital_ID: hospitalId, kind: { in: ['OUT_OF_STOCK', 'LOW_STOCK'] }, dedupeKey: { '!=': null } }),
  ]);
  return { hospital: ctx.hospitals[0], rows: ctx.hospitals[0] ? assess(ctx, hospitalId, levelsOf(levels, hospitalId), open.map(r => r.ref)) : [] };
}

function summaryOf(rows) {
  const c = { out: 0, low: 0, expiring: 0, expired: 0 };
  for (const r of rows) {
    if (r.status === 'out' || r.status === 'low') c[r.status]++;
    for (const l of r.lots) c[l.status]++;
  }
  return { ...c, text: t('home.stock.summary', c), emptyText: Object.values(c).some(Boolean) ? null : t('empty.stock') };
}

/** Compact counts for GET /me/home. */
async function summary(hospitalId) { return summaryOf((await stateOf(hospitalId)).rows); }

const inDays = n => t(n === 1 ? 'home.stock.in_day' : 'home.stock.in_days', { n });
function drugText(r) {
  if (r.status === 'untracked') return t('home.stock.untracked', { onHand: r.onHand });
  return t(`home.stock.${r.status}`, { onHand: r.onHand, level: r.threshold });
}
function lotText(l) {
  if (l.tier === 0) return t('home.stock.lot.expired', { date: fmtDateLong(l.expiryDate) });
  return t(l.spare > 0 ? 'home.stock.lot.expiring_surplus' : 'home.stock.lot.expiring', { when: inDays(l.daysLeft), date: fmtDateLong(l.expiryDate), spare: vials(l.spare) });
}
const ackAction = id => action('ack-alert', { style: 'secondary', body: { notificationId: id } });

/** GET /me/stock[?hospital=]: per drug on hand / reorder level / status, with its expiring and expired lots, worst first. */
async function stockView(viewer, requested) {
  const hospitalId = await hospitalFor(viewer, requested);
  const { hospital: h, rows } = await stateOf(hospitalId);
  const canSet = SETTERS.includes(viewer.role);
  const drugs = rows.map(r => ({
    ...r, text: drugText(r), lots: r.lots.map(l => ({ ...l, text: lotText(l) })),
    actions: canSet ? [action('set-reorder-level', {
      style: 'secondary', body: { drugId: r.drugId, ...(viewer.role === 'admin' ? { hospital: hospitalId } : {}) }, params: { drug: r.drug },
      fields: [field('minUnits', 'number', { min: 0, max: MAX_LEVEL, ...(r.threshold === null ? {} : { default: r.threshold }) })],
    })] : [],
  }));
  return { hospital: { id: h.ID, name: h.name }, summary: summaryOf(rows), drugs, emptyText: drugs.length ? null : t('empty.stock_none') };
}

/** Open stock and expiry alerts for the home screen (acknowledged ones are hidden). */
async function homeAlerts(hospitalId) {
  const rows = await SELECT.from(N).where({ hospital_ID: hospitalId, kind: { in: KINDS }, dedupeKey: { '!=': null }, ackedAt: null }).orderBy('dueDate', 'createdAt');
  return rows.map(n => ({ kind: n.kind, severity: n.severity === 'HIGH' ? 'red' : 'amber', [n.kind.endsWith('STOCK') ? 'drugId' : 'lotId']: n.ref, notificationId: n.ID, message: n.message, actions: [ackAction(n.ID)] }));
}

/** GET /me/notifications?status=open|all: the in-app inbox, own hospital only (admin: all), newest first. */
async function inbox(viewer, status) {
  const all = status === 'all';
  const where = viewer.role === 'admin' ? {} : { hospital_ID: viewer.hospitalId || '-' };
  if (!all) Object.assign(where, { resolvedAt: null, ackedAt: null });
  // shortcut: newest 200 rows only; add paging once an inbox holds more than that.
  const rows = await SELECT.from(N).where(where).orderBy('createdAt desc').limit(200);
  const me = await SELECT.one.from('medilink.Users').columns('email').where({ username: viewer.userId || '' });
  return {
    status: all ? 'all' : 'open',
    notifications: rows.map(n => {
      const open = !n.resolvedAt && !n.ackedAt;
      return { id: n.ID, hospitalId: n.hospital_ID, kind: n.kind, severity: n.severity, colour: n.severity === 'HIGH' ? 'red' : 'amber', message: n.message, ref: n.ref, tier: n.tier,
        dueDate: n.dueDate, createdAt: n.createdAt, open, resolvedAt: n.resolvedAt, ackedAt: n.ackedAt, ackedBy: n.ackedBy, actions: open ? [ackAction(n.ID)] : [] };
    }),
    alertEmail: SETTERS.includes(viewer.role) ? {
      email: me?.email || null, text: me?.email ? t('home.email.current', { email: me.email }) : t('home.email.none'),
      action: action('set-alert-email', { style: 'secondary', fields: [{ ...field('email', 'text', me?.email ? { default: me.email } : {}), required: false }] }),
    } : null,
    emptyText: rows.length ? null : t(all ? 'empty.inbox_all' : 'empty.inbox'),
  };
}

/** ack-alert: hides an alert from the home screen; it stays in the inbox. Own hospital only (admin: any). */
async function ack(viewer, id) {
  const n = await SELECT.one.from(N).where({ ID: id });
  const mine = n && (viewer.role === 'admin' || (viewer.hospitalId && n.hospital_ID === viewer.hospitalId));
  if (!mine) throw err(404, 'NOT_FOUND'); // also for another hospital's alert: do not reveal it exists
  if (!n.ackedAt) {
    await UPDATE(N).set({ ackedAt: new Date().toISOString(), ackedBy: viewer.userId, read: true }).where({ ID: id });
    await audit.log(viewer.userId, 'ALERT_ACKNOWLEDGED', { notification: id, hospital: n.hospital_ID, kind: n.kind });
  }
  return { message: t('home.stock.acked'), result: { notificationId: id } };
}

/** set-reorder-level: the hospital's own low-stock level for one drug, then an immediate re-check. */
async function setReorderLevel(viewer, { drugId, minUnits, hospital }) {
  const hospitalId = await hospitalFor(viewer, hospital);
  if (!Number.isInteger(minUnits) || minUnits < 0 || minUnits > MAX_LEVEL) throw err(400, 'INVALID_REORDER_LEVEL', { max: MAX_LEVEL });
  const drug = await SELECT.one.from('medilink.Drugs').where({ ID: drugId });
  if (!drug) throw err(404, 'NOT_FOUND');
  const key = { hospital_ID: hospitalId, drug_ID: drugId };
  const prev = await SELECT.one.from('medilink.StockThresholds').where(key);
  await UPSERT.into('medilink.StockThresholds').entries({ ...key, minUnits, updatedAt: new Date().toISOString(), updatedBy: viewer.userId });
  await audit.log(viewer.userId, 'REORDER_LEVEL_SET', { hospital: hospitalId, drug: drugId, minUnits, previous: prev?.minUnits ?? null });
  await run([hospitalId]);
  return { message: t('home.stock.level_set', { drug: drugName(drug), n: minUnits }), result: { hospitalId, drugId, minUnits } };
}

module.exports = { run, assess, conditions, reconcile, tierOf, expiryTiers, summary, stockView, homeAlerts, inbox, ack, setReorderLevel, KINDS };
