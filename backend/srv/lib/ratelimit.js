'use strict';
/*
 * Request limits (fixed window, per client IP or per signed-in user) for routes that are costly or guessable:
 * /auth/*, /ingest, /connector/pair, /me/actions/*, the licence look-up, the weather check and stock-register photos.
 * Over the limit: 429 { code: RATE_LIMITED, ... } with Retry-After (seconds). Behind a reverse proxy set TRUST_PROXY
 * so req.ip is the client, not the proxy.
 * shortcut: counters live in this process's memory, which is right for one MediLink process on one SQLite file;
 * move them to a shared store (a SQLite table or Redis) before running several app instances.
 */
const messages = require('./messages');
const MIN = 60 * 1000;
const buckets = new Map(); // key -> { n, reset }

/** Counts one hit; 0 = allowed, otherwise the seconds until the window resets. */
function hit(key, max, windowMs, now = Date.now()) {
  let b = buckets.get(key);
  if (!b || b.reset <= now) {
    if (buckets.size > 50000) for (const [k, v] of buckets) if (v.reset <= now) buckets.delete(k);
    buckets.set(key, (b = { n: 0, reset: now + windowMs }));
  }
  return ++b.n <= max ? 0 : Math.ceil((b.reset - now) / 1000);
}

/** Client address. An IPv6 client usually owns a whole /64, so the /64 counts as one address. */
function ipOf(req) {
  const ip = String(req.ip || req.socket?.remoteAddress || '').replace(/^::ffff:(?=\d+\.)/, '');
  if (!ip.includes(':')) return ip;
  const [a, b = ''] = ip.split('::'), head = a ? a.split(':') : [], tail = b ? b.split(':') : [];
  return [...head, ...Array(Math.max(0, 8 - head.length - tail.length)).fill('0'), ...tail].slice(0, 4).join(':') + '::/64';
}

/** Express middleware: at most max requests per windowMs per keyOf(req) (default: client IP). */
const limit = (name, max, windowMs, keyOf = ipOf) => (req, res, next) => {
  const wait = hit(`${name}:${keyOf(req)}`, max, windowMs);
  if (!wait) return next();
  res.set('Retry-After', String(wait)).status(429).json(messages.error('RATE_LIMITED'));
};

/** Inside a CAP handler, per signed-in user, so OData, REST and /me/actions count alike. Throws 429 when over. */
function check(req, name, max, windowMs) {
  const wait = hit(`${name}:${req.user?.id}`, max, windowMs);
  if (!wait) return;
  req.http?.res?.set('Retry-After', String(wait));
  throw Object.assign(new Error(`RATE_LIMITED: try again in ${wait} s`), { status: 429, code: 'RATE_LIMITED', retryAfter: wait });
}

module.exports = { hit, ipOf, limit, check, MIN };
