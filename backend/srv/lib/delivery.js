'use strict';
// Partner assignment, pickup custody, telemetry + excursions, route closure re-plan (FR-21..24).
const cds = require('@sap/cds');
const config = require('./config');
const http = require('./http');
const audit = require('./audit');
const routing = require('./routing');
const ws = require('./ws');
const { notify } = require('./notify');
const { partnerCanCarry, licenceValid } = require('./rules');
const LOG = cds.log('delivery');

const T = 'medilink.Transfers';
const err = (status, code, message) => Object.assign(new Error(`${code}: ${message}`), { status, code });

function rangeFor(storageClass) {
  if (storageClass === 'COLD') return [config.coldChainMinC, config.coldChainMaxC];
  if (storageClass === 'FROZEN') return [config.frozenMinC, config.frozenMaxC];
  return [config.ambientMinC, config.ambientMaxC];
}

/** FR-21: only a licensed partner certified for the lot's storage class. Nearest to the supplier wins. */
async function assignPartner(id, actor = 'system') {
  const t = await SELECT.one.from(T).where({ ID: id });
  const drug = await SELECT.one.from('medilink.Drugs').where({ ID: t.drug_ID });
  const lots = await SELECT.from('medilink.Lots').where({ ID: { in: (await SELECT.from('medilink.TransferLots').where({ transfer_ID: id })).map(l => l.lot_ID) } });
  const classes = [...new Set([drug.storageClass, ...lots.map(l => l.storageClass)])];
  const supplier = await SELECT.one.from('medilink.Hospitals').where({ ID: t.supplier_ID });
  const today = new Date().toISOString().slice(0, 10);
  const lic = Object.fromEntries((await SELECT.from('medilink.Licences').where({ partyType: 'PARTNER' })).map(l => [l.partyId, l]));
  const partners = (await SELECT.from('medilink.DeliveryPartners'))
    .filter(p => classes.every(c => partnerCanCarry(p, c)) && licenceValid(lic[p.ID]?.validTill, today))
    .sort((a, b) => routing.haversineKm(a, supplier) - routing.haversineKm(b, supplier));
  if (!partners.length) {
    await notify({ hospital: t.supplier_ID, kind: 'NO_PARTNER', severity: 'HIGH', ref: id, message: `No licensed partner certified for ${classes.join('/')} is available` });
    return null;
  }
  const p = partners[0];
  await UPDATE(T).set({ partner_ID: p.ID, status: 'ASSIGNED' }).where({ ID: id });
  await audit.log(actor, 'PARTNER_ASSIGNED', { transfer: id, partner: p.ID, storageClasses: classes, licence: lic[p.ID]?.licenceNo });
  ws.emit('status', { transferId: id, status: 'ASSIGNED', message: `Partner ${p.name} assigned` });
  return p;
}

