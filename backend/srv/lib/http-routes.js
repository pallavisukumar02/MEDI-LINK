'use strict';
/*
 * Plain REST endpoints behind CAP's auth middleware (MediLink accounts, srv/auth.js):
 *   GET  /me/home · /me/onboarding · /me/journeys/:id · /me/city      experience layer (docs/EXPERIENCE_API.md)
 *   GET  /me/stock[?hospital=] · /me/notifications[?status=open|all]   stock + expiry monitoring, alert inbox (lib/monitor.js)
 *   GET  /me/journeys/:id/tracking                                     live delivery tracking (lib/tracking.js)
 *   POST /me/actions/:actionId                                         self-describing actions, Idempotency-Key aware
 *   GET  /health/integrations                                          admin: which integrations are on / off / misconfigured
 *   GET  /admin/metrics                                                admin: PRD success metrics
 *   GET  /admin/courier-links                                          admin: working courier links (simulator, support)
 * Every error is { code, title, message, fix, retryable } from the message catalogue.
 */
const cds = require('@sap/cds');
const crypto = require('crypto');
const express = require('express');
const journey = require('./journey');
const home = require('./home');
const { REGISTRY, validate } = require('./actions');
const messages = require('./messages');
const ratelimit = require('./ratelimit');
const LOG = cds.log('experience');

const sha = s => crypto.createHash('sha256').update(s).digest('hex');
const send = (res, status, body) => res.status(status).json(body);
const fail = (res, e) => {
  const { status, body } = messages.fromError(e, e.params);
  if (status >= 500) LOG.error(`${body.code}:`, e.message);
  return send(res, status, body);
};

function signedIn(req, res) {
  const user = cds.context?.user;
  if (!user || user._is_anonymous || user.id === 'anonymous') { send(res, 401, messages.error('NOT_SIGNED_IN')); return null; }
  return user;
}
const ctxOf = user => ({ user, locale: cds.context?.locale });

/** GET handler: runs fn(viewer, req) in a read transaction as the signed-in user. */
const view = fn => async (req, res) => {
  const user = signedIn(req, res); if (!user) return;
  try { send(res, 200, await cds.tx(ctxOf(user), () => fn(journey.viewerOf(user, cds.context?.locale), req))); } catch (e) { fail(res, e); }
};
const adminOnly = fn => async (req, res) => {
  const user = signedIn(req, res); if (!user) return;
  if (!user.is('admin')) return send(res, 403, messages.error('NOT_ALLOWED'));
  try { send(res, 200, await cds.tx(ctxOf(user), () => fn(req))); } catch (e) { fail(res, e); }
};

// ---------------------------------------------------------------- idempotency
// Rows older than a day are deleted by the daily cleanup job (lib/jobs.js).
async function claimKey(keyHash, actionId) {
  try {
    await cds.tx(() => INSERT.into('medilink.IdempotencyKeys').entries({ keyHash, actionId, createdAt: new Date().toISOString() }));
    return null;
  } catch (e) {
    const row = await cds.tx(() => SELECT.one.from('medilink.IdempotencyKeys').where({ keyHash }));
    if (!row) throw e;
    return row; // seen before: replay, or still running
  }
}
const storeKey = (keyHash, status, body) => cds.tx(() => UPDATE('medilink.IdempotencyKeys').set({ httpStatus: status, response: JSON.stringify(body) }).where({ keyHash }));
const dropKey = keyHash => cds.tx(() => DELETE.from('medilink.IdempotencyKeys').where({ keyHash }));

