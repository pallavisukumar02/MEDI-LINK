'use strict';
/*
 * Standalone mode (no SAP BTP): MediLink accounts replace XSUAA, the local encrypted store replaces the Destination
 * service, built-in approvals replace BPA. Login / logout / JWT expiry and tampering, generic wrong-password message,
 * rate limiting, the existing role + hospital restrictions under custom auth, admin user management, WebSocket auth,
 * token store round trip + tampering, /health and /health/integrations in standalone words.
 */
require('./helpers/env')({ CDS_ENV: 'standalone', CDS_REQUIRES_DB_CREDENTIALS_URL: ':memory:', DEMO_PASSWORD: 'demo-pass-123' });
const cds = require('@sap/cds');
const jwt = require('jsonwebtoken');
const WebSocket = require('ws');
const T = cds.test(__dirname + '/..');
T.axios.defaults.validateStatus = () => true;
const config = require('../srv/lib/config');
const accounts = require('../srv/lib/accounts');

const PW = 'demo-pass-123';
const login = (username, password = PW) => T.axios.post('/auth/login', { username, password });
const bearer = token => ({ headers: { Authorization: 'Bearer ' + token } });
const tokenOf = async (u, pw) => (await login(u, pw)).data.token;
const withEnv = async (env, fn) => {
  const old = Object.fromEntries(Object.keys(env).map(k => [k, process.env[k]]));
  Object.assign(process.env, env); config.reload();
  try { return await fn(); } finally { for (const [k, v] of Object.entries(old)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } config.reload(); }
};
afterEach(() => accounts._failures.clear());

describe('login, logout, tokens', () => {
  test('demo users exist with DEMO_PASSWORD; login returns a signed JWT and the same role + hospital as xs-security.json', async () => {
    const r = await login('asha');
    expect(r.status).toBe(200);
    expect(r.data).toMatchObject({ tokenType: 'Bearer', user: { username: 'asha', role: 'pharmacist', hospital: 'H1', partner: null } });
    const p = jwt.verify(r.data.token, process.env.AUTH_JWT_SECRET, { algorithms: ['HS256'] });
    expect(p).toMatchObject({ sub: 'asha', role: 'pharmacist', iss: 'medilink' });
    expect(p.exp - p.iat).toBe(8 * 3600); // AUTH_JWT_TTL default
    expect(JSON.stringify(r.data)).not.toMatch(/passwordHash|\$2[ab]\$/);
    expect((await T.axios.get('/auth/me', bearer(r.data.token))).data).toMatchObject({ username: 'asha', role: 'pharmacist', hospital: 'H1' });
    const home = await T.axios.get('/me/home', bearer(r.data.token));
    expect(home.status).toBe(200);
    expect(home.data.user.role).toBe('pharmacist');
  });

  test('wrong password and unknown user get the same generic message', async () => {
    const a = await login('asha', 'nope-nope');
    const b = await login('nobody-here', 'nope-nope');
    expect(a.status).toBe(401);
    expect(a.data).toEqual({ code: 'LOGIN_FAILED', title: 'Wrong username or password', message: expect.any(String), fix: expect.any(String), retryable: false });
    expect(b.data).toEqual(a.data);
    expect((await T.axios.post('/auth/login', '{not json', { headers: { 'Content-Type': 'application/json' } })).data.code).toBe('INVALID_INPUT');
  });

  test('after 5 wrong passwords the account is paused, even for the right password', async () => {
    for (let i = 0; i < 5; i++) expect((await login('lata', 'wrong-' + i)).status).toBe(401);
    const r = await login('lata');
    expect(r.status).toBe(429);
    expect(r.data).toMatchObject({ code: 'TOO_MANY_LOGIN_ATTEMPTS', fix: expect.stringMatching(/15 minutes/) });
    expect((await T.axios.get('/me/home', { auth: { username: 'lata', password: PW } })).status).toBe(429); // Basic shares the limit
    expect((await login('sunil')).status).toBe(200); // other accounts unaffected
  });

  test('logout ends the token; expired, tampered and foreign-secret tokens are refused', async () => {
    const t = await tokenOf('ravi');
    expect((await T.axios.post('/auth/logout', null, bearer(t))).data).toEqual({ ok: true, message: 'You are signed out.' });
    const after = await T.axios.get('/me/home', bearer(t));
    expect(after.status).toBe(401);
    expect(after.data.code).toBe('SESSION_EXPIRED');

    const live = await tokenOf('ravi');
    const p = jwt.decode(live);
    const now = Math.floor(Date.now() / 1000);
    const expired = jwt.sign({ ...p, iat: now - 100, exp: now - 10 }, process.env.AUTH_JWT_SECRET, { algorithm: 'HS256' });
    const forged = jwt.sign({ ...p, role: 'admin' }, 'some-other-secret-0123456789abcdef0123', { algorithm: 'HS256' });
    const none = jwt.sign({ ...p, role: 'admin' }, null, { algorithm: 'none' });
    for (const bad of [expired, forged, none, live.slice(0, -2) + 'xx']) expect((await T.axios.get('/me/home', bearer(bad))).status).toBe(401);
    expect((await T.axios.get('/me/home', bearer(live))).status).toBe(200);
  });

  test('AUTH_JWT_TTL sets the expiry', () => {
    expect(accounts.ttlSeconds('30m')).toBe(1800);
    expect(accounts.ttlSeconds('2d')).toBe(172800);
    expect(accounts.ttlSeconds('900')).toBe(900);
    expect(accounts.ttlSeconds('soon')).toBe(8 * 3600);
  });
});

