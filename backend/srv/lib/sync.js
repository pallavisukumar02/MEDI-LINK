'use strict';
// Feed orchestration: pull-based sources (MediSoft, SAP sandbox), stale-feed detection, licence watch.
const cds = require('@sap/cds');
const config = require('./config');
const medisoft = require('./medisoft');
const sap = require('./sap');
const audit = require('./audit');
const { notify } = require('./notify');
const { daysBetween } = require('./cover');
const LOG = cds.log('sync');

const withTimeout = (p, ms) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), ms))]);

async function syncHospital(hospital) {
  const h = typeof hospital === 'string' ? await SELECT.one.from('medilink.Hospitals').where({ ID: hospital }) : hospital;
  if (!h) return null;
  try {
    if (h.software === 'MEDISOFT') return await withTimeout(medisoft.pull(h.ID), 8000);
    if (h.software === 'SAP_SANDBOX') return await withTimeout(sap.pull(h.ID), 20000);
    return { hospitalId: h.ID, source: h.software, lots: 0, bookings: 0, skipped: 0, mode: 'push', note: 'Push-based feed (connector / sheet); nothing to pull' };
  } catch (e) {
    LOG.warn(`sync ${h.ID} failed: ${e.message}`);
    return { hospitalId: h.ID, source: h.software, lots: 0, bookings: 0, skipped: 0, mode: 'error', note: e.message };
  }
}

/** Pull every connected pull-based hospital (best effort, in parallel). */
async function syncAll({ only } = {}) {
  const hs = await SELECT.from('medilink.Hospitals').where({ connected: true });
  const targets = hs.filter(h => ['MEDISOFT', 'SAP_SANDBOX'].includes(h.software) && (!only || only.includes(h.ID)));
  const out = [];
  for (const h of targets) out.push(await syncHospital(h)); // sequential: SQLite single writer
  return out;
}

/** FR-07: grey out hospitals whose feed has been silent too long and alert their admin. */
async function detectStale(now = new Date(), digest) {
  const cutoff = new Date(now.getTime() - config.staleFeedMinutes * 60000).toISOString();
  const hs = await SELECT.from('medilink.Hospitals').where({ connected: true });
  const stale = [];
  for (const h of hs) {
    const isStale = !h.lastSyncedAt || new Date(h.lastSyncedAt).toISOString() < cutoff;
    if (isStale && !h.feedStale) {
      await UPDATE('medilink.Hospitals').set({ feedStale: true }).where({ ID: h.ID });
      await notify({ hospital: h.ID, kind: 'STALE_FEED', severity: 'HIGH', message: `No data from ${h.name} for over ${config.staleFeedMinutes} minutes; its stock is greyed out until the feed resumes (admin: ${h.adminEmail || 'n/a'})` }, { digest });
      await audit.log('system:stale-check', 'FEED_STALE', { hospital: h.ID, lastSyncedAt: h.lastSyncedAt });
      stale.push(h.ID);
    } else if (!isStale && h.feedStale) {
      await UPDATE('medilink.Hospitals').set({ feedStale: false }).where({ ID: h.ID });
    }
  }
  return stale;
}

/**
 * FR-10: renewal reminders before a licence expires (hospitals and partners): one per tier (LICENCE_REMINDER_DAYS days
 * left, then 7), not one a day; the reminder closes once the licence is renewed. Returns the licence IDs reminded now.
 */
async function licenceWatch(now = new Date(), digest) {
  const { reconcile, tierOf } = require('./monitor');
  const today = now.toISOString().slice(0, 10);
  const limit = new Date(now.getTime() + config.licenceReminderDays * 86400000).toISOString().slice(0, 10);
  const tiers = [...new Set([config.licenceReminderDays, 7])].sort((a, b) => b - a);
  const lics = await SELECT.from('medilink.Licences').where({ validTill: { between: today, and: limit } });
  const conds = lics.map(l => ({
    hospital: l.partyType === 'HOSPITAL' ? l.partyId : null, kind: 'LICENCE_EXPIRY', severity: 'MEDIUM', dedupeKey: `LIC:${l.ID}`, ref: `LIC:${l.ID}`,
    tier: tierOf(daysBetween(today, l.validTill), tiers), dueDate: String(l.validTill).slice(0, 10),
    message: `Licence ${l.licenceNo} (${l.partyType} ${l.partyId}) expires on ${l.validTill}; renew to keep sending/receiving stock`,
  }));
  const open = await SELECT.from('medilink.Notifications').where({ kind: 'LICENCE_EXPIRY', dedupeKey: { like: 'LIC:%' } });
  return (await reconcile(open, conds, digest)).raised.map(r => r.ref.slice(4));
}

module.exports = { syncHospital, syncAll, detectStale, licenceWatch };
