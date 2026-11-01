#!/usr/bin/env node
'use strict';
/*
 * MediLink delivery-partner simulator (SYNTHETIC telemetry).
 * Every SIM_TELEMETRY_INTERVAL_SEC it asks CAP for the partner's in-transit shipments and POSTs one
 * GPS + temperature reading per shipment, moving each along its (detoured) route.
 * With SIM_EXCURSION_ENABLED=true, exactly one shipment (cold chain first) goes out of range once.
 *
 * Env: APP_BASE_URL (default http://localhost:4004), SIM_TELEMETRY_INTERVAL_SEC (5), SIM_EXCURSION_ENABLED (true),
 *      SIM_EXCURSION_AFTER_TICKS (3), SIM_SPEEDUP (10), SIM_USER / SIM_PASSWORD (mocked dev user "sim" / "demo"),
 *      SIM_BEARER_TOKEN (XSUAA token for a deployed app; replaces basic auth).
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
    auth: env.SIM_BEARER_TOKEN ? 'Bearer ' + env.SIM_BEARER_TOKEN : 'Basic ' + Buffer.from(`${env.SIM_USER || 'sim'}:${env.SIM_PASSWORD || 'demo'}`).toString('base64'),
  };
}

async function call(cfg, method, p, body) {
  const res = await fetch(cfg.base + p, { method, headers: { Authorization: cfg.auth, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text();
  let json; try { json = text ? JSON.parse(text) : {}; } catch { json = {}; }
  if (!res.ok) { const e = new Error(`${method} ${p} -> ${res.status} ${json?.error?.code || ''}`.trim()); e.status = res.status; throw e; }
  return json;
}

/** One tick: fetch shipments, post readings. Returns the readings sent. */
async function tick(cfg, planner, log = console.log) {
  const shipments = (await call(cfg, 'GET', '/odata/v4/delivery/activeShipments()')).value || [];
  const readings = planner.next(shipments);
  for (const r of readings) {
    const { progress, excursion, ...body } = r;
    try {
      const out = await call(cfg, 'POST', '/odata/v4/delivery/telemetry', body);
      log(`${r.transfer.slice(0, 8)} ${Math.round(progress * 100)}% ${r.lat},${r.long} ${r.temperatureC} °C${out.excursion ? '  << EXCURSION (deliberate demo spike)' : ''}`);
    } catch (e) { log(`${r.transfer.slice(0, 8)} telemetry refused: ${e.message}`); }
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
      if (!sent.length && idle++ % 12 === 0) console.log('no in-transit shipments yet (waiting for a pickup scan)');
      if (sent.length) idle = 0;
    } catch (e) { console.log('tick failed:', e.message); }
    setTimeout(loop, cfg.intervalSec * 1000);
  };
  loop();
}

if (require.main === module) main();
module.exports = { config, tick, call, loadEnv };
