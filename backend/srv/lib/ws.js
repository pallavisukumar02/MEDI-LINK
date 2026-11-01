'use strict';
/*
 * Live push over the WebSocket TrackingService (@cap-js-community/websocket), filtered per user:
 * each socket joins contexts for its own hospital / partner / role on connect (handlers/tracking.js), and
 * every event goes only to the supplier, receiver and partner of that transfer (plus admins).
 * After each transfer event a "journey.updated" event carries the same journey shape GET /me/home returns,
 * built for each party's point of view, so a UI just replaces the card it shows.
 * Delivery happens after the surrounding transaction commits (no-op when the service is not served, e.g. unit tests).
 */
const cds = require('@sap/cds');
const LOG = cds.log('ws');
const listeners = new Set(); // in-process listeners (used by tests): (event, data) => void
const TRANSFER_EVENTS = new Set(['telemetry', 'excursion', 'replan', 'status']);
const ROLES = ['pharmacist', 'approver'];

/** Contexts a user's socket may join. */
function contextsFor(user) {
  const attr = k => { const v = user?.attr?.[k]; return Array.isArray(v) ? v[0] : v; };
  const out = [];
  if (user?.is?.('admin')) out.push('admin');
  const h = attr('hospital'), p = attr('partner');
  if (h) { out.push(`hospital:${h}`); for (const r of ROLES) if (user.is(r)) out.push(`hospital:${h}:${r}`); }
  if (p && user.is('partner')) out.push(`partner:${p}`);
  return out;
}

/** Contexts an event is delivered to. t = transfer parties (or null). */
function audience(event, data, t) {
  const c = new Set(['admin']);
  if (t) {
    c.add(`hospital:${t.supplier_ID}`); c.add(`hospital:${t.receiver_ID}`);
    if (t.partner_ID) c.add(`partner:${t.partner_ID}`);
  } else if (data?.hospitalId) c.add(`hospital:${data.hospitalId}`);
  return [...c];
}

/** Everyone who sees a journey card for this transfer, with the point of view to build it from. */
function journeyViewers(t) {
  const v = [{ context: 'admin', viewer: { role: 'admin' } }];
  for (const [h, side] of [[t.receiver_ID, 'receiver'], [t.supplier_ID, 'supplier']]) {
    for (const role of ROLES) v.push({ context: `hospital:${h}:${role}`, viewer: { role, hospitalId: h, side } });
  }
  if (t.partner_ID) v.push({ context: `partner:${t.partner_ID}`, viewer: { role: 'partner', partnerId: t.partner_ID } });
  return v;
}

async function deliver(srv, event, data) {
  cds.context = { user: cds.User.privileged }; // system push: CAP checks @requires even on local emits
  const t = data?.transferId ? await cds.tx(() => SELECT.one.from('medilink.Transfers').columns('ID', 'request_ID', 'supplier_ID', 'receiver_ID', 'partner_ID').where({ ID: data.transferId })) : null;
  await srv.emit(event, data, { contexts: audience(event, data, t) });
  if (!t || !TRANSFER_EVENTS.has(event)) return;
  const journey = require('./journey');
  for (const { context, viewer } of journeyViewers(t)) {
    const j = await cds.tx(() => journey.forId(t.request_ID || t.ID, viewer)).catch(e => LOG.debug('journey build failed', e.message));
    // CAP registers handlers of a dotted event under its last segment; the socket still receives "journey.updated"
    if (j) await srv.emit('updated', { journeyId: j.id, perspective: j.perspective, journey: j }, { contexts: [context] });
  }
}

function emit(event, data) {
  for (const l of listeners) { try { l(event, data); } catch { /* ignore */ } }
  const srv = cds.services.TrackingService;
  if (!srv) return;
  const run = () => deliver(srv, event, data).catch(e => LOG.debug('emit failed', e.message));
  const ctx = cds.context;
  // wait for the commit so the data (and the journey built from it) is what everyone else will read
  if (ctx?.tx && typeof ctx.on === 'function') ctx.on('succeeded', () => setImmediate(run));
  else setImmediate(run);
}

module.exports = { emit, listeners, contextsFor, audience, journeyViewers };
