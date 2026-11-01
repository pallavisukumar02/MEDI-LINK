'use strict';
// Pure hash-chain helpers for the append-only audit log (FR-27).
// hash_n = SHA-256( canonical([seq, actor, action, payload, loggedAt, prevHash]) )
const crypto = require('crypto');

const GENESIS = '0'.repeat(64);

/** Deterministic JSON: object keys sorted recursively. */
function canonical(value) {
  if (value === null || value === undefined) return 'null';
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (typeof value === 'object') {
    return '{' + Object.keys(value).sort()
      .filter(k => value[k] !== undefined)
      .map(k => JSON.stringify(k) + ':' + canonical(value[k])).join(',') + '}';
  }
  return JSON.stringify(value);
}

function computeHash({ seq, actor, action, payload, loggedAt, prevHash }) {
  const material = canonical([Number(seq), actor, action, payload, loggedAt, prevHash]);
  return crypto.createHash('sha256').update(material).digest('hex');
}

/** Build the next entry given the last one (or null for genesis). */
function nextEntry(last, actor, action, payloadObj, now = new Date()) {
  const seq = last ? Number(last.seq) + 1 : 1;
  const prevHash = last ? last.hash : GENESIS;
  const payload = canonical(payloadObj ?? {});
  const loggedAt = now.toISOString();
  const entry = { seq, actor: String(actor || 'system'), action, payload, loggedAt, prevHash };
  entry.hash = computeHash(entry);
  return entry;
}

/** Verify an ordered list of entries. Returns { ok, count, brokenAt?, reason? }. */
function verifyChain(entries) {
  let prev = GENESIS;
  let expectedSeq = 1;
  for (const e of entries) {
    if (Number(e.seq) !== expectedSeq) return { ok: false, count: entries.length, brokenAt: Number(e.seq), reason: 'SEQUENCE_GAP' };
    if (e.prevHash !== prev) return { ok: false, count: entries.length, brokenAt: Number(e.seq), reason: 'PREV_HASH_MISMATCH' };
    if (computeHash(e) !== e.hash) return { ok: false, count: entries.length, brokenAt: Number(e.seq), reason: 'HASH_MISMATCH' };
    prev = e.hash;
    expectedSeq++;
  }
  return { ok: true, count: entries.length, head: prev };
}

module.exports = { GENESIS, canonical, computeHash, nextEntry, verifyChain };