async function dispatch(req, res) {
  const user = signedIn(req, res); if (!user) return;
  const id = req.params.actionId;
  const def = Object.hasOwn(REGISTRY, id) ? REGISTRY[id] : null;
  if (!def) return send(res, 404, messages.error('UNKNOWN_ACTION'));
  const viewer = journey.viewerOf(user, cds.context?.locale);
  if (!def.roles.includes(viewer.role)) return send(res, 403, messages.error('NOT_ALLOWED'));
  let input;
  try { input = validate(def.input, req.body || {}); } catch (e) { return fail(res, e); }

  const key = String(req.get('Idempotency-Key') || '').trim();
  const keyHash = key && !def.secret && sha(`${user.id}:${id}:${key}`);
  if (def.secret) res.set('Cache-Control', 'no-store');
  if (keyHash) {
    const seen = await claimKey(keyHash, id).catch(e => { fail(res, e); return false; });
    if (seen === false) return;
    if (seen) {
      if (seen.httpStatus) { res.set('Idempotent-Replay', 'true'); return send(res, seen.httpStatus, JSON.parse(seen.response)); }
      return send(res, 409, messages.error('ACTION_IN_PROGRESS'));
    }
  }
  let status = 200, body;
  try {
    const out = await cds.tx(ctxOf(user), () => def.run(input, viewer));
    body = { ok: true, action: id, message: out.message };
    await cds.tx(ctxOf(user), async () => {
      if (out.journeyId) body.journey = await journey.forId(out.journeyId, viewer);
      if (out.onboarding) body.onboarding = await home.onboarding(viewer);
    });
    if (out.next) body.next = out.next;
    if (out.result) body.result = out.result;
  } catch (e) {
    ({ status, body } = messages.fromError(e, e.params));
    if (e.retryAfter) res.set('Retry-After', String(e.retryAfter));
    if (status >= 500) LOG.error(`${id} failed (${body.code}):`, e.message);
  }
  if (keyHash) await (status < 500 ? storeKey(keyHash, status, body) : dropKey(keyHash)).catch(e => LOG.warn('idempotency store failed:', e.message));
  send(res, status, body);
}

function mount(app) {
  const me = express.Router();
  me.use(express.json({ limit: '8mb' })); // stock-register photos arrive base64-encoded
  me.get('/home', view(v => home.home(v)));
  me.get('/onboarding', view(async v => (await home.onboarding(v)) || { done: true, steps: [], message: messages.t('onboarding.done') }));
  me.get('/city', view(() => home.city()));
  me.get('/stock', view((v, req) => require('./monitor').stockView(v, req.query.hospital)));
  me.get('/notifications', view((v, req) => require('./monitor').inbox(v, req.query.status)));
  me.get('/journeys/:id', view(async (v, req) => {
    const j = await journey.forId(req.params.id, v);
    if (!j) throw Object.assign(new Error('NOT_FOUND'), { status: 404, code: 'NOT_FOUND' });
    return j;
  }));
  me.get('/journeys/:id/tracking', view(async (v, req) => {
    const out = await require('./tracking').forJourney(req.params.id, v);
    if (!out) throw Object.assign(new Error('NOT_FOUND'), { status: 404, code: 'NOT_FOUND' }); // not a party: same as unknown
    return out;
  }));
  const userOrIp = req => (cds.context?.user && !cds.context.user._is_anonymous ? 'u:' + cds.context.user.id : ratelimit.ipOf(req));
  me.post('/actions/:actionId', ratelimit.limit('actions', 60, ratelimit.MIN, userOrIp), dispatch);
  me.use((err, req, res, _next) => fail(res, err.type === 'entity.parse.failed' ? Object.assign(err, { status: 400, code: 'INVALID_INPUT', params: { detail: 'The request body is not valid JSON.' } }) : err));
  app.use('/me', ...cds.middlewares.before, me);

  app.get('/health/integrations', ...cds.middlewares.before, adminOnly(() => require('./integrations').report()));
  app.get('/admin/metrics', ...cds.middlewares.before, adminOnly(() => require('./metrics').compute()));
  app.get('/admin/courier-links', ...cds.middlewares.before, (req, res, next) => { res.set('Cache-Control', 'no-store'); next(); }, adminOnly(() => require('./courier').activeLinks()));
}

module.exports = { mount, dispatch };
