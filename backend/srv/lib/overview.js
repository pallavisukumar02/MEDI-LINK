'use strict';
/*
 * GET /admin/overview: the admin dashboard's numbers, derived from existing state (no new tables).
 *   kpis        hospitals live / stale / offline, usable units, medicines short, deliveries moving, open alerts, open loans
 *   hospitals   one row per hospital: feed state, usable / expiring / expired units, short and low medicines, alerts, deliveries
 *   cover       hospital x medicine grid of cover status for the window (short / low / covered / none)
 *   expiry      usable units by days left to expiry
 *   alerts      open alerts by kind
 *   coldChain   temperature readings of shipments on the road (or delivered in the last 6 h) with their safe range
 *   activity    the latest audit entries (actor, action, time)
 */
const config = require('./config');
const coverdb = require('./coverdb');
const { daysBetween } = require('./cover');
const { rangeFor } = require('./delivery');
const { shortName, drugName } = require('./journey');

const BUCKETS = [['Expired', -Infinity, 0], ['≤ 30 d', 1, 30], ['31–60 d', 31, 60], ['61–90 d', 61, 90], ['91–180 d', 91, 180], ['180+ d', 181, Infinity]];
const MOVING = ['PENDING_SUPPLIER', 'PENDING_APPROVAL', 'PENDING_SECOND_APPROVAL', 'APPROVED', 'ASSIGNED', 'IN_TRANSIT'];
const KIND = { LOW_STOCK: 'Low stock', OUT_OF_STOCK: 'Out of stock', EXPIRING: 'Expiring', EXPIRED: 'Expired', SHORTFALL: 'Shortfall', EXCURSION: 'Temperature', STALE_FEED: 'Data out of date', LICENCE_EXPIRY: 'Licence', ROUTE: 'Route', FALLBACK: 'Fallback' };
const MAX_POINTS = 120;

const feedOf = h => (!h.connected ? 'offline' : h.feedStale ? 'stale' : h.lastSyncedAt ? 'live' : 'offline');
const thin = (xs, n) => (xs.length <= n ? xs : Array.from({ length: n }, (_, i) => xs[Math.round((i * (xs.length - 1)) / (n - 1))]));

