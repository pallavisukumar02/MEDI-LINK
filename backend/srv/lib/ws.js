'use strict';
/*
 * Live push over the WebSocket TrackingService (@cap-js-community/websocket), filtered per user:
 * each socket joins contexts for its own hospital / role on connect (handlers/tracking.js), and
 * every event goes only to the supplying and receiving hospital of that transfer (plus admins).
 * "tracking" (live position, temperature, ETA) goes to the receiver and admins; the supplier gets a status-only copy.
 * After each status / excursion / re-plan event, and when a tracking step changes, a "journey.updated" event carries
 * the same journey shape GET /me/home returns, built for each party's point of view, so a UI just replaces its card.
 * Delivery happens after the surrounding transaction commits (no-op when the service is not served, e.g. unit tests).
 */
const cds = require('@sap/cds');
const LOG = cds.log('ws');
const listeners = new Set(); // in-process listeners (used by tests): (event, data) => void
const TRANSFER_EVENTS = new Set(['excursion', 'replan', 'status']);
const RECEIVER_ONLY = new Set(['tracking']);
const ROLES = ['pharmacist', 'approver'];

/** Contexts a user's socket may join. */
function contextsFor(user) {
  const attr = k => { const v = user?.attr?.[k]; return Array.isArray(v) ? v[0] : v; };
  const out = [];
  if (user?.is?.('admin')) out.push('admin');
  const h = attr('hospital');
  if (h) { out.push(`hospital:${h}`); for (const r of ROLES) if (user.is(r)) out.push(`hospital:${h}:${r}`); }
  return out;
}

/** Contexts an event is delivered to. t = transfer parties (or null). */
function audience(event, data, t) {
  const c = new Set(['admin']);
  if (t) {
    c.add(`hospital:${t.receiver_ID}`);
    if (!RECEIVER_ONLY.has(event)) c.add(`hospital:${t.supplier_ID}`);
  } else if (data?.hospitalId) c.add(`hospital:${data.hospitalId}`);
  return [...c];
}

/** Everyone who sees a journey card for this transfer, with the point of view to build it from. */
function journeyViewers(t) {
  const v = [{ context: 'admin', viewer: { role: 'admin' } }];
  for (const [h, side] of [[t.receiver_ID, 'receiver'], [t.supplier_ID, 'supplier']]) {
    for (const role of ROLES) v.push({ context: `hospital:${h}:${role}`, viewer: { role, hospitalId: h, side } });
  }
  return v;
}

async function deliver(srv, event, data, opts = {}) {
  cds.context = { user: cds.User.privileged }; // system push: CAP checks @requires even on local emits
  const t = data?.transferId ? await cds.tx(() => SELECT.one.from('medilink.Transfers').columns('ID', 'request_ID', 'supplier_ID', 'receiver_ID').where({ ID: data.transferId })) : null;
  await srv.emit(event, data, { contexts: audience(event, data, t) });
  if (t && RECEIVER_ONLY.has(event)) await srv.emit(event, { transferId: data.transferId, requestId: data.requestId, status: data.status }, { contexts: [`hospital:${t.supplier_ID}`] });
  if (!t || !(TRANSFER_EVENTS.has(event) || opts.journey)) return;
  const journey = require('./journey');
  for (const { context, viewer } of journeyViewers(t)) {
    const j = await cds.tx(() => journey.forId(t.request_ID || t.ID, viewer)).catch(e => LOG.debug('journey build failed', e.message));
    // CAP registers handlers of a dotted event under its last segment; the socket still receives "journey.updated"
    if (j) await srv.emit('updated', { journeyId: j.id, perspective: j.perspective, journey: j }, { contexts: [context] });
  }
}

/** opts.journey: also push journey.updated (a tracking step changed). */
function emit(event, data, opts) {
  for (const l of listeners) { try { l(event, data); } catch { /* ignore */ } }
  const srv = cds.services.TrackingService;
  if (!srv) return;
  const run = () => deliver(srv, event, data, opts).catch(e => LOG.debug('emit failed', e.message));
  const ctx = cds.context;
  // wait for the commit so the data (and the journey built from it) is what everyone else will read
  if (ctx?.tx && typeof ctx.on === 'function') {
    ctx.emitter?.setMaxListeners?.(0); // one transaction may raise many alerts (stock monitor): a listener each is expected
    ctx.on('succeeded', () => setImmediate(run));
  } else setImmediate(run);
}

module.exports = { emit, listeners, contextsFor, audience, journeyViewers };
