'use strict';
/*
 * Plain-language message catalogue for the experience layer (/me/*).
 * English text lives in the CAP i18n bundle backend/_i18n/messages.properties. Kannada / Hindi = add
 * messages_kn.properties / messages_hi.properties with the same keys; the request's Accept-Language picks one.
 * Keys: error.<CODE>.title|message|fix, journey.*, timeline.*, home.*, alert.*, task.*, onboarding.*, action.*, field.*, empty.*
 * Codes stay in responses and logs; user-facing text never shows stack traces, OData terms, IDs or rule numbers.
 */
const cds = require('@sap/cds');

// Errors the user can fix by simply trying again (network, a busy service, a double tap still running).
const RETRYABLE = new Set(['MATCHER_UNAVAILABLE', 'MEDISOFT_TOKEN_FAILED', 'STOCK_CHANGED', 'ACTION_IN_PROGRESS', 'LLM_UNPARSEABLE', 'UNEXPECTED', 'INGEST_FAILED', 'PAIR_FAILED', 'RATE_LIMITED']);
// Synonyms CAP itself uses for auth / not-found failures.
const ALIASES = { FORBIDDEN: 'NOT_ALLOWED', UNAUTHORIZED: 'NOT_SIGNED_IN', NOT_FOUND: 'NOT_FOUND' };

const bundle = () => cds.i18n.messages;
const localeOf = locale => locale || cds.context?.locale || 'en';

/** Text for a key with {named} params. Missing params collapse to '' (never "undefined"). */
function t(key, params = {}, locale) {
  const raw = bundle().at(key, localeOf(locale)) ?? bundle().at(key, 'en');
  if (raw === undefined) return undefined;
  return raw.replace(/{(\w+)}/g, (_, k) => (params[k] ?? '')).replace(/ {2,}/g, ' ').trim();
}
const has = key => bundle().at(key, 'en') !== undefined;

const statusOf = e => Number(e?.status || e?.statusCode || (/^\d{3}$/.test(String(e?.code)) ? e.code : 0)) || 500;

/** Machine code of any error thrown by CAP or MediLink libs ({status, code} or "CODE: detail" messages). */
function codeOf(e) {
  const raw = e?.code && !/^\d+$/.test(String(e.code)) ? String(e.code) : String(e?.message || '').split(':')[0].trim();
  const c = ALIASES[raw] || raw;
  if (/^[A-Z][A-Z0-9_]+$/.test(c)) return c;
  const s = statusOf(e);
  return s === 401 ? 'NOT_SIGNED_IN' : s === 403 ? 'NOT_ALLOWED' : s === 404 ? 'NOT_FOUND' : s === 400 ? 'INVALID_INPUT' : 'UNEXPECTED';
}

/** { code, title, message, fix, retryable } for a code; unknown codes fall back to the generic text. */
function error(code, params = {}, locale) {
  const k = has(`error.${code}.title`) ? code : 'UNEXPECTED';
  return {
    code,
    title: t(`error.${k}.title`, params, locale),
    message: t(`error.${k}.message`, params, locale),
    fix: t(`error.${k}.fix`, params, locale),
    retryable: RETRYABLE.has(code),
  };
}

/** HTTP status + plain-language body for a thrown error. */
function fromError(e, params) {
  const code = codeOf(e);
  let status = statusOf(e);
  if (status >= 500 && code !== 'UNEXPECTED' && has(`error.${code}.title`)) status = code === 'MATCHER_UNAVAILABLE' ? 503 : 502;
  return { status, body: error(code, params) };
}

module.exports = { t, has, error, fromError, codeOf, statusOf, RETRYABLE };
