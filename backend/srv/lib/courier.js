'use strict';
/*
 * Courier capability links. Delivery partners have no MediLink account: whoever holds the link of one delivery can do
 * that delivery's courier steps and nothing else (a capability URL, W3C TAG "Good practices for capability URLs").
 *  - minted when a partner is assigned (delivery.assignPartner): 256-bit random token, base64url
 *  - stored as SHA-256 (lookup) + AES-256-GCM ciphertext bound to the transfer (tokens.js, TOKEN_ENCRYPTION_KEY), so the
 *    supplying hospital / admin can show the same link again; the token itself is never stored in clear or logged
 *  - works while the transfer is ASSIGNED or IN_TRANSIT; after DELIVERED / QUARANTINED a read-only job view until
 *    2 h after the hand-over; hard expiry COURIER_LINK_TTL_HOURS; revoked on cancel, recall and reissue
 *  - URL ${APP_BASE_URL}/courier.html#t=<token>: the fragment never reaches servers, logs or Referer;
 *    the page sends "Authorization: Courier <token>"
 * Public routes (no MediLink sign-in), rate-limited per IP and per link, 2 kB JSON bodies, one generic 401:
 *   GET /courier/job · POST /courier/pickup · POST /courier/location · POST /courier/road-closed
 */
const cds = require('@sap/cds');
const crypto = require('crypto');
const express = require('express');
const config = require('./config');
const tokens = require('./tokens');
const audit = require('./audit');
const messages = require('./messages');
const LOG = cds.log('courier');

const L = 'medilink.CourierLinks', T = 'medilink.Transfers';
const LIVE = ['ASSIGNED', 'IN_TRANSIT'], DONE = ['DELIVERED', 'QUARANTINED'];
const GRACE_MS = 2 * 3600000; // read-only "delivered" view after the hand-over
const TOKEN = /^[A-Za-z0-9_-]{43}$/; // 32 bytes, base64url
const sha = s => crypto.createHash('sha256').update(s).digest('hex');
const aad = (transferId, linkId) => `medilink-courier:${transferId}:${linkId}`;
const urlOf = token => `${config.appBaseUrl}/courier.html#t=${token}`;
const err = (status, code, params) => Object.assign(new Error(code), { status, code, params });
const sys = fn => cds.tx({ user: cds.User.privileged }, fn);
const live = l => !l.revokedAt && new Date(l.expiresAt) > new Date();

// ---------------------------------------------------------------- links
/** Mints a link for the transfer's assigned partner and emails it to the partner's dispatch desk. Returns { url, expiresAt }. */
async function issue(transferId, actor, { action = 'COURIER_LINK_ISSUED', email = true } = {}) {
  const t = await SELECT.one.from(T).columns('ID', 'partner_ID', 'qty', 'drug_ID', 'supplier_ID', 'receiver_ID').where({ ID: transferId });
  const token = crypto.randomBytes(32).toString('base64url');
  const ID = cds.utils.uuid(), createdAt = new Date();
  const expiresAt = new Date(createdAt.getTime() + config.courierLinkTtlHours * 3600000).toISOString();
  await INSERT.into(L).entries({ ID, transfer_ID: t.ID, partner_ID: t.partner_ID, tokenHash: sha(token), ciphertext: tokens.encrypt(token, aad(t.ID, ID)), createdAt: createdAt.toISOString(), expiresAt });
  await audit.log(actor, action, { transfer: t.ID, partner: t.partner_ID, link: ID, expiresAt });
  if (email) afterCommit(() => emailPartner(t, urlOf(token), expiresAt));
  return { url: urlOf(token), expiresAt };
}

/** Revokes every open link of a transfer (cancel, recall, reissue). */
async function revoke(transferId, actor, reason) {
  const open = await SELECT.from(L).columns('ID').where({ transfer_ID: transferId, revokedAt: null });
  if (!open.length) return 0;
  await UPDATE(L).set({ revokedAt: new Date().toISOString() }).where({ transfer_ID: transferId, revokedAt: null });
  await audit.log(actor, 'COURIER_LINK_REVOKED', { transfer: transferId, links: open.map(l => l.ID), reason });
  return open.length;
}

/** After the hand-over the link only shows the finished job, and only for 2 h. */
async function closeAfterDelivery(transferId, deliveredAt) {
  const until = new Date(new Date(deliveredAt).getTime() + GRACE_MS).toISOString();
  for (const l of await SELECT.from(L).columns('ID', 'expiresAt').where({ transfer_ID: transferId, revokedAt: null })) {
    if (new Date(l.expiresAt) > new Date(until)) await UPDATE(L).set({ expiresAt: until }).where({ ID: l.ID });
  }
}

