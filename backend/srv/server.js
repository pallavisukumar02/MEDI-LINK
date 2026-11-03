'use strict';
/*
 * MediLink CAP server bootstrap.
 *  - loads backend/.env (never printed); refuses to start without AUTH_JWT_SECRET / TOKEN_ENCRYPTION_KEY
 *  - refreshes the date-relative synthetic seed in development and tests
 *  - adds the non-OData endpoints: POST /ingest (connector token), POST /connector/pair,
 *    GET /oauth/medisoft/callback (OAuth 2.0 authorization-code redirect), GET /health
 *  - mounts the experience layer (GET /me/home, POST /me/actions/:id, ...) from lib/http-routes.js
 *  - /auth/* logins (lib/accounts.js); outside production, demo users on a database without users
 *  - /courier/* for delivery partners, authenticated by a per-delivery courier link, not a login (lib/courier.js)
 */
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env'), quiet: true });
const cds = require('@sap/cds');
const express = require('express');
const crypto = require('crypto');
const LOG = cds.log('medilink');

const profiles = cds.env.profiles || [];
const production = profiles.includes('production');
if ((profiles.includes('development') || profiles.includes('test')) && process.env.SEED_AUTO_REFRESH !== 'false') {
  try {
    const seed = require('../../seed/generate');
    if (seed.isStale()) seed.run({ quiet: true });
  } catch (e) { LOG.warn('seed refresh skipped:', e.message); }
}

const sha = s => crypto.createHash('sha256').update(s).digest('hex');
// Security headers on every response (audit F8). The UI has no inline script or style; tiles come from OSM only.
// Hand-rolled instead of helmet: six fixed headers do not justify a dependency.
const CSP = "default-src 'self'; img-src 'self' data: https://tile.openstreetmap.org; connect-src 'self' ws: wss:; script-src 'self'; style-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'";
function securityHeaders(req, res, next) {
  res.set({ 'Content-Security-Policy': CSP, 'Referrer-Policy': 'no-referrer', 'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY', 'Permissions-Policy': 'geolocation=(self), camera=(self), microphone=()' });
  if (req.secure) res.set('Strict-Transport-Security', 'max-age=31536000; includeSubDomains'); // HTTPS, or behind a proxy with TRUST_PROXY
  next();
}
/** Small server-rendered page; its one inline <style> / <script> is allowed by a per-response CSP nonce. */
function htmlPage(res, title, body) {
  const n = crypto.randomBytes(16).toString('base64');
  res.set('Content-Security-Policy', CSP.replace("script-src 'self'; style-src 'self'", `script-src 'self' 'nonce-${n}'; style-src 'self' 'nonce-${n}'`));
  return `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title><meta name="viewport" content="width=device-width,initial-scale=1"><style nonce="${n}">body{font-family:system-ui,sans-serif;max-width:32rem;margin:3rem auto;padding:0 1rem;color:#1d2d3e}h1{font-size:1.4rem}.ok{color:#107e3e}.bad{color:#bb0000}</style></head><body>${body.replaceAll('<script>', `<script nonce="${n}">`)}</body></html>`;
}

