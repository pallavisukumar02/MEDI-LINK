'use strict';
/*
 * Live tracking of a delivery for the receiving hospital, Swiggy / Zomato style (FR-23):
 *   GET /me/journeys/:id/tracking  one entry per assigned / in-transit leg (and for 2 h after the hand-over)
 *   WebSocket "tracking"           after every GPS / temperature fix (lib/ws.js picks who gets what)
 * The receiving hospital and admin see everything; the supplying hospital a summary (no rider phone, live position,
 * trail or route); anyone else gets 404. Fixes come from the rider's phone (GPS only) and the logger (with temperature);
 * temperature, excursion and trace logic use the temperature readings only.
 * ETA: recomputed from the latest fix at most once a minute per transfer (openrouteservice when ORS_API_KEY is set,
 * else Haversine x ROAD_FACTOR at CITY_SPEED_KMH) and saved to Transfers.eta.
 */
const cds = require('@sap/cds');
const config = require('./config');
const routing = require('./routing');
const ws = require('./ws');
const { t: msg } = require('./messages');
const { ARRIVED_KM, fmtClock, drugName } = require('./journey');
const LOG = cds.log('tracking');

const T = 'medilink.Transfers';
const SHOWN = ['ASSIGNED', 'IN_TRANSIT'], DONE = ['DELIVERED', 'QUARANTINED'];
const GRACE_MS = 2 * 3600000, ETA_EVERY_MS = 60000, TRAIL = 20, READINGS = 20;
const pt = p => ({ lat: Number(p.lat), long: Number(p.long) });
const iso = v => (v ? new Date(v).toISOString() : null);
const hasTemp = f => f.temperatureC !== null && f.temperatureC !== undefined;
const place = h => ({ name: h.name, lat: Number(h.lat), long: Number(h.long) });
const inRange = (c, [minC, maxC]) => (c === null ? null : c >= minC && c <= maxC);

/** Route to draw: the stored openrouteservice geometry when keyed, else pickup -> detour points -> drop. */
function routeOf(t, from, to, closures) {
  if (config.orsKey && t.routeJson) { try { return JSON.parse(t.routeJson); } catch { /* draw the fallback */ } }
  const r = routing.fallbackRoute(from, to, closures);
  return {
    points: [from, ...(r.via || []), to].map(p => [Number(p.lat), Number(p.long)]),
    steps: [{ instruction: msg('courier.step.pickup', { place: from.name }) }, ...(r.detour || !r.open ? [{ instruction: r.note }] : []), { instruction: msg('courier.step.drop', { place: to.name }) }],
  };
}

/** Road distance left: Haversine x road factor around active closures (null when no open route). */
function remainingKm(pos, to, closures) {
  const r = routing.fallbackRoute(pos, to, closures);
  return r.open ? r.distanceKm : null;
}

function etaText(eta) {
  if (!eta) return null;
  const min = Math.ceil((new Date(eta).getTime() - Date.now()) / 60000);
  return min <= 0 ? msg('tracking.eta_now') : msg('tracking.eta', { minutes: min, clock: fmtClock(eta) });
}

async function leg(t, side, neededBy) {
  const { rangeFor } = require('./delivery');
  const [from, to, drug, partner, links, fixes, closures] = await Promise.all([
    SELECT.one.from('medilink.Hospitals').where({ ID: t.supplier_ID }), SELECT.one.from('medilink.Hospitals').where({ ID: t.receiver_ID }),
    SELECT.one.from('medilink.Drugs').where({ ID: t.drug_ID }),
    t.partner_ID ? SELECT.one.from('medilink.DeliveryPartners').columns('name').where({ ID: t.partner_ID }) : null,
    SELECT.from('medilink.CourierLinks').columns('createdAt', 'riderName', 'riderPhone').where({ transfer_ID: t.ID }).orderBy('createdAt'),
    SELECT.from('medilink.ConditionLogs').where({ transfer_ID: t.ID }).orderBy('loggedAt'),
    SELECT.from('medilink.RoadClosures').where({ active: true }),
  ]);
  const dest = pt(to), range = rangeFor(drug.storageClass);
  const firstWithin = km => fixes.find(f => routing.haversineKm(pt(f), dest) <= km);
  const done = DONE.includes(t.status), picked = !!t.pickedUpAt, moving = t.status === 'IN_TRANSIT';
  const near = firstWithin(config.nearbyKm), there = firstWithin(ARRIVED_KM);
  const steps = [
    ['confirmed', [links[0]?.createdAt, t.pickedUpAt].filter(Boolean).map(iso).sort()[0], true],
    ['picked_up', t.pickedUpAt, picked],
    ['on_the_way', fixes[0]?.loggedAt || t.pickedUpAt, picked && (fixes.length > 0 || done)],
    ['nearby', near?.loggedAt, !!near || done],
    ['arrived', there?.loggedAt, !!there || done],
    ['delivered', t.deliveredAt, done],
  ].map(([key, at, isDone]) => ({ key, label: msg(`tracking.step.${key}`), done: !!isDone, at: isDone ? iso(at) : null }));

  const last = fixes.at(-1);
  const temps = fixes.filter(hasTemp), cur = temps.at(-1), vals = temps.map(f => Number(f.temperatureC));
  const current = cur ? Number(cur.temperatureC) : null;
  const eta = moving ? iso(t.eta) : null;
  const endOfNeed = neededBy ? new Date(String(neededBy).slice(0, 10) + 'T23:59:59Z') : null;
  const rider = links.filter(l => l.riderName || l.riderPhone).at(-1);
  const summary = side === 'supplier';
  return {
    transferId: t.ID, status: t.status, drug: { name: drugName(drug) }, qty: t.qty, steps,
    partner: partner ? { name: partner.name } : null, riderName: rider?.riderName || null, riderPhone: summary ? null : rider?.riderPhone || null,
    origin: place(from), destination: place(to),
    route: summary ? [] : routeOf(t, from, to, closures).points,
    position: summary || !last ? null : { lat: Number(last.lat), long: Number(last.long), at: iso(last.loggedAt), accuracyM: last.accuracyM == null ? null : Number(last.accuracyM) },
    trail: summary ? [] : fixes.slice(-TRAIL).map(f => [Number(f.lat), Number(f.long)]),
    eta, etaText: etaText(eta), remainingKm: moving ? remainingKm(last || from, to, closures) : null,
    temperature: {
      current, at: iso(cur?.loggedAt), min: vals.length ? Math.min(...vals) : null, max: vals.length ? Math.max(...vals) : null,
      range: { minC: range[0], maxC: range[1] }, inRange: inRange(current, range),
      readings: summary ? [] : temps.slice(-READINGS).map(f => ({ at: iso(f.loggedAt), c: Number(f.temperatureC) })),
    },
    excursion: !!t.excursion, delayed: !!eta && ((!there && new Date(eta) < new Date()) || (!!endOfNeed && new Date(eta) > endOfNeed)),
    routeNote: t.routeNote || null,
  };
}

