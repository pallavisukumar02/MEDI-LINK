'use strict';
/*
 * MediLink accounts: the only way to sign in (CAP custom auth, srv/auth.js), in every profile.
 *   POST /auth/login {username, password} -> { token (JWT, HS256), expiresAt, user }   (portal roles only)
 *   POST /auth/logout (Bearer)             -> the token stops working
 *   GET  /auth/me                          -> who am I
 *   POST /auth/ws-ticket                   -> { ticket, expiresIn }: single-use, 30 s, for /ws/tracking?ticket=
 *   admin: GET /auth/users · POST /auth/users (optional email) · POST /auth/users/:username/reset-password|disable|enable|email
 * Users get exactly one role (pharmacist, approver, admin, or system for the SAP Build Process Automation technical
 * user, API-only via Basic) and the matching hospital attribute, which every @requires / @restrict and hospitalOf() uses.
 * Delivery partners have no account: they act through a per-delivery courier link (lib/courier.js).
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
const ratelimit = require('./ratelimit');
const LOG = cds.log('auth');

const ROLES = ['pharmacist', 'approver', 'admin', 'system'];
const PORTAL = ['pharmacist', 'approver', 'admin']; // who may sign in to the web app (POST /auth/login)
const COST = 10;
const MIN_PASSWORD = 8;
const ISSUER = 'medilink';
const DUMMY_HASH = bcrypt.hashSync('timing-equaliser', COST); // compare against something even for unknown users

const fail = (status, code, params) => Object.assign(new Error(code), { status, code, params });
const reply = (res, e) => { const { status, body } = messages.fromError(e, e.params); if (status >= 500) LOG.error(body.code, e.message); if (e.retryAfter) res.set('Retry-After', String(e.retryAfter)); res.status(status).json(body); };
const db = fn => cds.tx({ user: cds.User.privileged }, fn);

// ---------------------------------------------------------------- login throttling
// 5 wrong passwords for one username from one IP pause that IP + username for 15 min (429 + Retry-After). Wrong passwords
// for a username from anywhere add a growing delay (250 ms doubling, at most 4 s): distributed guessing slows down, yet
// nobody can lock a pharmacist out, because from their own network they can still sign in. Set TRUST_PROXY behind a proxy.
// shortcut: in-memory, per process; with several app instances move the counters to the database.
const WINDOW_MS = 15 * 60 * 1000, MAX_FAILURES = 5, DELAY_AFTER = 3, MAX_DELAY_MS = 4000;
const failures = new Map(); // "ip|username" and "username" -> [timestamps]
function recent(key, now = Date.now()) {
  const a = (failures.get(key) || []).filter(t => now - t < WINDOW_MS);
  if (a.length) failures.set(key, a); else failures.delete(key);
  return a;
}
const limitKey = username => String(username || '').trim().toLowerCase();
function recordFailure(...keys) {
  if (failures.size > 10000) for (const k of failures.keys()) recent(k); // drop expired keys
  for (const key of keys) failures.set(key, [...recent(key), Date.now()]);
}

// ---------------------------------------------------------------- users
const userOf = row => new cds.User({ id: row.username, roles: [row.role], attr: row.hospital ? { hospital: row.hospital } : {} });
const publicUser = row => ({ username: row.username, role: row.role, hospital: row.hospital || null, disabled: !!row.disabled, ...(row.email ? { email: row.email } : {}) });
const findUser = username => db(() => SELECT.one.from('medilink.Users').where({ username: String(username || '').toLowerCase() }));

/** Checks username + password with throttling. Returns the user row or throws LOGIN_FAILED / TOO_MANY_LOGIN_ATTEMPTS. */
async function checkPassword(username, password, ip = '') {
  const user = limitKey(username), pair = `${ip}|${user}`;
  const paused = recent(pair);
  if (paused.length >= MAX_FAILURES) throw Object.assign(fail(429, 'TOO_MANY_LOGIN_ATTEMPTS'), { retryAfter: Math.ceil((paused[paused.length - MAX_FAILURES] + WINDOW_MS - Date.now()) / 1000) });
  const n = recent(user).length;
  if (n >= DELAY_AFTER) await new Promise(r => setTimeout(r, Math.min(MAX_DELAY_MS, 250 * 2 ** (n - DELAY_AFTER))));
  const row = username && password ? await findUser(username) : null;
  const ok = await bcrypt.compare(String(password || ''), row?.passwordHash || DUMMY_HASH);
  if (!ok || !row || row.disabled) { recordFailure(pair, user); throw fail(401, 'LOGIN_FAILED'); } // same message for every reason
  failures.delete(pair); failures.delete(user);
  return row;
}

