'use strict';
/*
 * Standalone mode logins (replaces SAP XSUAA). Only mounted / used with the standalone profiles.
 *   POST /auth/login {username, password} -> { token (JWT, HS256), expiresAt, user }
 *   POST /auth/logout (Bearer)             -> the token stops working
 *   GET  /auth/me                          -> who am I
 *   admin: GET /auth/users · POST /auth/users · POST /auth/users/:username/reset-password|disable|enable
 * Users get exactly one role of xs-security.json (pharmacist, approver, partner, admin, system) and the matching
 * hospital / partner attribute, so every @requires / @restrict and hospitalOf() check works unchanged.
 * Each JWT has a row in medilink.Sessions; logout, disable and password reset delete rows, so tokens can be revoked.
 * Scripts and the simulator may also send HTTP Basic with the same account (same checks and rate limit).
 * Passwords and tokens are never logged.
 */
const cds = require('@sap/cds');
const crypto = require('crypto');
const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const config = require('./config');
const messages = require('./messages');
const LOG = cds.log('auth');

const ROLES = ['pharmacist', 'approver', 'partner', 'admin', 'system'];
const COST = 10;
const MIN_PASSWORD = 8;
const ISSUER = 'medilink';
const DUMMY_HASH = bcrypt.hashSync('timing-equaliser', COST); // compare against something even for unknown users

const fail = (status, code, params) => Object.assign(new Error(code), { status, code, params });
const reply = (res, e) => { const { status, body } = messages.fromError(e, e.params); if (status >= 500) LOG.error(body.code, e.message); res.status(status).json(body); };
const db = fn => cds.tx({ user: cds.User.privileged }, fn);

// ---------------------------------------------------------------- rate limit
// Per username, not per IP: behind a proxy IPs are shared or spoofable. 5 wrong passwords pause that account 15 min.
// shortcut: in-memory, per process; with several app instances move the counters to the database.
const WINDOW_MS = 15 * 60 * 1000, MAX_FAILURES = 5;
const failures = new Map(); // username -> [timestamps]
function recent(key, now = Date.now()) {
  const a = (failures.get(key) || []).filter(t => now - t < WINDOW_MS);
  if (a.length) failures.set(key, a); else failures.delete(key);
  return a;
}
const limitKey = username => String(username || '').trim().toLowerCase();
const isLimited = key => recent(key).length >= MAX_FAILURES;
function recordFailure(key) {
  if (failures.size > 10000) for (const k of failures.keys()) recent(k); // drop expired keys
  failures.set(key, [...recent(key), Date.now()]);
}

// ---------------------------------------------------------------- users
const userOf = row => new cds.User({
  id: row.username, roles: [row.role],
  attr: row.role === 'partner' ? { partner: row.partner } : row.hospital ? { hospital: row.hospital } : {},
});
const publicUser = row => ({ username: row.username, role: row.role, hospital: row.hospital || null, partner: row.partner || null, disabled: !!row.disabled });
const findUser = username => db(() => SELECT.one.from('medilink.Users').where({ username: String(username || '').toLowerCase() }));

/** Checks username + password with rate limiting. Returns the user row or throws LOGIN_FAILED / TOO_MANY_LOGIN_ATTEMPTS. */
async function checkPassword(username, password) {
  const key = limitKey(username);
  if (isLimited(key)) throw fail(429, 'TOO_MANY_LOGIN_ATTEMPTS');
  const row = username && password ? await findUser(username) : null;
  const ok = await bcrypt.compare(String(password || ''), row?.passwordHash || DUMMY_HASH);
  if (!ok || !row || row.disabled) { recordFailure(key); throw fail(401, 'LOGIN_FAILED'); } // same message for every reason
  failures.delete(key);
  return row;
}

function ttlSeconds(v = config.authJwtTtl) {
  const m = /^(\d+)\s*([smhd]?)$/i.exec(String(v).trim());
  if (!m) return 8 * 3600;
  return Number(m[1]) * { '': 1, s: 1, m: 60, h: 3600, d: 86400 }[m[2].toLowerCase()];
}

async function login(username, password) {
  const row = await checkPassword(username, password);
  const now = Math.floor(Date.now() / 1000), exp = now + ttlSeconds(), jti = crypto.randomUUID();
  await db(async () => {
    await DELETE.from('medilink.Sessions').where({ exp: { '<': now } }); // housekeeping
    await INSERT.into('medilink.Sessions').entries({ jti, username: row.username, exp });
  });
  const token = jwt.sign({ sub: row.username, role: row.role, jti, iat: now, exp, iss: ISSUER }, config.authJwtSecret, { algorithm: 'HS256' });
  return { token, tokenType: 'Bearer', expiresAt: new Date(exp * 1000).toISOString(), user: publicUser(row) };
}