/** GET /me/journeys/:id/tracking (journey = request ID, or a transfer ID). null = not a party (the route answers 404). */
async function forJourney(id, viewer) {
  let r = await SELECT.one.from('medilink.Requests').columns('ID', 'hospital_ID', 'neededBy').where({ ID: id });
  let legs = r ? await SELECT.from(T).where({ request_ID: r.ID }) : [];
  if (!r) {
    const x = await SELECT.one.from(T).where({ ID: id });
    if (!x) return null;
    r = x.request_ID ? await SELECT.one.from('medilink.Requests').columns('ID', 'hospital_ID', 'neededBy').where({ ID: x.request_ID }) : null;
    legs = r ? await SELECT.from(T).where({ request_ID: r.ID }) : [x];
  }
  const own = viewer.hospitalId, receiver = r?.hospital_ID || legs[0]?.receiver_ID;
  const side = viewer.role === 'admin' ? 'admin' : !own ? null : receiver === own ? 'receiver' : legs.some(x => x.supplier_ID === own) ? 'supplier' : null;
  if (!side) return null;
  const shown = legs.filter(x => (side !== 'supplier' || x.supplier_ID === own)
    && (SHOWN.includes(x.status) || (DONE.includes(x.status) && Date.now() - new Date(x.deliveredAt).getTime() < GRACE_MS)));
  return { journeyId: r?.ID || id, requestId: r?.ID || null, perspective: side, legs: await Promise.all(shown.map(x => leg(x, side, r?.neededBy))) };
}

// shortcut: last ETA refresh per transfer, in memory per process; with several app instances keep it on the transfer row.
const etaAt = new Map();

/** Called in the fix's transaction: the ETA refresh (maybe an openrouteservice call) and the push run after the commit,
 *  so no database transaction waits on the network. */
function afterFix(t, fix, prev, range) {
  const run = () => cds.tx({ user: cds.User.privileged }, () => refresh(t, fix, prev, range)).catch(e => LOG.warn('tracking update failed:', e.message));
  const ctx = cds.context;
  if (ctx?.tx && typeof ctx.on === 'function') ctx.on('succeeded', () => setImmediate(run));
  else setImmediate(run);
}

/** Refresh the ETA (at most once a minute), push "tracking"; journey.updated only when a step changed. */
async function refresh(t, fix, prev, range) {
  const to = await SELECT.one.from('medilink.Hospitals').columns('lat', 'long').where({ ID: t.receiver_ID });
  const closures = await SELECT.from('medilink.RoadClosures').where({ active: true });
  let eta = t.eta ? iso(t.eta) : null;
  if (Date.now() - (etaAt.get(t.ID) || 0) >= ETA_EVERY_MS) {
    etaAt.set(t.ID, Date.now());
    const r = await routing.route(pt(fix), pt(to), closures);
    if (r.open) {
      // route() adds the hand-over time at pickup; a courier on the road only has the drive left
      eta = new Date(Date.now() + Math.max(0, r.etaMin - config.handlingMin) * 60000).toISOString();
      await UPDATE(T).set({ eta, routeJson: r.points ? JSON.stringify({ points: r.points, steps: r.steps }) : null }).where({ ID: t.ID });
    }
  }
  const lastTemp = hasTemp(fix) ? fix : await SELECT.one.from('medilink.ConditionLogs').columns('temperatureC').where({ transfer_ID: t.ID, temperatureC: { '!=': null } }).orderBy('loggedAt desc');
  const current = lastTemp ? Number(lastTemp.temperatureC) : null;
  const km = p => routing.haversineKm(pt(p), pt(to));
  const crossed = limit => km(fix) <= limit && (!prev || km(prev) > limit);
  ws.emit('tracking', {
    transferId: t.ID, requestId: t.request_ID || null, status: t.status,
    position: { lat: fix.lat, long: fix.long, at: fix.loggedAt, accuracyM: fix.accuracyM ?? null },
    temperature: { current, inRange: inRange(current, range), range: { minC: range[0], maxC: range[1] } },
    eta, etaText: etaText(eta), remainingKm: remainingKm(fix, to, closures),
  }, { journey: !prev || crossed(config.nearbyKm) || crossed(ARRIVED_KM) });
}

module.exports = { forJourney, afterFix, routeOf, etaText, _etaAt: etaAt };