cds.on('bootstrap', app => {
  app.disable('x-powered-by');
  app.use(securityHeaders);
  const json = express.json({ limit: '5mb' });
  require('./lib/config').assertConfig(); // refuses to start without AUTH_JWT_SECRET / TOKEN_ENCRYPTION_KEY
  app.set('trust proxy', require('./lib/config').trustProxy); // TRUST_PROXY: req.ip is the client behind a reverse proxy
  const { limit, MIN } = require('./lib/ratelimit');
  require('./lib/accounts').mount(app); // POST /auth/login, /auth/logout, GET /auth/me, admin user management
  require('./lib/http-routes').mount(app); // /me/* experience layer, /health/integrations, /admin/metrics
  require('./lib/courier').mount(app); // /courier/* (Authorization: Courier <token>), public, rate-limited
  // UI (frontend/)
  const ui = path.join(__dirname, '..', '..', 'frontend');
  if (require('fs').existsSync(ui)) app.use(express.static(ui));
  app.get('/health', (_, res) => res.json({ status: 'UP', profile: profiles.join(','), synthetic: true, demoAccounts: process.env.NODE_ENV !== 'production', services: require('./lib/integrations').headline() })); // demo accounts are only ever seeded outside production

  // ---- IT handoff page linked from onboarding ("Waiting for your IT team") ----
  app.get('/connector/setup', (req, res) => {
    const h = String(req.query.hospital || '').replace(/[^A-Za-z0-9_-]/g, '');
    const base = require('./lib/config').appBaseUrl;
    res.send(htmlPage(res, 'MediLink connector setup', `<h1>MediLink read-only connector</h1>
<p>Hospital <b>${h || '(unknown)'}</b>. This small program reads two views from your pharmacy database, hashes patient IDs on your server, and pushes stock and chemo bookings to MediLink every 15 minutes. It never writes to your database.</p>
<ol><li>Create a read-only DB user that can <code>SELECT</code> from <code>medilink_stock_v</code> and <code>medilink_schedule_v</code>.</li>
<li>Install: <code>pip install -r connector/requirements.txt</code></li>
<li>Set <code>CONNECTOR_DB_URL</code> (any SQLAlchemy URL, e.g. <code>postgresql://medilink_ro:...@db-host/pharmacy</code>, <code>mysql+pymysql://...</code>, <code>mssql+pyodbc://...</code>), <code>PATIENT_REF_HASH_SALT</code> and <code>CONNECTOR_INGEST_URL=${base}/ingest</code>.</li>
<li>Run once with the pairing code your pharmacist received: <code>python connector.py --pair &lt;CODE&gt;</code>, then <code>python connector.py</code> (loop) or schedule <code>python connector.py --once</code>.</li></ol>
<p><small>The pairing code is single-use and expires after 24 hours. Revoke any time with "Disconnect" in MediLink.</small></p>`));
  });

  // ---- connector pairing: one-time code -> long-lived ingest token (stored hashed) ----
  app.post('/connector/pair', limit('pair', 10, 15 * MIN), json, async (req, res) => {
    try {
      const { pairingHash } = require('./handlers/onboarding');
      const code = String(req.body?.pairingCode || '').trim();
      if (!code) return res.status(400).json({ error: { code: 'PAIRING_CODE_REQUIRED' } });
      const out = await cds.tx(async () => {
        const row = await SELECT.one.from('medilink.PairingCodes').where({ codeHash: pairingHash(code) });
        if (!row || row.usedAt || new Date(row.expiresAt) < new Date()) return null;
        const token = crypto.randomBytes(32).toString('hex');
        const now = new Date().toISOString();
        await UPDATE('medilink.PairingCodes').set({ usedAt: now }).where({ codeHash: row.codeHash });
        await INSERT.into('medilink.ConnectorTokens').entries({ tokenHash: sha(token), hospital_ID: row.hospital_ID, createdAt: now });
        await INSERT.into('medilink.Consents').entries({ ID: cds.utils.uuid(), hospital_ID: row.hospital_ID, provider: 'CONNECTOR', scopes: 'stock.read schedule.read', grantedBy: 'hospital-it (pairing code)', grantedAt: now });
        await UPDATE('medilink.Hospitals').set({ connected: true }).where({ ID: row.hospital_ID });
        await require('./lib/audit').log('hospital-it:' + row.hospital_ID, 'CONSENT_GRANTED', { hospital: row.hospital_ID, provider: 'CONNECTOR', scopes: 'stock.read schedule.read' });
        return { token, hospitalId: row.hospital_ID };
      });
      if (!out) return res.status(401).json({ error: { code: 'PAIRING_CODE_INVALID', message: 'Pairing code unknown, used or expired' } });
      res.json({ ...out, ingestUrl: `${require('./lib/config').appBaseUrl}/ingest` });
    } catch (e) { LOG.error('pair failed', e.message); res.status(500).json({ error: { code: 'PAIR_FAILED' } }); }
  });

  // ---- POST /ingest: token-authenticated snapshot push from the connector ----
  app.post('/ingest', limit('ingest', 60, MIN), json, async (req, res) => {
    const m = /^Bearer\s+([a-f0-9]{64})$/i.exec(req.headers.authorization || '');
    if (!m) return res.status(401).json({ error: { code: 'CONNECTOR_TOKEN_REQUIRED' } });
    try {
      const { ingestSnapshot } = require('./lib/ingest');
      const result = await cds.tx(async () => {
        const tok = await SELECT.one.from('medilink.ConnectorTokens').where({ tokenHash: sha(m[1].toLowerCase()) });
        if (!tok || tok.revokedAt) return { denied: true };
        return ingestSnapshot(tok.hospital_ID, 'CONNECTOR', { lots: req.body?.lots, bookings: req.body?.bookings }, { actor: 'connector:' + tok.hospital_ID });
      });
      if (result.denied) return res.status(401).json({ error: { code: 'CONNECTOR_TOKEN_INVALID' } });
      res.json(result);
    } catch (e) {
      if (e.status) return res.status(e.status).json({ error: { code: e.code, message: e.message } });
      LOG.error('ingest failed', e.message); res.status(500).json({ error: { code: 'INGEST_FAILED' } });
    }
  });

  // ---- OAuth 2.0 authorization-code callback from MediSoft ----
  app.get('/oauth/medisoft/callback', async (req, res) => {
    const { code, state, error } = req.query;
    try {
      const medisoft = require('./lib/medisoft');
      const tokens = require('./lib/tokens');
      const audit = require('./lib/audit');
      const out = await cds.tx(async () => {
        const st = state && await SELECT.one.from('medilink.OAuthStates').where({ state: String(state) });
        if (!st || new Date(st.expiresAt) < new Date()) return { status: 400, html: '<h1 class="bad">Link expired</h1><p>Please start again from MediLink.</p>' };
        await DELETE.from('medilink.OAuthStates').where({ state: st.state });
        if (error) {
          await audit.log(st.userId, 'CONSENT_DENIED', { hospital: st.hospital_ID, provider: 'MEDISOFT', error: String(error) });
          return { status: 200, html: '<h1>Not connected</h1><p>You chose not to allow MediLink. Nothing was shared.</p>' };
        }
        const t = await medisoft.exchangeCode(String(code), st.codeVerifier);
        if (t.tenant && t.tenant !== st.hospital_ID) return { status: 403, html: '<h1 class="bad">Wrong hospital</h1><p>The MediSoft account you signed in with belongs to another hospital.</p>' };
        await tokens.store().save(st.hospital_ID, medisoft.PROVIDER, t);
        const now = new Date().toISOString();
        await INSERT.into('medilink.Consents').entries({ ID: cds.utils.uuid(), hospital_ID: st.hospital_ID, provider: 'MEDISOFT', scopes: t.scope, grantedBy: st.userId, grantedAt: now });
        await UPDATE('medilink.Hospitals').set({ connected: true }).where({ ID: st.hospital_ID });
        await audit.log(st.userId, 'CONSENT_GRANTED', { hospital: st.hospital_ID, provider: 'MEDISOFT', scopes: t.scope, tokenStore: tokens.store().kind });
        return { hospital: st.hospital_ID };
      });
      if (out.html) return res.status(out.status).send(htmlPage(res, 'MediLink', out.html));
      const r = await cds.tx(() => medisoft.pull(out.hospital)).catch(e => ({ mode: 'error', note: e.message }));
      res.send(htmlPage(res, 'MediLink connected', `<h1 class="ok">Done.</h1><p>Your board will be ready in a few minutes.</p><p><small>First sync: ${r.lots ?? 0} lots, ${r.bookings ?? 0} bookings.</small></p><script>try{window.opener&&window.opener.postMessage({medilink:'connected',hospital:${JSON.stringify(out.hospital)}},${JSON.stringify(new URL(require('./lib/config').appBaseUrl).origin)})}catch(e){}</script>`));
    } catch (e) {
      LOG.error('oauth callback failed:', e.message);
      res.status(502).send(htmlPage(res, 'MediLink', '<h1 class="bad">Could not connect</h1><p>MediSoft did not issue a token. Please try again.</p>'));
    }
  });
});