function ttlSeconds(v = config.authJwtTtl) {
  const m = /^(\d+)\s*([smhd]?)$/i.exec(String(v).trim());
  if (!m) return 8 * 3600;
  return Number(m[1]) * { '': 1, s: 1, m: 60, h: 3600, d: 86400 }[m[2].toLowerCase()];
}

async function login(username, password, ip) {
  const row = await checkPassword(username, password, ip);
  if (!PORTAL.includes(row.role)) { recordFailure(`${ip || ''}|${limitKey(username)}`, limitKey(username)); throw fail(401, 'LOGIN_FAILED'); } // same answer as a wrong password
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
async function verifyBasic(header, ip) {
  const [username, ...rest] = Buffer.from(header.slice(6), 'base64').toString('utf8').split(':');
  const password = rest.join(':');
  const row = await findUser(username);
  const key = row && crypto.createHash('sha256').update(`${row.username}\0${password}\0${row.passwordHash}`).digest('hex');
  if (key && basicOk.has(key) && !row.disabled) return row;
  const ok = await checkPassword(username, password, ip);
  basicOk.add(crypto.createHash('sha256').update(`${ok.username}\0${password}\0${ok.passwordHash}`).digest('hex'));
  return ok;
}

// ---------------------------------------------------------------- WebSocket tickets
// Browsers cannot set headers on a WebSocket, and a JWT in the URL lands in proxy logs while it is valid for hours (audit F20).
// So the page trades its sign-in for a ticket that works once, within 30 s: POST /auth/ws-ticket, then /ws/tracking?ticket=...
// shortcut: in memory, per process; with several app instances keep tickets in the database (or use sticky sessions).
const TICKET_TTL_S = 30;
const tickets = new Map(); // sha256(ticket) -> { username, exp }
const sha = s => crypto.createHash('sha256').update(String(s)).digest('hex');
function issueTicket(username) {
  const now = Date.now();
  for (const [k, v] of tickets) if (v.exp <= now) tickets.delete(k);
  const ticket = crypto.randomBytes(32).toString('base64url');
  tickets.set(sha(ticket), { username, exp: now + TICKET_TTL_S * 1000 });
  return { ticket, expiresIn: TICKET_TTL_S };
}
async function redeemTicket(ticket) {
  const v = tickets.get(sha(ticket));
  tickets.delete(sha(ticket)); // single use, even when expired
  if (!v || v.exp <= Date.now()) return null;
  const row = await findUser(v.username);
  return row && !row.disabled ? row : null;
}

/** CAP auth middleware (cds.requires.auth.impl = srv/auth.js). Also runs for WebSocket upgrades. */
async function authenticate(req, res, next) {
  try {
    const h = req.headers.authorization || '';
    const token = /^Bearer\s+(\S+)$/i.exec(h)?.[1];
    // the ws plugin moves the query to req.queryOptions
    const ticket = !token && /websocket/i.test(req.headers.upgrade || '') && String(req.queryOptions?.ticket || new URL(req.url || '/', 'http://x').searchParams.get('ticket') || '');
    let row;
    if (token || ticket) {
      row = token ? (await verifyToken(token))?.row : await redeemTicket(ticket);
      if (!row) return res.status(401).json(messages.error('SESSION_EXPIRED'));
    } else if (/^Basic /i.test(h)) {
      row = await verifyBasic(h, ratelimit.ipOf(req));
    } else return next(); // anonymous: @requires turns it away
    if (!ROLES.includes(row.role)) throw fail(401, 'LOGIN_FAILED'); // e.g. a former courier account left in an old database
    cds.context.user = req.user = userOf(row);
    next();
  } catch (e) {
    if (e.code === 'LOGIN_FAILED' || e.code === 'TOO_MANY_LOGIN_ATTEMPTS') return reply(res, e);
    next(e);
  }
}

// ---------------------------------------------------------------- user management
const USERNAME = /^[a-z0-9][a-z0-9._-]{1,59}$/;
const EMAIL = /^[^\s@<>,;"]{1,64}@[a-z0-9-]+(\.[a-z0-9-]+)*\.[a-z]{2,}$/;
const isEmail = v => typeof v === 'string' && v.length <= 120 && EMAIL.test(v.trim().toLowerCase());
/** Alert email: empty clears it, anything else must look like one address. */
function checkEmail(v) {
  if (v === undefined || v === null || String(v).trim() === '') return null;
  if (!isEmail(String(v))) throw fail(400, 'INVALID_EMAIL');
  return String(v).trim().toLowerCase();
}
function checkNewPassword(pw) {
  if (typeof pw !== 'string' || pw.length < MIN_PASSWORD) throw fail(400, 'WEAK_PASSWORD', { min: MIN_PASSWORD });
  return pw;
}
async function validateUser(body) {
  const username = String(body.username || '').trim().toLowerCase();
  if (!USERNAME.test(username)) throw fail(400, 'INVALID_INPUT', { detail: 'Use 2 to 60 letters, digits, dots, dashes or underscores for the username.' });
  if (!ROLES.includes(body.role)) throw fail(400, 'INVALID_INPUT', { detail: `Choose one role: ${PORTAL.join(', ')}.` });
  const out = { username, role: body.role, hospital: null, email: checkEmail(body.email) };
  if (['pharmacist', 'approver'].includes(body.role)) {
    if (!await db(() => SELECT.one.from('medilink.Hospitals').columns('ID').where({ ID: String(body.hospital || '') }))) throw fail(400, 'INVALID_INPUT', { detail: 'Choose the hospital this person works for.' });
    out.hospital = body.hospital;
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

/** Sets a user's alert email (their own via set-alert-email, or an admin's change). Runs in the caller's transaction. */
async function setEmail(username, email) {
  const row = await SELECT.one.from('medilink.Users').where({ username: String(username || '').toLowerCase() });
  if (!row) throw fail(404, 'USER_NOT_FOUND');
  const e = checkEmail(email);
  await UPDATE('medilink.Users').set({ email: e, updatedAt: new Date().toISOString() }).where({ username: row.username });
  return publicUser({ ...row, email: e });
}

// Demo users (synthetic): username -> [role, hospital]. They all get DEMO_PASSWORD. Couriers have no account.
const DEMO_USERS = {
  asha: ['pharmacist', 'H1'], ravi: ['pharmacist', 'H5'], sunil: ['pharmacist', 'H2'], lata: ['pharmacist', 'H3'], hari: ['pharmacist', 'H4'],
  meera: ['approver', 'H5'], kiran: ['approver', 'H5'], anil: ['approver', 'H2'], deepa: ['approver', 'H1'],
  bpa: ['system'], admin: ['admin'],
};

/** Creates the demo users that do not exist yet, with DEMO_PASSWORD (npm run db:init; first start outside production). */
async function seedDemoUsers(password = process.env.DEMO_PASSWORD) {
  // strength is enforced by npm run env:check / db:init (8+ characters in production); development uses "demo"
  if (!password) return { created: 0, reason: 'DEMO_PASSWORD is not set' };
  const hash = await bcrypt.hash(password, COST);
  let created = 0;
  for (const [username, [role, at]] of Object.entries(DEMO_USERS)) {
    if (await findUser(username)) continue;
    await createUser({ username, role, hospital: at }, { hash });
    created++;
  }
  return { created };
}

/** Enabled demo accounts whose password is still the development default "demo" (production refuses to start with any). */
async function demoUsersWithDevPassword() {
  const rows = await db(() => SELECT.from('medilink.Users').columns('username', 'passwordHash').where({ username: { in: Object.keys(DEMO_USERS) }, disabled: false }));
  const weak = new Map(); // demo users share one hash (seedDemoUsers), so compare each distinct hash once
  for (const r of rows) if (!weak.has(r.passwordHash)) weak.set(r.passwordHash, await bcrypt.compare('demo', r.passwordHash || ''));
  return rows.filter(r => weak.get(r.passwordHash)).map(r => r.username);
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
  r.use(ratelimit.limit('auth', 100, 5 * ratelimit.MIN)); // per IP, on top of the per-IP + username login throttle
  r.post('/login', json, handle(req => login(String(req.body?.username || '').trim(), req.body?.password, ratelimit.ipOf(req))));
  r.post('/logout', async (req, res) => {
    const token = /^Bearer\s+(\S+)$/i.exec(req.headers.authorization || '')?.[1];
    const v = token && await verifyToken(token);
    if (!v) return res.status(401).json(messages.error('NOT_SIGNED_IN'));
    await db(() => DELETE.from('medilink.Sessions').where({ jti: v.jti }));
    res.json({ ok: true, message: messages.t('auth.signedOut') });
  });
  r.post('/ws-ticket', ...cds.middlewares.before, (req, res) => { const u = signedIn(req, res); if (u) res.set('Cache-Control', 'no-store').json(issueTicket(u.id)); });
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
  r.post('/users/:username/email', json, ...cds.middlewares.before, adminOnly(req => {
    const admin = cds.context.user.id;
    return db(async () => {
      const u = await setEmail(req.params.username, req.body?.email);
      await require('./audit').log(admin, 'ALERT_EMAIL_SET', { user: u.username, email: u.email ? 'set' : 'cleared' });
      return u;
    });
  }));
  r.use((err, req, res, next) => (err.type === 'entity.parse.failed' ? reply(res, fail(400, 'INVALID_INPUT', { detail: 'The request body is not valid JSON.' })) : next(err)));
  app.use('/auth', r);
}

module.exports = { authenticate, mount, login, verifyToken, seedDemoUsers, demoUsersWithDevPassword, createUser, setEmail, isEmail, ttlSeconds, ROLES, _failures: failures, _tickets: tickets };