/** JWT -> user row, or null if the signature, expiry, session or account is not valid. */
async function verifyToken(token) {
  let p;
  try { p = jwt.verify(token, config.authJwtSecret, { algorithms: ['HS256'], issuer: ISSUER }); } catch { return null; }
  const [session, row] = await db(() => Promise.all([SELECT.one.from('medilink.Sessions').where({ jti: p.jti }), SELECT.one.from('medilink.Users').where({ username: p.sub })]));
  if (!session || session.username !== p.sub || !row || row.disabled) return null;
  return { row, jti: p.jti };
}

// Successful Basic logins, so scripts do not pay bcrypt on every call. Keyed on the stored hash: a reset invalidates it.
const basicOk = new Set();
async function verifyBasic(header) {
  const [username, ...rest] = Buffer.from(header.slice(6), 'base64').toString('utf8').split(':');
  const password = rest.join(':');
  const row = await findUser(username);
  const key = row && crypto.createHash('sha256').update(`${row.username}\0${password}\0${row.passwordHash}`).digest('hex');
  if (key && basicOk.has(key) && !row.disabled) return row;
  const ok = await checkPassword(username, password);
  basicOk.add(crypto.createHash('sha256').update(`${ok.username}\0${password}\0${ok.passwordHash}`).digest('hex'));
  return ok;
}

/** CAP auth middleware (cds.requires.auth.impl = srv/auth.js). Also runs for WebSocket upgrades. */
async function authenticate(req, res, next) {
  try {
    const h = req.headers.authorization || '';
    let token = /^Bearer\s+(\S+)$/i.exec(h)?.[1];
    // browsers cannot set headers on a WebSocket, so the socket may carry the token as ?access_token=
    if (!token && /websocket/i.test(req.headers.upgrade || '')) token = String(req.queryOptions?.access_token || new URL(req.url || '/', 'http://x').searchParams.get('access_token') || '') || undefined; // the ws plugin moves the query to req.queryOptions
    let row;
    if (token) {
      row = (await verifyToken(token))?.row;
      if (!row) return res.status(401).json(messages.error('SESSION_EXPIRED'));
    } else if (/^Basic /i.test(h)) {
      row = await verifyBasic(h);
    } else return next(); // anonymous: @requires turns it away
    cds.context.user = req.user = userOf(row);
    next();
  } catch (e) {
    if (e.code === 'LOGIN_FAILED' || e.code === 'TOO_MANY_LOGIN_ATTEMPTS') return reply(res, e);
    next(e);
  }
}

// ---------------------------------------------------------------- user management
const USERNAME = /^[a-z0-9][a-z0-9._-]{1,59}$/;
function checkNewPassword(pw) {
  if (typeof pw !== 'string' || pw.length < MIN_PASSWORD) throw fail(400, 'WEAK_PASSWORD', { min: MIN_PASSWORD });
  return pw;
}
async function validateUser(body) {
  const username = String(body.username || '').trim().toLowerCase();
  if (!USERNAME.test(username)) throw fail(400, 'INVALID_INPUT', { detail: 'Use 2 to 60 letters, digits, dots, dashes or underscores for the username.' });
  if (!ROLES.includes(body.role)) throw fail(400, 'INVALID_INPUT', { detail: `Choose one role: ${ROLES.slice(0, 4).join(', ')}.` });
  const out = { username, role: body.role, hospital: null, partner: null };
  if (['pharmacist', 'approver'].includes(body.role)) {
    if (!await db(() => SELECT.one.from('medilink.Hospitals').columns('ID').where({ ID: String(body.hospital || '') }))) throw fail(400, 'INVALID_INPUT', { detail: 'Choose the hospital this person works for.' });
    out.hospital = body.hospital;
  }
  if (body.role === 'partner') {
    if (!await db(() => SELECT.one.from('medilink.DeliveryPartners').columns('ID').where({ ID: String(body.partner || '') }))) throw fail(400, 'INVALID_INPUT', { detail: 'Choose the delivery partner this person works for.' });
    out.partner = body.partner;
  }
  return out;
}

