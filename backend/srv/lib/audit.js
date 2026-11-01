'use strict';
// Append-only, hash-chained audit log (FR-27). Runs in the caller's transaction (cds.context).
const cds = require('@sap/cds');
const { nextEntry, verifyChain } = require('./audit-chain');

const ENTITY = 'medilink.AuditLog';
let guarded = false;

/** Reject UPDATE / DELETE / UPSERT on the audit table at the database-service level. */
function guard(db) {
  if (guarded) return;
  guarded = true;
  db.before(['UPDATE', 'DELETE', 'UPSERT'], ENTITY, req => req.reject(405, 'AUDIT_APPEND_ONLY: the audit log is append-only'));
}

async function log(actor, action, payload = {}) {
  const last = await SELECT.one.from(ENTITY).columns('seq', 'hash').orderBy('seq desc');
  const e = nextEntry(last, actor, action, payload);
  await INSERT.into(ENTITY).entries(e);
  return e;
}

async function verify() {
  const rows = await SELECT.from(ENTITY).orderBy('seq asc');
  return verifyChain(rows);
}

const actorOf = req => req?.user?.id || cds.context?.user?.id || 'system';

module.exports = { log, verify, guard, actorOf };