async function overview() {
  const today = coverdb.today();
  const window = config.coverWindowDays;
  const [hospitals, drugs, lots, transfers, notes, loans, audit] = await Promise.all([
    SELECT.from('medilink.Hospitals').orderBy('ID'),
    SELECT.from('medilink.Drugs').orderBy('genericName', 'strength'),
    SELECT.from('medilink.Lots').columns('hospital_ID', 'drug_ID', 'quantity', 'expiryDate', 'quarantined'),
    SELECT.from('medilink.Transfers').columns('ID', 'status', 'supplier_ID', 'receiver_ID', 'drug_ID', 'qty', 'excursion', 'deliveredAt'),
    SELECT.from('medilink.Notifications').columns('hospital_ID', 'kind', 'severity').where({ resolvedAt: null, ackedAt: null }),
    SELECT.from('medilink.Ledger').columns('status', 'qty'),
    SELECT.from('medilink.AuditLog').columns('seq', 'actor', 'action', 'loggedAt').orderBy('seq desc').limit(10),
  ]);
  const drugById = Object.fromEntries(drugs.map(d => [d.ID, d]));
  // shortcut: one cover board per hospital (a few queries each); fine for a city's worth of hospitals, batch it past ~50.
  const boards = Object.fromEntries(await Promise.all(hospitals.map(async h => [h.ID, await coverdb.board(h.ID, window)])));

  const expiry = BUCKETS.map(([label]) => ({ label, units: 0 }));
  const stock = {};
  for (const l of lots) {
    const qty = Number(l.quantity) || 0;
    if (qty <= 0 || l.quarantined) continue;
    const days = daysBetween(today, l.expiryDate);
    expiry[BUCKETS.findIndex(([, lo, hi]) => days >= lo && days <= hi)].units += qty;
    const s = stock[l.hospital_ID] ||= { usable: 0, expiring: 0, expired: 0 };
    if (days <= 0) s.expired += qty; else if (days <= 90) s.expiring += qty; else s.usable += qty;
  }

  const moving = transfers.filter(t => MOVING.includes(t.status));
  const rows = hospitals.map(h => {
    const b = boards[h.ID] || [], s = stock[h.ID] || { usable: 0, expiring: 0, expired: 0 }, mine = notes.filter(n => n.hospital_ID === h.ID);
    return {
      id: h.ID, name: shortName(h), area: String(h.name || '').split(',')[1]?.trim() || '', software: h.software, feed: feedOf(h), lastSyncedAt: h.lastSyncedAt || null,
      units: s, short: b.filter(r => r.status === 'RED').length, low: b.filter(r => r.status === 'GREEN' && r.belowMargin).length,
      alerts: mine.length, urgent: mine.filter(n => n.severity === 'HIGH').length,
      incoming: moving.filter(t => t.receiver_ID === h.ID).length, outgoing: moving.filter(t => t.supplier_ID === h.ID).length,
    };
  });

  const coverDrugs = drugs.filter(d => hospitals.some(h => (boards[h.ID] || []).some(r => r.drugId === d.ID)));
  const cover = {
    windowDays: window,
    drugs: coverDrugs.map(d => ({ id: d.ID, name: drugName(d) })),
    hospitals: hospitals.map(h => ({ id: h.ID, name: shortName(h) })),
    cells: hospitals.flatMap(h => (boards[h.ID] || []).map(r => ({
      hospitalId: h.ID, drugId: r.drugId, status: r.status === 'RED' ? 'short' : r.status === 'NONE' ? 'none' : r.belowMargin ? 'low' : 'covered',
      booked: r.booked, shortfall: r.shortfall, stock: r.usableStock,
    }))),
  };

  const byKind = {};
  for (const n of notes) { const k = byKind[n.kind] ||= { kind: n.kind, label: KIND[n.kind] || n.kind, count: 0, urgent: 0 }; k.count++; if (n.severity === 'HIGH') k.urgent++; }

  const recent = Date.now() - 6 * 3600000;
  const road = transfers.filter(t => ['ASSIGNED', 'IN_TRANSIT'].includes(t.status) || (['DELIVERED', 'QUARANTINED'].includes(t.status) && Date.parse(t.deliveredAt) > recent)).slice(0, 3);
  const coldChain = await Promise.all(road.map(async t => {
    const logs = await SELECT.from('medilink.ConditionLogs').columns('loggedAt', 'temperatureC', 'excursion').where({ transfer_ID: t.ID, temperatureC: { '!=': null } }).orderBy('loggedAt');
    const [min, max] = rangeFor(drugById[t.drug_ID]?.storageClass);
    return {
      transferId: t.ID, drug: drugName(drugById[t.drug_ID]), from: shortName(hospitals.find(h => h.ID === t.supplier_ID)), to: shortName(hospitals.find(h => h.ID === t.receiver_ID)),
      status: t.status, excursion: !!t.excursion, min, max,
      points: thin(logs, MAX_POINTS).map(l => ({ at: l.loggedAt, c: Number(l.temperatureC), out: !!l.excursion })),
    };
  }));

  const openLoans = loans.filter(l => l.status === 'OPEN');
  return {
    generatedAt: new Date().toISOString(),
    kpis: {
      hospitals: { total: rows.length, live: rows.filter(r => r.feed === 'live').length, stale: rows.filter(r => r.feed === 'stale').length, offline: rows.filter(r => r.feed === 'offline').length },
      units: rows.reduce((n, r) => n + r.units.usable + r.units.expiring, 0),
      shortMedicines: new Set(cover.cells.filter(c => c.status === 'short').map(c => c.drugId)).size,
      moving: moving.length, onRoad: transfers.filter(t => t.status === 'IN_TRANSIT').length,
      alerts: { open: notes.length, urgent: notes.filter(n => n.severity === 'HIGH').length },
      loans: { open: openLoans.length, units: openLoans.reduce((n, l) => n + (Number(l.qty) || 0), 0) },
    },
    hospitals: rows,
    cover,
    expiry,
    alerts: Object.values(byKind).sort((a, b) => b.count - a.count),
    coldChain,
    activity: audit.map(a => ({ seq: a.seq, actor: a.actor, action: a.action, at: a.loggedAt })),
  };
}

module.exports = { overview };