/** The newest working link of a transfer, decrypted: { url, token, createdAt, expiresAt } or null. */
async function current(transferId) {
  const l = (await SELECT.from(L).where({ transfer_ID: transferId, revokedAt: null }).orderBy('createdAt desc')).find(live);
  if (!l) return null;
  const token = tokens.decrypt(l.ciphertext, aad(transferId, l.ID));
  return { url: urlOf(token), token, createdAt: l.createdAt, expiresAt: l.expiresAt };
}

/** Supplying hospital (pharmacist / approver) or admin, while the medicine is waiting for pickup or on the road. */
async function managed(transferId, viewer) {
  const t = await SELECT.one.from(T).columns('ID', 'request_ID', 'status', 'supplier_ID', 'partner_ID').where({ ID: transferId });
  if (!t) throw err(404, 'TRANSFER_NOT_FOUND');
  if (viewer.role !== 'admin' && (!viewer.hospitalId || t.supplier_ID !== viewer.hospitalId)) throw err(403, 'COURIER_LINK_NOT_YOURS');
  if (!LIVE.includes(t.status) || !t.partner_ID) throw err(409, 'INVALID_STATUS');
  return t;
}

/** "Courier link" action: the current link again, for copy / QR. */
async function show(transferId, viewer) {
  await managed(transferId, viewer);
  const c = await current(transferId);
  if (!c) throw err(404, 'COURIER_LINK_NOT_FOUND');
  return { url: c.url, expiresAt: c.expiresAt };
}

/** "New courier link" action: the old link stops working, a new one is minted and emailed. */
async function reissue(transferId, viewer) {
  await managed(transferId, viewer);
  await revoke(transferId, viewer.userId, 'REISSUED');
  return issue(transferId, viewer.userId, { action: 'COURIER_LINK_REISSUED' });
}

/** Admin (simulator, support): working links of every delivery waiting for pickup or on the road. */
async function activeLinks() {
  const out = [];
  for (const t of await SELECT.from(T).columns('ID', 'request_ID', 'status', 'partner_ID').where({ status: { in: LIVE } })) {
    const c = await current(t.ID);
    if (!c) continue;
    const batches = (await SELECT.from('medilink.TransferLots').columns('batchNo').where({ transfer_ID: t.ID })).map(x => x.batchNo);
    out.push({ transferId: t.ID, requestId: t.request_ID || null, status: t.status, partnerId: t.partner_ID, ...c, batches });
  }
  return { links: out };
}

/** Development and tests only: deliveries that were seeded directly (no assignPartner call) get a link too. */
async function ensureLinks(actor = 'system:seed') {
  let n = 0;
  for (const t of await SELECT.from(T).columns('ID').where({ status: { in: LIVE }, partner_ID: { '!=': null } })) {
    if (!await current(t.ID)) { await issue(t.ID, actor, { email: false }); n++; }
  }
  return n;
}

function afterCommit(fn) {
  const run = () => fn().catch(e => LOG.warn('courier link email failed:', e.message));
  const ctx = cds.context;
  if (ctx?.tx && typeof ctx.on === 'function') ctx.on('succeeded', () => setImmediate(run));
  else setImmediate(run);
}
async function emailPartner(t, url, expiresAt) {
  const [p, from, to, drug] = await sys(() => Promise.all([
    SELECT.one.from('medilink.DeliveryPartners').columns('name', 'dispatchEmail').where({ ID: t.partner_ID }),
    SELECT.one.from('medilink.Hospitals').columns('name').where({ ID: t.supplier_ID }), SELECT.one.from('medilink.Hospitals').columns('name').where({ ID: t.receiver_ID }),
    SELECT.one.from('medilink.Drugs').columns('genericName', 'strength').where({ ID: t.drug_ID }),
  ]));
  const params = { partner: p?.name, qty: t.qty, drug: `${drug?.genericName || ''} ${drug?.strength || ''}`.trim(), from: from?.name, to: to?.name, url, until: require('./journey').fmtTime(expiresAt) };
  const sent = p?.dispatchEmail && await require('./notify').sendTo(p.dispatchEmail, messages.t('courier.email.subject', params), messages.t('courier.email.body', params).replace(/\\n/g, '\n')); // the i18n bundle keeps \n literally
  LOG.info(`courier link for delivery ${t.ID.slice(0, 8)} ${sent ? 'emailed to the partner' : 'ready (no email: SMTP off or no dispatch address)'}`);
}

