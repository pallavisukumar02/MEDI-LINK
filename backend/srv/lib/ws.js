'use strict';
// Fire-and-forget emit to the WebSocket TrackingService (no-op if it is not served, e.g. in unit tests).
const cds = require('@sap/cds');
const listeners = new Set(); // in-process listeners (used by tests)

function emit(event, data) {
  for (const l of listeners) { try { l(event, data); } catch { /* ignore */ } }
  const srv = cds.services.TrackingService;
  if (!srv) return;
  Promise.resolve().then(() => srv.emit(event, data)).catch(e => cds.log('ws').debug('emit failed', e.message));
}
module.exports = { emit, listeners };
