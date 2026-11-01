'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { createApp } = require('../server');

const env = { MEDISOFT_ALLOWED_REDIRECTS: '', MEDISOFT_OAUTH_CLIENT_ID: 'c1', MEDISOFT_OAUTH_CLIENT_SECRET: 's3cret', MEDISOFT_OAUTH_REDIRECT_URI: 'http://cb.test/callback', PATIENT_REF_HASH_SALT: 'salt' };
let server, base;
test.before(async () => { server = createApp({ env }).listen(0); base = `http://localhost:${server.address().port}`; });
test.after(() => server.close());

const form = o => new URLSearchParams(o).toString();
const H = { 'Content-Type': 'application/x-www-form-urlencoded' };
const verifier = 'v'.repeat(43) + '-pkce-test-verifier';
const challenge = require('node:crypto').createHash('sha256').update(verifier).digest('base64url');
const authQ = { response_type: 'code', client_id: 'c1', redirect_uri: 'http://cb.test/callback', scope: 'stock.read schedule.read', state: 'xyz', code_challenge: challenge, code_challenge_method: 'S256' };

async function getCode(user = 'pharm.jayanagar', decision = 'allow') {
  const login = await fetch(`${base}/oauth/login`, { method: 'POST', headers: H, body: form({ ...authQ, username: user, password: 'medisoft-demo' }), redirect: 'manual' });
  assert.strictEqual(login.status, 302);
  const cookie = login.headers.get('set-cookie').split(';')[0];
  const consentPage = await fetch(base + login.headers.get('location'), { headers: { cookie } });
  assert.match(await consentPage.text(), /no names are shared/);
  const c = await fetch(`${base}/oauth/consent`, { method: 'POST', headers: { ...H, cookie }, body: form({ ...authQ, decision }), redirect: 'manual' });
  return new URL(c.headers.get('location'));
}

test('rejects unknown client, bad redirect and a missing or plain PKCE challenge', async () => {
  assert.strictEqual((await fetch(`${base}/oauth/authorize?${form({ ...authQ, client_id: 'evil' })}`)).status, 400);
  assert.strictEqual((await fetch(`${base}/oauth/authorize?${form({ ...authQ, redirect_uri: 'http://evil/cb' })}`)).status, 400);
  const { code_challenge, ...noPkce } = authQ;
  assert.strictEqual((await fetch(`${base}/oauth/authorize?${form(noPkce)}`)).status, 400);
  assert.strictEqual((await fetch(`${base}/oauth/authorize?${form({ ...authQ, code_challenge_method: 'plain' })}`)).status, 400);
  assert.strictEqual((await fetch(`${base}/oauth/authorize?${form(authQ)}`)).status, 200);
});

test('PKCE: a code is useless without the matching code_verifier', async () => {
  const code = (await getCode()).searchParams.get('code');
  const auth = 'Basic ' + Buffer.from('c1:s3cret').toString('base64');
  const r = await fetch(`${base}/oauth/token`, { method: 'POST', headers: { ...H, Authorization: auth }, body: form({ grant_type: 'authorization_code', code, redirect_uri: authQ.redirect_uri, code_verifier: 'w'.repeat(43) }) });
  assert.strictEqual(r.status, 400);
  assert.strictEqual((await r.json()).error, 'invalid_grant');
});

test('full authorization-code flow, hashed patient refs, single-use code, refresh, revoke', async () => {
  const loc = await getCode();
  assert.strictEqual(loc.searchParams.get('state'), 'xyz');
  const code = loc.searchParams.get('code');
  const auth = 'Basic ' + Buffer.from('c1:s3cret').toString('base64');
  const tok = await (await fetch(`${base}/oauth/token`, { method: 'POST', headers: { ...H, Authorization: auth }, body: form({ grant_type: 'authorization_code', code, redirect_uri: authQ.redirect_uri, code_verifier: verifier }) })).json();
  assert.ok(tok.access_token); assert.strictEqual(tok.tenant, 'H1');
  const again = await fetch(`${base}/oauth/token`, { method: 'POST', headers: { ...H, Authorization: auth }, body: form({ grant_type: 'authorization_code', code, redirect_uri: authQ.redirect_uri, code_verifier: verifier }) });
  assert.strictEqual(again.status, 400, 'code is single-use');
  const sched = await (await fetch(`${base}/api/schedule`, { headers: { Authorization: 'Bearer ' + tok.access_token } })).json();
  assert.ok(sched.items.length > 0);
  for (const b of sched.items) { assert.match(b.patientRef, /^[a-f0-9]{64}$/); assert.strictEqual(b.mrn, undefined); }
  const stock = await (await fetch(`${base}/api/stock`, { headers: { Authorization: 'Bearer ' + tok.access_token } })).json();
  assert.ok(stock.items.some(s => s.generic === 'Carboplatin'));
  const alias = await (await fetch(`${base}/stock`, { headers: { Authorization: 'Bearer ' + tok.access_token } })).json();
  assert.deepStrictEqual(alias.items, stock.items, '/stock alias');
  assert.strictEqual((await fetch(`${base}/schedule`)).status, 401, 'read APIs need a bearer token');
  const r = await (await fetch(`${base}/oauth/token`, { method: 'POST', headers: { ...H, Authorization: auth }, body: form({ grant_type: 'refresh_token', refresh_token: tok.refresh_token }) })).json();
  assert.ok(r.access_token && r.access_token !== tok.access_token);
  await fetch(`${base}/oauth/revoke`, { method: 'POST', headers: { ...H, Authorization: auth }, body: form({ token: r.refresh_token }) });
  assert.strictEqual((await fetch(`${base}/api/stock`, { headers: { Authorization: 'Bearer ' + r.access_token } })).status, 401);
});

test('deny returns access_denied and wrong secret is refused', async () => {
  const loc = await getCode('pharm.banashankari', 'deny');
  assert.strictEqual(loc.searchParams.get('error'), 'access_denied');
  const bad = await fetch(`${base}/oauth/token`, { method: 'POST', headers: { ...H, Authorization: 'Basic ' + Buffer.from('c1:wrong').toString('base64') }, body: form({ grant_type: 'authorization_code', code: 'x', redirect_uri: authQ.redirect_uri }) });
  assert.strictEqual(bad.status, 401);
});