describe('roles and hospitals work unchanged under MediLink accounts', () => {
  test('hospital attribute, role checks and admin-only routes', async () => {
    const ravi = bearer(await tokenOf('ravi'));
    expect((await T.axios.get("/odata/v4/cover/board(window=14,hospital='H5')", ravi)).status).toBe(200);
    expect((await T.axios.get("/odata/v4/cover/board(window=14,hospital='H2')", ravi)).status).toBe(403);
    expect((await T.axios.post('/odata/v4/approval/approveTransfer', { transfer: 'a0000000-0000-4000-8000-000000000001' }, ravi)).status).toBe(403);
    expect((await T.axios.get('/health/integrations', ravi)).status).toBe(403);
    expect((await T.axios.get('/odata/v4/cover/board(window=14)')).status).toBe(401); // anonymous
    const admin = bearer(await tokenOf('admin'));
    expect((await T.axios.get("/odata/v4/cover/board(window=14,hospital='H2')", admin)).status).toBe(200);
    const partner = bearer(await tokenOf('courier2'));
    expect((await T.axios.get('/me/home', partner)).data.user.role).toBe('partner');
  });

  test('scripts may use HTTP Basic with the same account', async () => {
    expect((await T.axios.get('/me/home', { auth: { username: 'meera', password: PW } })).status).toBe(200);
    expect((await T.axios.get('/me/home', { auth: { username: 'meera', password: 'demo' } })).status).toBe(401);
  });
});

describe('admin user management', () => {
  test('create, sign in, reset password (old sessions end), disable, enable', async () => {
    const admin = bearer(await tokenOf('admin'));
    const asha = bearer(await tokenOf('asha'));
    const nina = { username: 'Nina.R', password: 'first-pass-1', role: 'pharmacist', hospital: 'H3' };
    expect((await T.axios.post('/auth/users', nina, asha)).status).toBe(403);
    expect((await T.axios.post('/auth/users', { ...nina, password: 'short' }, admin)).data).toMatchObject({ code: 'WEAK_PASSWORD', message: expect.stringMatching(/at least 8/) });
    expect((await T.axios.post('/auth/users', { ...nina, hospital: 'H99' }, admin)).data.code).toBe('INVALID_INPUT');
    expect((await T.axios.post('/auth/users', { ...nina, role: 'superuser' }, admin)).data.code).toBe('INVALID_INPUT');
    const c = await T.axios.post('/auth/users', nina, admin);
    expect(c.status).toBe(201);
    expect(c.data).toEqual({ username: 'nina.r', role: 'pharmacist', hospital: 'H3', partner: null, disabled: false });
    expect((await T.axios.post('/auth/users', nina, admin)).status).toBe(409);

    const t1 = await tokenOf('nina.r', 'first-pass-1'), t1b = await (async () => { const r = await login('NINA.R', 'first-pass-1'); return r.data.token; })();
    expect((await T.axios.get('/auth/me', bearer(t1))).data).toMatchObject({ username: 'nina.r', hospital: 'H3' });
    expect((await T.axios.post('/auth/users/nina.r/reset-password', { password: 'second-pass-2' }, admin)).status).toBe(200);
    for (const t of [t1, t1b]) expect((await T.axios.get('/me/home', bearer(t))).status).toBe(401);
    expect((await login('nina.r', 'first-pass-1')).status).toBe(401);
    const t2 = await tokenOf('nina.r', 'second-pass-2');

    expect((await T.axios.post('/auth/users/nina.r/disable', null, admin)).data.disabled).toBe(true);
    expect((await T.axios.get('/me/home', bearer(t2))).status).toBe(401);
    expect((await login('nina.r', 'second-pass-2')).data.code).toBe('LOGIN_FAILED'); // disabled looks like a wrong password
    expect((await T.axios.post('/auth/users/admin/disable', null, admin)).data.code).toBe('CANNOT_DISABLE_SELF');
    expect((await T.axios.post('/auth/users/ghost/disable', null, admin)).status).toBe(404);
    await T.axios.post('/auth/users/nina.r/enable', null, admin);
    expect((await login('nina.r', 'second-pass-2')).status).toBe(200);
    const list = (await T.axios.get('/auth/users', admin)).data.users;
    expect(list.find(u => u.username === 'partner')).toEqual({ username: 'partner', role: 'partner', hospital: null, partner: 'P1', disabled: false });
    expect(JSON.stringify(list)).not.toMatch(/passwordHash|\$2[ab]\$/);
  });
});

