'use strict';
// Background jobs: feed sync + cover recompute + stock/expiry check every SYNC_INTERVAL_SEC, supplier-timeout sweep, weather check, daily cleanup.
const cds = require('@sap/cds');
const config = require('./config');
const LOG = cds.log('jobs');
const timers = [];
let busy = false;

// fn(rows) may collect new alert rows; they join `digest` only once its transaction has committed
async function step(name, fn, digest) {
  const rows = [];
  try { const out = await cds.tx(async () => fn(rows)); digest?.push(...rows); return out; } catch (e) { LOG.warn(`${name} failed: ${e.message}`); return { error: e.message }; }
}

async function runSyncCycle() {
  const sync = require('./sync');
  const { recomputeAndAlert } = require('./ingest');
  const monitor = require('./monitor');
  const digest = []; // one email per hospital for the cycle (each pulled feed already alerted with its own ingest)
  const out = {
    sync: await step('sync', () => sync.syncAll()),
    recompute: await step('recompute', async d => (await recomputeAndAlert(undefined, d)).length, digest),
    monitor: await step('monitor', async d => (await monitor.run(undefined, d)).length, digest),
    stale: await step('stale', d => sync.detectStale(undefined, d), digest),
    licences: await step('licences', d => sync.licenceWatch(undefined, d), digest),
    prices: await step('prices', async () => { // stock moved: hospitals choosing a supplier get fresh prices and distances
      const open = await SELECT.from('medilink.Requests').columns('ID', 'hospital_ID').where({ status: 'MATCHED' });
      for (const r of open) require('./ws').emit('prices', { requestId: r.ID, hospitalId: r.hospital_ID });
      return open.length;
    }),
  };
  await step('digest', () => require('./notify').sendDigest(digest));
  return out;
}
const runTimeouts = () => step('timeouts', async () => (await require('./workflow').timeoutSweep()).length);
const runWeather = () => step('weather', () => require('./delivery').checkWeather());

/** Deletes rows nobody needs any more: idempotency keys and photo previews after a day; sessions, OAuth states, pairing codes once expired. */
async function cleanup(now = new Date()) {
  const dayAgo = new Date(now.getTime() - 86400000).toISOString(), iso = now.toISOString();
  return {
    idempotencyKeys: await DELETE.from('medilink.IdempotencyKeys').where({ createdAt: { '<': dayAgo } }),
    photoPreviews: await DELETE.from('medilink.PhotoPreviews').where({ createdAt: { '<': dayAgo } }),
    sessions: await DELETE.from('medilink.Sessions').where({ exp: { '<': Math.floor(now.getTime() / 1000) } }),
    oauthStates: await DELETE.from('medilink.OAuthStates').where({ expiresAt: { '<': iso } }),
    pairingCodes: await DELETE.from('medilink.PairingCodes').where({ expiresAt: { '<': iso } }),
  };
}
const runCleanup = () => step('cleanup', () => cleanup());

async function runOnce() {
  return { ...(await runSyncCycle()), timeouts: await runTimeouts(), weather: await runWeather() };
}

function every(sec, fn) {
  const t = setInterval(async () => { if (busy) return; busy = true; try { await fn(); } finally { busy = false; } }, sec * 1000);
  t.unref?.();
  timers.push(t);
}

function start() {
  if (!config.jobsEnabled) return LOG.info('background jobs disabled (JOBS_ENABLED=false)');
  every(config.syncIntervalSec, runSyncCycle);
  every(Number(process.env.TIMER_SWEEP_SEC || 60), runTimeouts); // BPA-owned transfers are skipped inside the sweep
  every(Number(process.env.WEATHER_CHECK_SEC || 600), runWeather);
  every(86400, runCleanup);
  runCleanup(); // also at start: a host that restarts daily would otherwise never reach the 24 h tick
  step('monitor', () => require('./monitor').run()); // stock and expiry alerts right after start, not one sync interval later
  LOG.info(`jobs started: sync every ${config.syncIntervalSec}s, supplier timeout ${config.supplierResponseTimeoutMin} min, approval mode ${config.approvalMode}`);
}
function stop() { while (timers.length) clearInterval(timers.pop()); }

module.exports = { start, stop, runOnce, runSyncCycle, cleanup };
