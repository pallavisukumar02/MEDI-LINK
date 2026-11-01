'use strict';
// Message catalogue: every error code the backend can raise has plain-language text; no jargon in any text;
// translations fall back to English; error bodies always have the same five fields.
require('./helpers/env')();
const fs = require('fs');
const path = require('path');
const cds = require('@sap/cds');
cds.test(__dirname + '/..');
const messages = require('../srv/lib/messages');

const SRV = path.join(__dirname, '..', 'srv');
const files = dir => fs.readdirSync(dir, { withFileTypes: true }).flatMap(e => (e.isDirectory() ? files(path.join(dir, e.name)) : e.name.endsWith('.js') ? [path.join(dir, e.name)] : []));
const CODE_PATTERNS = [
  /(?:err|wfError|IngestError)\(\d{3}, '([A-Z][A-Z0-9_]+)'/g, /code: '([A-Z][A-Z0-9_]+)'/g, /reject\(\d{3}, '([A-Z][A-Z0-9_]+)/g,
  /fail\('([A-Z][A-Z0-9_]+)'/g, /new Error\('([A-Z][A-Z0-9_]{3,})(?::|'\))/g, /\.code = '([A-Z][A-Z0-9_]+)'/g, /error\('([A-Z][A-Z0-9_]+)'/g,
];
function codesInSource() {
  const out = new Set();
  for (const f of [...files(SRV), path.join(SRV, 'server.js')]) {
    const src = fs.readFileSync(f, 'utf8');
    for (const re of CODE_PATTERNS) for (const m of src.matchAll(re)) out.add(m[1]);
  }
  return out;
}

test('every error code raised in srv/ has a title, message and fix', () => {
  const codes = codesInSource();
  expect(codes.size).toBeGreaterThan(70);
  const missing = [...codes].filter(c => !['title', 'message', 'fix'].every(k => messages.has(`error.${c}.${k}`)));
  expect(missing).toEqual([]);
});

test('the rule-engine codes are covered too', () => {
  const { CODES } = require('../srv/lib/rules');
  for (const c of Object.keys(CODES)) expect(messages.has(`error.${c}.title`)).toBe(true);
});

test('no catalogue text contains IDs, rule numbers, technical terms or stack traces', () => {
  const texts = cds.i18n.messages.texts4('en');
  const all = []; for (const k in texts) all.push([k, texts[k]]); // bundle entries live on the prototype chain
  const own = all.filter(([k]) => /^(error|journey|timeline|home|alert|task|onboarding|action|confirm|field|empty|cover|city|plan|risk|reason|repay|software)\./.test(k));
  expect(own.length).toBeGreaterThan(250);
  for (const [k, v] of own) {
    expect([k, v]).not.toEqual([k, expect.stringMatching(/[Oo][Dd]ata|https?:|[Ss]tack|[Ee]xception|\bnull\b|undefined|\b[Rr]ule \d|\bH[1-9]\b|\bD-[A-Z0-9]{3,}|[0-9a-f]{8}-[0-9a-f]{4}|_ID\b|PENDING_|IN_TRANSIT/)]);
  }
});

test('error() always returns the five fields; unknown codes fall back to the generic text', () => {
  const e = messages.error('LICENCE_EXPIRED', { licenceNo: 'KA-BLR-20B-1003', validTill: '12 Aug 2026' });
  expect(e).toEqual({ code: 'LICENCE_EXPIRED', title: 'Your licence has expired', message: 'Your drug licence KA-BLR-20B-1003 expired on 12 Aug 2026.', fix: 'Renew it with the Karnataka Drugs Control Department, then try again.', retryable: false });
  expect(messages.error('SOMETHING_NEW')).toMatchObject({ code: 'SOMETHING_NEW', title: 'Something went wrong', retryable: false });
  expect(messages.error('MATCHER_UNAVAILABLE').retryable).toBe(true);
});

test('codeOf understands CAP and MediLink error styles', () => {
  expect(messages.codeOf({ status: 409, message: 'INVALID_STATUS: Transfer is ASSIGNED' })).toBe('INVALID_STATUS');
  expect(messages.codeOf({ status: 403, code: '403', message: 'Forbidden' })).toBe('NOT_ALLOWED');
  expect(messages.codeOf({ code: 'FORBIDDEN' })).toBe('NOT_ALLOWED');
  expect(messages.codeOf({ status: 401 })).toBe('NOT_SIGNED_IN');
  expect(messages.codeOf(new TypeError('x is not a function'))).toBe('UNEXPECTED');
  const { status, body } = messages.fromError(new TypeError('boom at line 3'));
  expect(status).toBe(500);
  expect(JSON.stringify(body)).not.toMatch(/boom|line 3|TypeError/);
});

test('other languages fall back to English until a translation file is added', () => {
  expect(messages.t('error.LICENCE_UNKNOWN.title', {}, 'kn')).toBe('We could not find this licence');
  expect(messages.t('error.LICENCE_UNKNOWN.message', {}, 'hi')).toBe('Licence is not in the hospital directory.');
});
