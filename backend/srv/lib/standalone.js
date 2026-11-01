'use strict';
/*
 * Standalone mode = CAP profile "standalone" (SQLite file) or "standalone-pg" (PostgreSQL): MediLink without any
 * SAP BTP service. One place for: is it on, the PostgreSQL connection from DATABASE_URL, and which environment
 * variables it needs (the server refuses to start without the hard ones; scripts/env-check.js prints them all).
 * Never returns or prints a secret value, only whether it is usable.
 */
const PROFILES = ['standalone', 'standalone-pg'];
const isStandalone = () => (require('@sap/cds').env.profiles || []).some(p => PROFILES.includes(p));

/** DATABASE_URL -> @cap-js/postgres credentials (it has no connection-string option). SSL on, certificates checked. */
function pgCredentials(url) {
  const u = new URL(url);
  const mode = u.searchParams.get('sslmode'); // disable: a database on your own machine; no-verify: self-signed certificate
  return {
    host: u.hostname, port: Number(u.port) || 5432,
    user: decodeURIComponent(u.username), password: decodeURIComponent(u.password),
    database: decodeURIComponent(u.pathname.slice(1)),
    ssl: mode === 'disable' ? false : { rejectUnauthorized: mode !== 'no-verify' },
  };
}

function configureDb(cds = require('@sap/cds'), env = process.env) {
  const db = cds.env.requires.db;
  if (db?.kind === 'postgres' && env.DATABASE_URL) db.credentials = pgCredentials(env.DATABASE_URL);
}

const weak = v => !v || /change-me|placeholder|^<.*>$/i.test(v);
const secret = v => !weak(v) && v.length >= 32;
// hard = the server will not start without it; pg = only for standalone-pg
const VARS = [
  { name: 'AUTH_JWT_SECRET', hard: true, ok: secret, why: 'signs login tokens (at least 32 random characters)' },
  { name: 'TOKEN_ENCRYPTION_KEY', alias: 'TOKEN_STORE_KEY', hard: true, ok: secret, why: 'encrypts hospital access tokens (at least 32 random characters; keep it stable or hospitals must reconnect)' },
  { name: 'DATABASE_URL', hard: true, pg: true, ok: v => /^postgres(ql)?:\/\/.+/.test(v || ''), why: 'PostgreSQL connection string, e.g. postgresql://user:password@host:5432/medilink' },
  { name: 'DEMO_PASSWORD', ok: v => !weak(v) && v.length >= 8, why: 'password of the demo users that npm run db:init creates (at least 8 characters)' },
  { name: 'PATIENT_REF_HASH_SALT', ok: v => !weak(v), why: 'salt for hashing patient numbers at the source (same value for MediSoft and the connector)' },
  { name: 'MEDISOFT_OAUTH_CLIENT_SECRET', ok: v => !weak(v), why: 'OAuth client secret shared by MediLink and the MediSoft hospital software' },
  { name: 'CONNECTOR_PAIRING_SECRET', ok: v => !weak(v), why: 'protects one-time pairing codes for database connectors' },
];

/** Required variables that are missing or still placeholders for a profile: [{ name, why, hard }]. */
function missing(profile, env = process.env) {
  if (!PROFILES.includes(profile)) return [];
  return VARS.filter(v => (!v.pg || profile === 'standalone-pg') && !v.ok(env[v.name] || (v.alias && env[v.alias]) || ''))
    .map(({ name, why, hard }) => ({ name, why, hard: !!hard }));
}

/** Optional settings that are half filled in, or ignored in standalone mode. Plain sentences. */
function warnings(profile, env = process.env) {
  const out = [];
  const sa = PROFILES.includes(profile);
  if (env.SMTP_HOST) for (const k of ['ALERT_EMAIL_FROM', 'ALERT_EMAIL_TO']) if (!env[k]) out.push(`SMTP_HOST is set but ${k} is empty, so alert emails cannot be sent.`);
  const llm = String(env.LLM_PROVIDER || 'none').toLowerCase();
  if (llm === 'openai-compatible') for (const k of ['LLM_BASE_URL', 'LLM_MODEL']) if (!env[k]) out.push(`LLM_PROVIDER is openai-compatible but ${k} is empty, so AI stays off.`);
  if (sa && llm === 'aicore') out.push('LLM_PROVIDER=aicore is ignored in standalone mode (SAP AI Core is a BTP service): AI is off. Use none or openai-compatible.');
  if (sa && String(env.APPROVAL_MODE || 'cap').toLowerCase() === 'bpa') out.push('APPROVAL_MODE=bpa is ignored in standalone mode: MediLink runs approvals itself.');
  if (sa && /^(1|true|yes|on)$/i.test(env.ALERT_NOTIFICATION_ENABLED || '')) out.push('ALERT_NOTIFICATION_ENABLED is ignored in standalone mode (SAP Alert Notification is a BTP service); set SMTP_* for email.');
  return out;
}

/** Throws a plain-language error if standalone mode cannot run safely. */
function assertConfig(env = process.env) {
  const cds = require('@sap/cds');
  const profile = cds.env.requires.db?.kind === 'postgres' ? 'standalone-pg' : 'standalone';
  const hard = missing(profile, env).filter(m => m.hard);
  if (hard.length) throw new Error(`Standalone mode cannot start: ${hard.map(m => `${m.name} is missing or too weak (${m.why})`).join('; ')}. Run npm run env:check.`);
}

module.exports = { PROFILES, isStandalone, pgCredentials, configureDb, missing, warnings, assertConfig };