/** FR-22: pickup scan of batch(es), seal and temperature logger. Custody moves; supplier stock is decremented. */
async function pickupScan(id, { batchNo, sealId, loggerId }, actor, partnerId) {
  const t = await SELECT.one.from(T).where({ ID: id });
  if (!t) throw err(404, 'TRANSFER_NOT_FOUND', id);
  if (t.status !== 'ASSIGNED') throw err(409, 'INVALID_STATUS', `Transfer is ${t.status}; expected ASSIGNED`);
  if (partnerId && t.partner_ID !== partnerId) throw err(403, 'WRONG_PARTNER', 'This shipment is assigned to another partner');
  if (!sealId || !loggerId || !batchNo) throw err(400, 'SCAN_INCOMPLETE', 'Batch, seal and logger scans are all required');
  const tl = await SELECT.from('medilink.TransferLots').where({ transfer_ID: id });
  const scanned = String(batchNo).split(/[,\s]+/).filter(Boolean).map(s => s.toUpperCase());
  const missing = tl.filter(l => !scanned.includes(String(l.batchNo).toUpperCase()));
  if (missing.length) throw err(409, 'BATCH_MISMATCH', `Scanned batch does not match; expected ${tl.map(l => l.batchNo).join(', ')}`);
  for (const l of tl) {
    const lot = await SELECT.one.from('medilink.Lots').where({ ID: l.lot_ID });
    if (!lot || Number(lot.quantity) < Number(l.qty)) throw err(409, 'STOCK_CHANGED', `Lot ${l.batchNo} no longer holds ${l.qty} units`);
    await UPDATE('medilink.Lots').set({ quantity: Number(lot.quantity) - Number(l.qty) }).where({ ID: l.lot_ID });
  }
  const now = new Date();
  await UPDATE(T).set({ status: 'IN_TRANSIT', sealId, loggerId, pickedUpAt: now.toISOString(), eta: new Date(now.getTime() + Number(t.etaMin || 0) * 60000).toISOString() }).where({ ID: id });
  await audit.log(actor, 'PICKUP', { transfer: id, batches: tl.map(l => l.batchNo), sealId, loggerId, partner: t.partner_ID });
  ws.emit('status', { transferId: id, status: 'IN_TRANSIT', message: 'Picked up; tracking live' });
  return SELECT.one.from(T).where({ ID: id });
}

/** FR-23/24: GPS + temperature from the partner logger. */
async function telemetry({ transfer, loggerId, lat, long, temperatureC, sealStatus, ts }, actor, partnerId = null) {
  sealStatus = sealStatus || 'INTACT';
  const t = transfer ? await SELECT.one.from(T).where({ ID: transfer }) : await SELECT.one.from(T).where({ loggerId, status: 'IN_TRANSIT' });
  if (!t) throw err(404, 'SHIPMENT_NOT_FOUND', 'No in-transit shipment for this transfer / logger');
  if (partnerId && t.partner_ID !== partnerId) throw err(403, 'WRONG_PARTNER', 'This shipment is assigned to another partner');
  if (t.status !== 'IN_TRANSIT') throw err(409, 'INVALID_STATUS', `Transfer is ${t.status}`);
  const drug = await SELECT.one.from('medilink.Drugs').where({ ID: t.drug_ID });
  const [min, max] = rangeFor(drug.storageClass);
  const temp = Math.round(Number(temperatureC) * 100) / 100;
  lat = Math.round(Number(lat) * 1e6) / 1e6; long = Math.round(Number(long) * 1e6) / 1e6;
  if (!isFinite(temp) || !isFinite(lat) || !isFinite(long)) throw err(400, 'INVALID_TELEMETRY', 'lat, long and temperatureC must be numbers');
  const sealBroken = String(sealStatus).toUpperCase() === 'BROKEN';
  const excursion = temp < min || temp > max || sealBroken;
  const loggedAt = ts ? new Date(ts).toISOString() : new Date().toISOString();
  await INSERT.into('medilink.ConditionLogs').entries({ ID: cds.utils.uuid(), transfer_ID: t.ID, loggedAt, lat, long, temperatureC: temp, sealStatus: sealBroken ? 'BROKEN' : 'INTACT', excursion });
  ws.emit('telemetry', { transferId: t.ID, lat, long, temperatureC: temp, sealStatus: sealBroken ? 'BROKEN' : 'INTACT', excursion, loggedAt });
  if (excursion && !t.excursion) {
    await UPDATE(T).set({ excursion: true, quarantineSuggested: true }).where({ ID: t.ID });
    const msg = sealBroken ? `Seal reported BROKEN on shipment ${t.ID.slice(0, 8)}; quarantine on arrival suggested`
      : `Temperature excursion on shipment ${t.ID.slice(0, 8)} (${drug.genericName}): ${temp} °C outside ${min}-${max} °C; quarantine on arrival suggested`;
    for (const h of [t.supplier_ID, t.receiver_ID]) await notify({ hospital: h, kind: 'EXCURSION', severity: 'HIGH', ref: t.ID, message: msg });
    await audit.log(actor, 'EXCURSION', { transfer: t.ID, temperatureC: temp, range: `${min}-${max}`, sealStatus, loggedAt });
    ws.emit('excursion', { transferId: t.ID, temperatureC: temp, range: `${min}-${max}`, message: msg, quarantineSuggested: true, hospitals: `${t.supplier_ID},${t.receiver_ID}` });
  }
  return { accepted: true, excursion, transferId: t.ID };
}