// ---------------------------------------------------------------- the courier's requests
// shortcut: fixed one-minute windows in memory, per process; move them to a shared store with several app instances.
// perIp is generous because couriers behind one mobile carrier / proxy NAT share an address; perLink fits a fix every 5 s
// from the phone and the logger plus job refreshes.
const LIMITS = { perIp: 1200, perLink: 60, windowMs: 60000 };
const hits = new Map(); // key -> { n, until }
function limited(key, max) {
  const now = Date.now();
  let h = hits.get(key);
  if (!h || h.until <= now) {
    if (hits.size > 20000) for (const [k, v] of hits) if (v.until <= now) hits.delete(k);
    h = { n: 0, until: now + LIMITS.windowMs };
    hits.set(key, h);
  }
  return ++h.n > max;
}

/** Link + transfer for a token, or null (unknown, revoked, expired, finished: all look the same to the caller). */
async function resolve(token) {
  if (!TOKEN.test(token || '')) return null;
  const link = await SELECT.one.from(L).where({ tokenHash: sha(token) });
  if (!link || !live(link)) return null;
  const t = await SELECT.one.from(T).where({ ID: link.transfer_ID });
  if (!t || t.partner_ID !== link.partner_ID || ![...LIVE, ...DONE].includes(t.status)) return null;
  await UPDATE(L).set({ lastSeenAt: new Date().toISOString() }).where({ ID: link.ID });
  return { link, t, readOnly: !LIVE.includes(t.status) };
}

const place = h => ({ name: h.name, address: h.address || null, lat: Number(h.lat), long: Number(h.long) });
async function job({ link, t, readOnly }) {
  const { rangeFor } = require('./delivery');
  const [from, to, drug, partner, closures, lots] = await Promise.all([
    SELECT.one.from('medilink.Hospitals').where({ ID: t.supplier_ID }), SELECT.one.from('medilink.Hospitals').where({ ID: t.receiver_ID }),
    SELECT.one.from('medilink.Drugs').where({ ID: t.drug_ID }), SELECT.one.from('medilink.DeliveryPartners').columns('name').where({ ID: t.partner_ID }),
    SELECT.from('medilink.RoadClosures').where({ active: true }), SELECT.from('medilink.TransferLots').columns('batchNo').where({ transfer_ID: t.ID }),
  ]);
  const [minC, maxC] = rangeFor(drug.storageClass);
  // no batch numbers for the courier: the pickup scan has to prove them
  const note = t.transferNote && lots.reduce((n, l) => (l.batchNo ? n.split(l.batchNo).join('••••') : n), t.transferNote);
  return {
    status: t.status, readOnly, next: readOnly ? 'done' : t.status === 'ASSIGNED' ? 'pickup' : 'deliver',
    drug: { name: drug.genericName, strength: drug.strength, form: drug.dosageForm }, qty: t.qty,
    storageClass: drug.storageClass, temperatureRange: { minC, maxC },
    pickup: place(from), drop: place(to), handlingNote: note || null, partner: { name: partner?.name || null },
    rider: { name: link.riderName || null, phone: link.riderPhone || null },
    pickedUpAt: t.pickedUpAt || null, eta: t.status === 'IN_TRANSIT' ? t.eta || null : null, etaMin: t.etaMin ?? null, routeNote: t.routeNote || null,
    route: require('./tracking').routeOf(t, from, to, closures), expiresAt: link.expiresAt,
  };
}

// strict body checks: unknown fields, wrong types and out-of-range values are refused
const bad = detail => err(400, 'INVALID_INPUT', { detail });
const num = (min, max, required = false) => Object.assign(v => { if (typeof v !== 'number' || !Number.isFinite(v) || v < min || v > max) throw bad(`Send a number between ${min} and ${max}.`); return v; }, { required });
const text = (max, required = false, re) => Object.assign(v => { if (typeof v !== 'string' || !v.trim() || v.length > max || (re && !re.test(v.trim()))) throw bad('A field does not look right.'); return v.trim(); }, { required });
const time = () => v => { if ((typeof v !== 'string' && typeof v !== 'number') || !Number.isFinite(new Date(v).getTime())) throw bad('Send the time as an ISO date.'); return new Date(v).toISOString(); };
const oneOf = (...vals) => v => { if (!vals.includes(String(v).toUpperCase())) throw bad(`Use one of ${vals.join(', ')}.`); return String(v).toUpperCase(); };
function strict(body, spec) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw bad('Send a JSON object.');
  const extra = Object.keys(body).filter(k => !Object.hasOwn(spec, k));
  if (extra.length) throw bad(`Unexpected field: ${extra[0].slice(0, 40)}.`);
  const out = {};
  for (const [k, check] of Object.entries(spec)) {
    const v = body[k];
    if (v === undefined || v === null || v === '') { if (check.required) throw bad(`Please fill in ${k}.`); continue; }
    out[k] = check(v);
  }
  return out;
}
const PICKUP = { batchNo: text(200, true), sealId: text(40, true), loggerId: text(40, true), riderName: text(80), riderPhone: text(20, false, /^\+?[0-9][0-9 ()-]{5,18}$/) };
const LOCATION = { lat: num(-90, 90, true), long: num(-180, 180, true), accuracyM: num(0, 10000), ts: time(), temperatureC: num(-80, 60), sealStatus: oneOf('INTACT', 'BROKEN') };
const ROAD = { note: text(200) };

