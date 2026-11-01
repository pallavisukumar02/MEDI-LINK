'use strict';
// Background jobs: feed sync + cover recompute every SYNC_INTERVAL_SEC, supplier-timeout sweep, weather check.
const cds = require('@sap/cds');
const config = require('./config');
const LOG = cds.log('jobs');
const timers = [];
let busy = false;

async function step(name, fn) {
  try { return await cds.tx(async () => fn()); } catch (e) { LOG.warn(`${name} failed: ${e.message}`); return { error: e.message }; }
}

async function runSyncCycle() {
  const sync = require('./sync');
  const { recomputeAndAlert } = require('./ingest');
  return {
    sync: await step('sync', () => sync.syncAll()),
    recompute: await step('recompute', async () => (await recomputeAndAlert()).length),
    stale: await step('stale', () => sync.detectStale()),
    licences: await step('licences', () => sync.licenceWatch()),
  };
}
const runTimeouts = () => step('timeouts', async () => (await require('./workflow').timeoutSweep()).length);
const runWeather = () => step('weather', () => require('./delivery').checkWeather());

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
  LOG.info(`jobs started: sync every ${config.syncIntervalSec}s, supplier timeout ${config.supplierResponseTimeoutMin} min, approval mode ${config.approvalMode}`);
}
function stop() { while (timers.length) clearInterval(timers.pop()); }

module.exports = { start, stop, runOnce, runSyncCycle };
