#!/usr/bin/env node
'use strict';
/*
 * MediLink courier simulator (SYNTHETIC rider + temperature logger).
 * Couriers have no MediLink account. Every SIM_TELEMETRY_INTERVAL_SEC the simulator lists the working courier links as an
 * admin (GET /admin/courier-links), then plays each delivery's rider and logger through its link, as courier.html would:
 *   - ASSIGNED for a minute and still not scanned: POST /courier/pickup with the batches (a person, or npm run demo,
 *     gets that minute to do the pickup beat itself)
 *   - IN_TRANSIT: one GPS + temperature reading per delivery (POST /courier/location), moving along the route from
 *     GET /courier/job. With SIM_EXCURSION_ENABLED=true exactly one delivery (cold chain first) goes out of range once.
 *
 * Env: APP_BASE_URL (default http://localhost:4004), SIM_TELEMETRY_INTERVAL_SEC (5), SIM_EXCURSION_ENABLED (true),
 *      SIM_EXCURSION_AFTER_TICKS (3), SIM_SPEEDUP (10), SIM_USER / SIM_PASSWORD (an admin account; development default
 *      admin / DEMO_PASSWORD), SIM_BEARER_TOKEN (an admin's token from POST /auth/login; replaces Basic).
 */
const path = require('path');
const fs = require('fs');
const { createPlanner } = require('./sim');

function loadEnv(file) {
  if (!fs.existsSync(file)) return;
  for (const raw of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)$/.exec(raw);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/\s+#.*$/, '').replace(/^["']|["']$/g, '').trim();
  }
}

function config(env = process.env) {
  const bool = (v, d) => (v === undefined || v === '' ? d : /^(1|true|yes|on)$/i.test(v));
  return {
    base: (env.APP_BASE_URL || 'http://localhost:4004').replace(/\/$/, ''),
    intervalSec: Number(env.SIM_TELEMETRY_INTERVAL_SEC) || 5,
    excursion: bool(env.SIM_EXCURSION_ENABLED, true),
    excursionAfterTicks: Number(env.SIM_EXCURSION_AFTER_TICKS) || 3,
    speedup: Number(env.SIM_SPEEDUP) || 10,
    auth: env.SIM_BEARER_TOKEN ? 'Bearer ' + env.SIM_BEARER_TOKEN : 'Basic ' + Buffer.from(`${env.SIM_USER || 'admin'}:${env.SIM_PASSWORD || env.DEMO_PASSWORD || 'demo'}`).toString('base64'),
  };
}
const PICKUP_AFTER_MS = 60000;

async function call(cfg, method, p, body, auth = cfg.auth) {
  const res = await fetch(cfg.base + p, { method, headers: { Authorization: auth, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text();
  let json; try { json = text ? JSON.parse(text) : {}; } catch { json = {}; }
  if (!res.ok) { const e = new Error(`${method} ${p} -> ${res.status} ${json?.error?.code || json?.code || ''}`.trim()); e.status = res.status; throw e; }
  return json;
}

/** Courier job -> the planner's shipment shape (route points between pickup and drop become waypoints). */
const shipmentOf = (transferId, j) => ({
  ID: transferId, storageClass: j.storageClass, minC: j.temperatureRange.minC, maxC: j.temperatureRange.maxC, pickedUpAt: j.pickedUpAt, etaMin: j.etaMin,
  fromLat: j.pickup.lat, fromLong: j.pickup.long, toLat: j.drop.lat, toLong: j.drop.long, via: (j.route?.points || []).slice(1, -1).map(([lat, long]) => ({ lat, long })),
});

/** One tick: list the links, pick up what nobody scanned for a minute, post one reading per moving delivery. */
async function tick(cfg, planner, log = console.log, now = Date.now()) {
  const { links = [] } = await call(cfg, 'GET', '/admin/courier-links');
  const moving = [], linkOf = {};
  for (const l of links) {
    const auth = 'Courier ' + l.token; // never logged
    try {
      if (l.status === 'ASSIGNED') {
        if (now - Date.parse(l.createdAt) < PICKUP_AFTER_MS) continue;
        const id = l.transferId.slice(0, 4).toUpperCase();
        await call(cfg, 'POST', '/courier/pickup', { batchNo: l.batches.join(','), sealId: `SEAL-SIM-${id}`, loggerId: `LOG-SIM-${id}`, riderName: 'Simulated rider (synthetic)' }, auth);
        log(`${l.transferId.slice(0, 8)} picked up by the simulated rider`);
      }
      const job = await call(cfg, 'GET', '/courier/job', null, auth);
      if (job.status === 'IN_TRANSIT') { moving.push(shipmentOf(l.transferId, job)); linkOf[l.transferId] = auth; }
    } catch (e) { log(`${l.transferId.slice(0, 8)} skipped: ${e.message}`); }
  }
  const readings = planner.next(moving);
  for (const r of readings) {
    const { lat, long, temperatureC, sealStatus } = r;
    try {
      const out = await call(cfg, 'POST', '/courier/location', { lat, long, temperatureC, sealStatus }, linkOf[r.transfer]);
      log(`${r.transfer.slice(0, 8)} ${Math.round(r.progress * 100)}% ${lat},${long} ${temperatureC} °C${out.excursion ? '  << EXCURSION (deliberate demo spike)' : ''}`);
    } catch (e) { log(`${r.transfer.slice(0, 8)} reading refused: ${e.message}`); }
  }
  return readings;
}

async function main() {
  loadEnv(path.join(__dirname, '..', 'backend', '.env'));
  const cfg = config();
  const planner = createPlanner({ excursion: cfg.excursion, excursionAfterTicks: cfg.excursionAfterTicks, speedup: cfg.speedup, intervalSec: cfg.intervalSec });
  console.log(`[simulator] ${cfg.base} every ${cfg.intervalSec}s, excursion ${cfg.excursion ? 'ON (once)' : 'off'} (synthetic telemetry)`);
  let idle = 0;
  const loop = async () => {
    try {
      const sent = await tick(cfg, planner);
      if (!sent.length && idle++ % 12 === 0) console.log('no delivery on the road yet (waiting for a pickup)');
      if (sent.length) idle = 0;
    } catch (e) { console.log('tick failed:', e.message); }
    setTimeout(loop, cfg.intervalSec * 1000);
  };
  loop();
}

if (require.main === module) main();
module.exports = { config, tick, call, loadEnv };