const send = (res, status, body) => res.status(status).json(body);
const fail = (res, e) => {
  const { status, body } = messages.fromError(e, e.params);
  if (status >= 500) LOG.error(`${body.code}:`, e.message);
  return send(res, status, body);
};
const deny = res => send(res, 401, messages.error('COURIER_LINK_INVALID'));

/** Rate limits, then the token -> req.courier. Never logs the token. */
function guard(req, res, next) {
  res.set({ 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer', 'X-Robots-Tag': 'noindex' });
  if (limited('ip:' + req.ip, LIMITS.perIp)) return send(res, 429, messages.error('COURIER_TOO_MANY_REQUESTS'));
  const token = /^Courier\s+(\S+)$/i.exec(req.headers.authorization || '')?.[1];
  if (!token || !TOKEN.test(token)) return deny(res);
  if (limited('link:' + sha(token), LIMITS.perLink)) return send(res, 429, messages.error('COURIER_TOO_MANY_REQUESTS'));
  sys(() => resolve(token)).then(r => { if (!r) return deny(res); req.courier = r; next(); }, e => fail(res, e));
}
const actorOf = ({ link }) => `courier:${link.partner_ID}:${link.ID.slice(0, 8)}`;

/** A courier step on the token's own transfer, as the token's partner. */
const step = (spec, fn) => async (req, res) => {
  try {
    const input = strict(req.body, spec);
    if (req.courier.readOnly) throw err(409, 'INVALID_STATUS');
    send(res, 200, await sys(async () => {
      const c = { ...req.courier, t: await SELECT.one.from(T).where({ ID: req.courier.t.ID }) };
      return fn(input, c, actorOf(c));
    }));
  } catch (e) { fail(res, e); }
};

function mount(app) {
  const r = express.Router();
  r.use(guard, express.json({ limit: '2kb' }));
  r.get('/job', async (req, res) => { try { send(res, 200, await sys(() => job(req.courier))); } catch (e) { fail(res, e); } });
  r.post('/pickup', step(PICKUP, async ({ riderName, riderPhone, ...scan }, c, actor) => {
    await require('./delivery').pickupScan(c.t.ID, scan, actor, c.link.partner_ID);
    if (riderName || riderPhone) await UPDATE(L).set({ riderName: riderName || null, riderPhone: riderPhone || null }).where({ ID: c.link.ID });
    const link = await SELECT.one.from(L).where({ ID: c.link.ID });
    return { message: messages.t('courier.done.pickup'), job: await job({ link, t: await SELECT.one.from(T).where({ ID: c.t.ID }), readOnly: false }) };
  }));
  r.post('/location', step(LOCATION, async (fix, c, actor) => {
    const out = await require('./delivery').telemetry({ ...fix, transfer: c.t.ID }, actor, c.link.partner_ID);
    return { accepted: out.accepted, excursion: out.excursion };
  }));
  r.post('/road-closed', step(ROAD, async ({ note }, c, actor) => {
    const out = await require('./delivery').setRouteClosed(c.t.ID, true, note || messages.t('courier.road.default'), actor);
    return { message: messages.t(out.open ? 'courier.done.rerouted' : 'courier.done.blocked'), open: out.open, distanceKm: out.distanceKm, etaMin: out.etaMin };
  }));
  r.use((e, req, res, _next) => fail(res, e.type === 'entity.parse.failed' || e.type === 'entity.too.large' ? bad('The request body is not valid JSON or too large.') : e));
  app.use('/courier', r);
}

module.exports = { mount, issue, revoke, reissue, show, current, closeAfterDelivery, activeLinks, ensureLinks, resolve, LIMITS, _hits: hits };
