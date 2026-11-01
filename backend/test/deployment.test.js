'use strict';
// Cloud Foundry set-up is complete and free-only, checked without deploying: mta.yaml modules / resources,
// the app router (XSUAA login, routes to CAP incl. WebSockets and /me/*), and XSUAA redirect URIs.
const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');

const ROOT = path.join(__dirname, '..', '..');
const mta = yaml.load(fs.readFileSync(path.join(ROOT, 'mta.yaml'), 'utf8'));
const mod = name => mta.modules.find(m => m.name === name);

test('only free service plans, nothing from Integration Suite or Event Mesh', () => {
  const FREE = { hana: ['hdi-shared'], xsuaa: ['application'], destination: ['lite'] };
  for (const r of mta.resources) {
    const { service, 'service-plan': plan } = r.parameters;
    expect([r.name, FREE[service]?.includes(plan)]).toEqual([r.name, true]);
  }
  expect(JSON.stringify(mta)).not.toMatch(/integration-suite|enterprise-messaging|event-mesh|it-rt|standard-edition/i);
});

test('app router module: XSUAA + a forwarding destination to the CAP service', () => {
  const r = mod('medilink-approuter');
  expect(r).toMatchObject({ type: 'approuter.nodejs', path: 'app/router' });
  expect(r.requires.map(x => x.name)).toEqual(expect.arrayContaining(['medilink-uaa', 'srv-api']));
  const dest = r.requires.find(x => x.name === 'srv-api');
  expect(dest).toMatchObject({ group: 'destinations', properties: { name: 'srv-api', url: '~{srv-url}', forwardAuthToken: true } });
  expect(mod('medilink-srv').provides.find(p => p.name === 'srv-api').properties['srv-url']).toBe('${default-url}');
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'app/router/package.json'), 'utf8'));
  expect(pkg.dependencies['@sap/approuter']).toBeDefined();
  expect(fs.existsSync(path.join(ROOT, 'app/router/resources/index.html'))).toBe(true);
});

test('xs-app.json: every backend path behind XSUAA, WebSockets on, UI apps from resources/', () => {
  const x = JSON.parse(fs.readFileSync(path.join(ROOT, 'app/router/xs-app.json'), 'utf8'));
  expect(x.authenticationMethod).toBe('route');
  expect(x.websockets.enabled).toBe(true);
  const route = p => x.routes.find(r => new RegExp(r.source).test(p));
  for (const p of ['/me/home', '/me/actions/accept-request', '/ws/tracking', '/odata/v4/cover/board', '/onboarding/licence', '/audit/verify', '/health/integrations', '/admin/metrics']) {
    expect([p, route(p)?.destination, route(p)?.authenticationType]).toEqual([p, 'srv-api', 'xsuaa']);
  }
  expect(route('/index.html')).toMatchObject({ localDir: 'resources', authenticationType: 'xsuaa' });
  expect(x.routes.every(r => r.authenticationType !== 'none')).toBe(true);
});

test('XSUAA: roles, attributes and redirect URIs for Cloud Foundry and local hybrid runs', () => {
  const xs = require('../xs-security.json');
  expect(xs['oauth2-configuration']['redirect-uris']).toEqual(expect.arrayContaining(['https://*.cfapps.*.hana.ondemand.com/**', 'http://localhost:*/**']));
  expect(mod('medilink-srv').requires.map(r => r.name)).toEqual(expect.arrayContaining(['medilink-db', 'medilink-uaa', 'medilink-destination']));
  expect(mod('medilink-srv').properties).toMatchObject({ APPROVAL_MODE: 'cap', LLM_PROVIDER: 'none' }); // switches flip in secrets.mtaext, never required
});