describe('WebSocket', () => {
  const open = url => new Promise(resolve => {
    const ws = new WebSocket(url);
    ws.on('open', () => { ws.close(); resolve('open'); });
    ws.on('error', () => resolve('refused'));
    ws.on('unexpected-response', () => resolve('refused'));
    ws.on('close', () => resolve('refused'));
  });
  test('accepts the JWT as ?access_token=, refuses missing or bad tokens', async () => {
    const base = `ws://localhost:${cds.app.server.address().port}/ws/tracking`;
    const t = await tokenOf('partner');
    expect(await open(`${base}?access_token=${t}`)).toBe('open');
    expect(await open(base)).toBe('refused');
    expect(await open(`${base}?access_token=${t.slice(0, -3)}abc`)).toBe('refused');
  });
});

describe('encrypted hospital token store', () => {
  const tokens = require('../srv/lib/tokens');
  test('standalone always uses the local AES-256-GCM store; round trip, tampering and row swapping fail closed', async () => {
    expect(tokens.store().kind).toBe('local');
    await withEnv({ TOKEN_STORE: 'destination' }, async () => expect(tokens.store().kind).toBe('local'));
    const t = { access_token: 'at-secret', refresh_token: 'rt-secret', expires_at: 1 };
    await cds.tx(() => tokens.store().save('H1', 'MEDISOFT', t));
    const row = await cds.tx(() => SELECT.one.from('medilink.TokenVault').where({ hospital_ID: 'H1', provider: 'MEDISOFT' }));
    expect(row.ciphertext).not.toMatch(/secret/);
    expect(await cds.tx(() => tokens.store().get('H1', 'MEDISOFT'))).toEqual(t);

    const [iv, tag, data] = row.ciphertext.split('.');
    const flipped = Buffer.from(data, 'base64'); flipped[0] ^= 1;
    await cds.tx(() => UPDATE('medilink.TokenVault').set({ ciphertext: [iv, tag, flipped.toString('base64')].join('.') }).where({ hospital_ID: 'H1', provider: 'MEDISOFT' }));
    expect(await cds.tx(() => tokens.store().get('H1', 'MEDISOFT'))).toBeNull();

    await cds.tx(() => UPSERT.into('medilink.TokenVault').entries({ hospital_ID: 'H5', provider: 'MEDISOFT', ciphertext: row.ciphertext, updatedAt: new Date().toISOString() }));
    expect(await cds.tx(() => tokens.store().get('H5', 'MEDISOFT'))).toBeNull(); // bound to H1
    await cds.tx(() => tokens.store().remove('H5', 'MEDISOFT'));
    await cds.tx(() => tokens.store().remove('H1', 'MEDISOFT'));
  });

  test('without TOKEN_ENCRYPTION_KEY nothing is stored with a made-up key', async () => {
    await withEnv({ TOKEN_ENCRYPTION_KEY: '', TOKEN_STORE_KEY: '' }, async () => {
      await expect(cds.tx(() => tokens.store().save('H1', 'MEDISOFT', { access_token: 'x' }))).rejects.toThrow(/TOKEN_ENCRYPTION_KEY/);
    });
  });
});

describe('switches and health in standalone words', () => {
  test('APPROVAL_MODE=bpa and LLM_PROVIDER=aicore are ignored; Alert Notification never used', async () => {
    await withEnv({ APPROVAL_MODE: 'bpa', LLM_PROVIDER: 'aicore', ALERT_NOTIFICATION_ENABLED: 'true' }, async () => {
      expect(config.approvalMode).toBe('cap');
      expect(config.llmProvider).toBe('none');
      expect(require('../srv/lib/notify').channel()).toBe('console');
    });
  });

  test('/health and /health/integrations say standalone clearly', async () => {
    const h = (await T.axios.get('/health')).data;
    expect(h).toMatchObject({ status: 'UP', mode: 'standalone', services: 'Database: SQLite (in memory) (standalone) · Logins: MediLink accounts · Approvals: built-in · Email: off · AI: off' });
    const r = (await T.axios.get('/health/integrations', bearer(await tokenOf('admin')))).data;
    expect(r).toMatchObject({ mode: 'standalone', approvalMode: 'cap', headline: h.services });
    const item = n => r.items.find(i => i.service.startsWith(n));
    expect(item('Logins')).toMatchObject({ status: 'connected', mode: 'medilink-accounts' });
    expect(item('Approvals')).toMatchObject({ status: 'connected', text: expect.stringMatching(/^Built-in approvals/) });
    expect(item('Database')).toMatchObject({ status: 'connected', mode: 'sqlite' });
    expect(item('Email alerts')).toMatchObject({ status: 'fallback', mode: 'in-app' });
    expect(r.items.some(i => /^SAP (HANA|XSUAA|Destination|Build|AI Core|Alert)/.test(i.service))).toBe(false);
    expect(JSON.stringify(r)).not.toMatch(/test-jwt-secret|test-token-encryption-key|demo-pass-123/);
  });
});
