'use strict';
// OAuth 2.0 authorization-code client for the (mock) MediSoft HIS + read-only stock/schedule puller.
const cds = require('@sap/cds');
const config = require('./config');
const http = require('./http');
const tokens = require('./tokens');
const { ingestSnapshot } = require('./ingest');

const PROVIDER = 'MEDISOFT';
const basic = () => 'Basic ' + Buffer.from(`${config.medisoft.clientId}:${config.medisoft.clientSecret}`).toString('base64');

function authorizeUrl(state) {
  const m = config.medisoft;
  const q = http.form({ response_type: 'code', client_id: m.clientId, redirect_uri: m.redirectUri, scope: m.scopes, state });
  return `${m.baseUrl}/oauth/authorize?${q}`;
}

async function tokenRequest(params) {
  const res = await http.request(`${config.medisoft.baseUrl}/oauth/token`, {
    method: 'POST', headers: { Authorization: basic(), 'Content-Type': 'application/x-www-form-urlencoded' }, body: http.form(params),
  });
  if (res.status !== 200) {
    const err = new Error(`MediSoft token endpoint returned ${res.status} (${res.json?.error || 'error'})`);
    err.status = 502; err.code = 'MEDISOFT_TOKEN_FAILED'; throw err;
  }
  const t = res.json;
  return { access_token: t.access_token, refresh_token: t.refresh_token, scope: t.scope, expires_at: Date.now() + (t.expires_in || 3600) * 1000, tenant: t.tenant };
}
const exchangeCode = code => tokenRequest({ grant_type: 'authorization_code', code, redirect_uri: config.medisoft.redirectUri });
const refresh = rt => tokenRequest({ grant_type: 'refresh_token', refresh_token: rt }).then(t => ({ ...t, refresh_token: t.refresh_token || rt })); // keep it if not rotated

async function revoke(token) {
  try {
    await http.request(`${config.medisoft.baseUrl}/oauth/revoke`, { method: 'POST', headers: { Authorization: basic(), 'Content-Type': 'application/x-www-form-urlencoded' }, body: http.form({ token }) });
  } catch { /* best effort; local token is deleted regardless */ }
}

async function apiGet(hospitalId, path, t) {
  if (t.refresh_token && t.expires_at && t.expires_at < Date.now() + 60000) { // refresh shortly before expiry
    Object.assign(t, await refresh(t.refresh_token));
    await tokens.store().save(hospitalId, PROVIDER, t);
  }
  let res = await http.request(`${config.medisoft.baseUrl}${path}`, { headers: { Authorization: 'Bearer ' + t.access_token } });
  if (res.status === 401 && t.refresh_token) {
    const nt = await refresh(t.refresh_token);
    Object.assign(t, nt);
    await tokens.store().save(hospitalId, PROVIDER, t);
    res = await http.request(`${config.medisoft.baseUrl}${path}`, { headers: { Authorization: 'Bearer ' + t.access_token } });
  }
  if (res.status !== 200) { const e = new Error(`MediSoft ${path} returned ${res.status}`); e.status = 502; throw e; }
  return res.json;
}

/** Pull stock + chemo schedule for one hospital using its stored token. */
async function pull(hospitalId) {
  const t = await tokens.store().get(hospitalId, PROVIDER);
  if (!t) return { hospitalId, source: PROVIDER, lots: 0, bookings: 0, skipped: 0, mode: 'no-token', note: 'Not connected (no stored token)' };
  const stock = await apiGet(hospitalId, '/api/stock', t);
  const schedule = await apiGet(hospitalId, '/api/schedule', t);
  const lots = (stock.items || []).map(s => ({ lotRef: s.lotRef, generic: s.generic, strength: s.strength, form: s.form, brandName: s.brand, manufacturer: s.manufacturer, batchNo: s.batch, quantity: s.qty, expiryDate: s.expiry, storageClass: s.storage, sealed: s.sealed }));
  const bookings = (schedule.items || []).map(b => ({ bookingId: b.appointmentId, patientRef: b.patientRef, generic: b.generic, strength: b.strength, form: b.form, doseUnits: b.units, scheduledDate: b.date, intent: b.intent }));
  const r = await ingestSnapshot(hospitalId, PROVIDER, { lots, bookings }, { actor: 'system:medisoft-sync' });
  return { ...r, mode: 'live' };
}

module.exports = { PROVIDER, authorizeUrl, exchangeCode, refresh, revoke, pull };