async function currentPosition(t) {
  const last = await SELECT.one.from('medilink.ConditionLogs').where({ transfer_ID: t.ID }).orderBy('loggedAt desc');
  if (last) return { lat: Number(last.lat), long: Number(last.long) };
  return SELECT.one.from('medilink.Hospitals').columns('lat', 'long').where({ ID: t.supplier_ID });
}

/** Re-plan the remaining route of an in-transit (or assigned) shipment around active closures. */
async function replan(id, actor = 'system') {
  const t = await SELECT.one.from(T).where({ ID: id });
  const from = await currentPosition(t);
  const to = await SELECT.one.from('medilink.Hospitals').where({ ID: t.receiver_ID });
  const closures = await SELECT.from('medilink.RoadClosures').where({ active: true });
  const r = await routing.route(from, to, closures);
  const request = t.request_ID ? await SELECT.one.from('medilink.Requests').where({ ID: t.request_ID }) : null;
  let note = r.open ? (r.note || 'Route open') : `No open route (${r.note || 'closed'}); hold at a safe location`;
  if (r.open && request) {
    const arrival = new Date(Date.now() + r.etaMin * 60000);
    if (arrival > new Date(String(request.neededBy).slice(0, 10) + 'T23:59:59Z')) note += '; new ETA misses the needed-by date';
  }
  const set = { routeClosed: closures.length > 0, routeNote: note };
  if (r.open) Object.assign(set, { distanceKm: r.distanceKm, etaMin: r.etaMin, eta: new Date(Date.now() + r.etaMin * 60000).toISOString() });
  await UPDATE(T).set(set).where({ ID: id });
  await audit.log(actor, 'ROUTE_REPLANNED', { transfer: id, open: r.open, distanceKm: r.distanceKm, etaMin: r.etaMin, provider: r.provider, note });
  ws.emit('replan', { transferId: id, distanceKm: r.distanceKm, etaMin: r.etaMin, open: r.open, note });
  if (!r.open) await notify({ hospital: t.receiver_ID, kind: 'ROUTE', severity: 'HIGH', ref: id, message: note });
  return { transferId: id, open: r.open, distanceKm: r.distanceKm, etaMin: r.etaMin, note, via: r.via };
}

/** Manual "road flooded" toggle: drops a closure on the remaining path and re-plans. */
async function setRouteClosed(id, closed, note, actor) {
  const t = await SELECT.one.from(T).where({ ID: id });
  if (!t) throw err(404, 'TRANSFER_NOT_FOUND', id);
  if (!['ASSIGNED', 'IN_TRANSIT'].includes(t.status)) throw err(409, 'INVALID_STATUS', `Transfer is ${t.status}`);
  if (closed) {
    const a = await currentPosition(t);
    const b = await SELECT.one.from('medilink.Hospitals').where({ ID: t.receiver_ID });
    const r6 = v => Math.round(v * 1e6) / 1e6;
    const mid = { lat: r6((Number(a.lat) + Number(b.lat)) / 2), long: r6((Number(a.long) + Number(b.long)) / 2) };
    const radiusKm = Math.round(100 * Math.max(0.3, Math.min(1.2, routing.haversineKm(a, b) * 0.12))) / 100;
    await INSERT.into('medilink.RoadClosures').entries({ ID: cds.utils.uuid(), name: note || 'Flooded road (manual)', lat: mid.lat, long: mid.long, radiusKm, source: 'MANUAL', active: true, transfer_ID: id });
    await audit.log(actor, 'ROUTE_CLOSED', { transfer: id, note: note || 'manual toggle', lat: mid.lat, long: mid.long, radiusKm });
  } else {
    await UPDATE('medilink.RoadClosures').set({ active: false }).where({ transfer_ID: id, active: true });
    await audit.log(actor, 'ROUTE_REOPENED', { transfer: id });
  }
  const r = await replan(id, actor);
  return { transferId: id, closed: !!closed, distanceKm: r.distanceKm, etaMin: r.etaMin, note: r.note, open: r.open };
}

