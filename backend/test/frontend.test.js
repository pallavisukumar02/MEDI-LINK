'use strict';
// The UI in frontend/ is served by CAP in development (same origin as /me/*) and copied to the app router at MTA build.
require('./helpers/env')();
const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');
const cds = require('@sap/cds');
const T = cds.test(__dirname + '/..');

test('development server serves the landing page and the app', async () => {
  const app = await T.axios.get('/app.html');
  expect(app.status).toBe(200);
  expect(app.data).toMatch(/<title>MediLink<\/title>/);
  expect(app.data).toMatch(/three\.js\/r128\/three\.min\.js/);
  if (fs.existsSync(path.join(__dirname, '../../frontend/index.html'))) expect((await T.axios.get('/')).data).toMatch(/MediLink/);
});

test('the app keeps the session in memory only and talks to the experience API', () => {
  const src = fs.readFileSync(path.join(__dirname, '../../frontend/app.html'), 'utf8');
  expect(src).not.toMatch(/\b(localStorage|sessionStorage)\s*[.[]|document\.cookie\s*=/); // use, not mentions
  for (const p of ['/me/home', '/me/onboarding', '/me/journeys/', '/me/city', '/health/integrations', '/admin/metrics', 'Idempotency-Key']) expect(src).toContain(p);
  expect(Buffer.byteLength(src)).toBeLessThan(400 * 1024);
});

test('the MTA build copies frontend/ into the app router', () => {
  const mta = yaml.load(fs.readFileSync(path.join(__dirname, '../../mta.yaml'), 'utf8'));
  expect(mta['build-parameters']['before-all'][0].commands.join('\n')).toMatch(/cpSync\('frontend','app\/router\/resources'/);
});