async function createUser(body, { hash } = {}) {
  const u = await validateUser(body);
  const now = new Date().toISOString();
  const passwordHash = hash || await bcrypt.hash(checkNewPassword(body.password), COST);
  await db(async () => {
    if (await SELECT.one.from('medilink.Users').columns('username').where({ username: u.username })) throw fail(409, 'USER_EXISTS');
    await INSERT.into('medilink.Users').entries({ ...u, passwordHash, disabled: false, createdAt: now, updatedAt: now });
  });
  return publicUser(u);
}

async function updateUser(username, set) {
  const row = await findUser(username);
  if (!row) throw fail(404, 'USER_NOT_FOUND');
  await db(async () => {
    await UPDATE('medilink.Users').set({ ...set, updatedAt: new Date().toISOString() }).where({ username: row.username });
    await DELETE.from('medilink.Sessions').where({ username: row.username }); // sign out everywhere
  });
  return publicUser({ ...row, ...set });
}

/** Demo users = the mocked users of the development profile (same roles and hospitals), with DEMO_PASSWORD. */
async function seedDemoUsers(password = process.env.DEMO_PASSWORD) {
  // length is enforced by npm run env:check / db:init; the test run uses the mocked users' password "demo"
  if (!password) return { created: 0, reason: 'DEMO_PASSWORD is not set' };
  const mocked = require('../../package.json').cds.requires.auth['[development]'].users;
  const hash = await bcrypt.hash(password, COST);
  let created = 0;
  for (const [username, u] of Object.entries(mocked)) {
    if (!u || typeof u !== 'object' || await findUser(username)) continue;
    await createUser({ username, role: u.roles[0], hospital: u.attr?.hospital, partner: u.attr?.partner }, { hash });
    created++;
  }
  return { created };
}

// ---------------------------------------------------------------- routes
function signedIn(req, res) {
  const u = cds.context?.user;
  if (!u || u._is_anonymous || u.id === 'anonymous') { res.status(401).json(messages.error('NOT_SIGNED_IN')); return null; }
  return u;
}
const handle = fn => async (req, res) => { try { res.json(await fn(req, res)); } catch (e) { reply(res, e); } };
const adminOnly = fn => async (req, res) => {
  const u = signedIn(req, res); if (!u) return;
  if (!u.is('admin')) return res.status(403).json(messages.error('NOT_ALLOWED'));
  return handle(fn)(req, res);
};

function mount(app) {
  const json = express.json({ limit: '16kb' });
  const r = express.Router();
  r.post('/login', json, handle(req => login(String(req.body?.username || '').trim(), req.body?.password)));
  r.post('/logout', async (req, res) => {
    const token = /^Bearer\s+(\S+)$/i.exec(req.headers.authorization || '')?.[1];
    const v = token && await verifyToken(token);
    if (!v) return res.status(401).json(messages.error('NOT_SIGNED_IN'));
    await db(() => DELETE.from('medilink.Sessions').where({ jti: v.jti }));
    res.json({ ok: true, message: messages.t('auth.signedOut') });
  });
  r.get('/me', ...cds.middlewares.before, async (req, res) => {
    const u = signedIn(req, res); if (!u) return;
    const row = await findUser(u.id);
    res.json(row ? publicUser(row) : { username: u.id });
  });
  r.get('/users', ...cds.middlewares.before, adminOnly(async () => ({ users: (await db(() => SELECT.from('medilink.Users').orderBy('username'))).map(publicUser) })));
  r.post('/users', json, ...cds.middlewares.before, adminOnly(async (req, res) => { res.status(201); return createUser(req.body || {}); }));
  r.post('/users/:username/reset-password', json, ...cds.middlewares.before, adminOnly(async req => updateUser(req.params.username, { passwordHash: await bcrypt.hash(checkNewPassword(req.body?.password), COST) })));
  r.post('/users/:username/disable', ...cds.middlewares.before, adminOnly(req => {
    if (String(req.params.username).toLowerCase() === cds.context.user.id) throw fail(400, 'CANNOT_DISABLE_SELF');
    return updateUser(req.params.username, { disabled: true });
  }));
  r.post('/users/:username/enable', ...cds.middlewares.before, adminOnly(req => updateUser(req.params.username, { disabled: false })));
  r.use((err, req, res, next) => (err.type === 'entity.parse.failed' ? reply(res, fail(400, 'INVALID_INPUT', { detail: 'The request body is not valid JSON.' })) : next(err)));
  app.use('/auth', r);
}

module.exports = { authenticate, mount, login, verifyToken, seedDemoUsers, createUser, ttlSeconds, ROLES, _failures: failures };