cds.on('served', async () => {
  const db = await cds.connect.to('db');
  require('./lib/audit').guard(db);
  await require('./lib/db-upgrade').upgrade(db).catch(e => LOG.warn('database upgrade skipped:', e.message)); // older database files: add new tables / columns
  const hasUsers = await cds.tx(() => SELECT.one.from('medilink.Users').columns('username')).catch(e => {
    throw new Error(`The database has no MediLink tables yet (${e.message.split('\n')[0]}). Run: npm run db:init`);
  });
  if (!hasUsers) { // a new in-memory or empty database: demo users, never in production
    const r = production ? { reason: 'this is production' } : await require('./lib/accounts').seedDemoUsers();
    if (r.created) LOG.info(`created ${r.created} demo users (password from DEMO_PASSWORD)`);
    else LOG.warn(`no users yet and ${r.reason}: nobody can sign in. Run npm run db:init with DEMO_PASSWORD set.`);
  }
  if (production) { // a database made by npm run dev still has demo users with the development password: never serve it
    const open = await require('./lib/accounts').demoUsersWithDevPassword();
    if (open.length) throw new Error(`MediLink cannot start in production: demo accounts still use the development password "demo" (${open.join(', ')}). Disable them or reset their passwords (POST /auth/users/<name>/disable or /reset-password) in a development run, or run npm run db:reset with a strong DEMO_PASSWORD.`);
  }
  // seeded deliveries skipped assignPartner, so they get their courier link here (demo data only, never in production)
  if (!production) await cds.tx({ user: cds.User.privileged }, () => require('./lib/courier').ensureLinks()).catch(e => LOG.warn('courier links for seeded deliveries skipped:', e.message));
  const config = require('./lib/config');
  if (profiles.includes('development') && config.demoFreshSeed) {
    // Seeded hospitals count as freshly synced at startup so the demo board is not greyed out.
    await UPDATE('medilink.Hospitals').set({ lastSyncedAt: new Date().toISOString(), feedStale: false }).where({ connected: true });
  }
  if (!profiles.includes('test')) require('./lib/jobs').start();
});

module.exports = cds.server;