/** Open-Meteo rain check on the remaining path of in-transit shipments (fail-soft). */
async function checkWeather(actor = 'system:weather') {
  const out = [];
  if (!config.weatherCheckEnabled) return out;
  const ts = await SELECT.from(T).where({ status: 'IN_TRANSIT' });
  for (const t of ts) {
    try {
      const a = await currentPosition(t);
      const b = await SELECT.one.from('medilink.Hospitals').where({ ID: t.receiver_ID });
      const mid = { lat: Math.round((Number(a.lat) + Number(b.lat)) * 5e5) / 1e6, long: Math.round((Number(a.long) + Number(b.long)) * 5e5) / 1e6 };
      const res = await http.request(`${config.openMeteoUrl}?latitude=${mid.lat.toFixed(4)}&longitude=${mid.long.toFixed(4)}&hourly=precipitation&forecast_hours=3&timezone=UTC`, { timeoutMs: 5000 });
      if (res.status !== 200) throw new Error('Open-Meteo status ' + res.status);
      const p = (res.json.hourly?.precipitation || []).slice(0, 3);
      const maxP = p.length ? Math.max(...p) : 0;
      let closed = false;
      if (maxP >= config.weatherCloseMmPerH) {
        const exists = await SELECT.one.from('medilink.RoadClosures').where({ transfer_ID: t.ID, source: 'OPEN_METEO', active: true });
        if (!exists) {
          await INSERT.into('medilink.RoadClosures').entries({ ID: cds.utils.uuid(), name: `Heavy rain ${maxP} mm/h (Open-Meteo)`, lat: mid.lat, long: mid.long, radiusKm: 1, source: 'OPEN_METEO', active: true, transfer_ID: t.ID });
          await replan(t.ID, actor);
        }
        closed = true;
      }
      out.push({ transferId: t.ID, maxPrecipMm: maxP, closed, note: closed ? 'Flood risk: route re-planned' : 'OK' });
    } catch (e) {
      LOG.debug('weather check skipped:', e.message);
      out.push({ transferId: t.ID, maxPrecipMm: null, closed: false, note: 'Weather unavailable: ' + e.message });
    }
  }
  return out;
}

async function activeShipments(partnerId) {
  const where = { status: 'IN_TRANSIT' };
  if (partnerId) where.partner_ID = partnerId;
  const ts = await SELECT.from(T).where(where);
  const out = [];
  for (const t of ts) {
    const [s, r, d] = await Promise.all([
      SELECT.one.from('medilink.Hospitals').where({ ID: t.supplier_ID }), SELECT.one.from('medilink.Hospitals').where({ ID: t.receiver_ID }), SELECT.one.from('medilink.Drugs').where({ ID: t.drug_ID }),
    ]);
    const [minC, maxC] = rangeFor(d.storageClass);
    const closures = await SELECT.from('medilink.RoadClosures').where({ active: true });
    const route = routing.fallbackRoute(s, r, closures);
    out.push({ ID: t.ID, status: t.status, loggerId: t.loggerId, storageClass: d.storageClass, minC, maxC, fromLat: s.lat, fromLong: s.long, toLat: r.lat, toLong: r.long, pickedUpAt: t.pickedUpAt, etaMin: t.etaMin, via: JSON.stringify(route.via || []) });
  }
  return out;
}

module.exports = { assignPartner, pickupScan, telemetry, replan, setRouteClosed, checkWeather, activeShipments, rangeFor };
