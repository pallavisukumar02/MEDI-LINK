'use strict';
// The UI in frontend/ is served by CAP (same origin as /me/*) under a strict CSP: no inline script or style, no CDN,
// self-hosted vendor files pinned by SHA-384.
require('./helpers/env')();
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const cds = require('@sap/cds');
const T = cds.test(__dirname + '/..');
const FE = path.join(__dirname, '../../frontend');
const read = f => fs.readFileSync(path.join(FE, f), 'utf8');
const PAGES = ['index.html', 'app.html', 'courier.html'];

test('the server serves the pages with security headers', async () => {
  for (const p of PAGES) {
    const r = await T.axios.get('/' + p);
    expect(r.status).toBe(200);
    const csp = r.headers['content-security-policy'];
    for (const d of ["default-src 'self'", "script-src 'self';", "connect-src 'self' ws: wss:", "img-src 'self' data: https://tile.openstreetmap.org", "frame-ancestors 'none'"]) expect(csp).toContain(d);
    expect(r.headers['referrer-policy']).toBe('no-referrer');
    expect(r.headers['x-content-type-options']).toBe('nosniff');
    expect(r.headers['strict-transport-security']).toBeUndefined(); // only over HTTPS
  }
  expect((await T.axios.get('/app.html')).data).toMatch(/<title>MediLink<\/title>/);
  // a server-rendered page may run exactly its own inline style, by nonce
  const setup = await T.axios.get('/connector/setup?hospital=H1');
  const nonce = /'nonce-([^']+)'/.exec(setup.headers['content-security-policy'])[1];
  expect(setup.data).toContain(`<style nonce="${nonce}">`);
});

test('pages have no inline script, style or handler and load nothing from another origin', () => {
  for (const p of PAGES) {
    const html = read(p);
    expect(html).not.toMatch(/<script(?![^>]*\ssrc=)[^>]*>/i);
    expect(html).not.toMatch(/<style|\sstyle=|\son[a-z]+=/i);
    expect(html).not.toMatch(/<(script|link)[^>]+(src|href)="(https?:)?\/\//i);
  }
  for (const f of fs.readdirSync(path.join(FE, 'js'))) expect(read('js/' + f)).not.toMatch(/\sstyle="|\son[a-z]+="|cdnjs|googleapis/);
});

test('every file loaded with integrity matches its SHA-384', () => {
  let n = 0;
  for (const p of PAGES) for (const [, src, sri] of read(p).matchAll(/(?:src|href)="([^"]+)" integrity="(sha384-[^"]+)"/g)) {
    expect(`sha384-${crypto.createHash('sha384').update(fs.readFileSync(path.join(FE, src))).digest('base64')}`).toBe(sri);
    n++;
  }
  expect(n).toBeGreaterThanOrEqual(5); // three, leaflet js + css, qrcode (app) and leaflet again (courier)
});

test('the app signs in with MediLink accounts, has no courier logins, and talks to the experience API', () => {
  const src = read('js/app.js');
  expect(src).not.toMatch(/\blocalStorage\s*[.[]|document\.cookie\s*=/); // the session stays in this tab (sessionStorage)
  for (const p of ['/auth/login', '/auth/logout', '/auth/ws-ticket', '/ws/tracking?ticket=', '/me/home', '/me/onboarding', '/me/journeys/', '/tracking', '/me/stock', '/me/notifications', '/me/city', '/health/integrations', '/admin/metrics', 'Idempotency-Key']) expect(src).toContain(p);
  expect(src).not.toMatch(/\bcourier2\b|\['partner'|'Basic /);
  expect(read('js/courier.js')).toContain('Authorization: `Courier ${token}`');
  for (const f of ['app.html', 'courier.html', 'js/app.js', 'js/ui.js', 'js/courier.js']) expect(Buffer.byteLength(read(f))).toBeLessThan(400 * 1024);
});
