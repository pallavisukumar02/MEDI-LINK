'use strict';
/*
 * The SQLite file survives a restart: npm run db:init (scripts/db.js) builds the file, a real CAP process writes to it,
 * a second process started on the same file still has the data, the accounts and even the issued login token.
 * db:init on an existing file keeps the data. Production refuses to start without strong secrets. Uses a temp file
 * and a free port, never backend/db or a fixed port.
 */
require('./helpers/env')();
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const { stop, freePort, ROOT } = require('./helpers/procs');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'medilink-db-'));
const SERVE = path.join(ROOT, 'backend', 'node_modules', '@sap', 'cds', 'bin', 'serve.js');
let BASE;
const env = {
  ...process.env, NODE_ENV: '', CDS_ENV: '', CDS_REQUIRES_DB_CREDENTIALS_URL: path.join(dir, 'medilink.sqlite'),
  DEMO_PASSWORD: 'demo-pass-123', JOBS_ENABLED: 'false', MATCHER_URL: 'http://localhost:1',
};
beforeAll(async () => { env.PORT = String(await freePort()); BASE = `http://localhost:${env.PORT}`; });

async function startCap() {
  const p = spawn(process.execPath, [SERVE], { cwd: path.join(ROOT, 'backend'), env, stdio: ['ignore', 'pipe', 'pipe'] });
  p.output = ''; p.stdout.on('data', d => (p.output += d)); p.stderr.on('data', d => (p.output += d));
  const end = Date.now() + 60000;
  while (Date.now() < end) {
    try { if ((await fetch(BASE + '/health')).ok) return p; } catch { /* starting */ }
    if (p.exitCode !== null) throw new Error('CAP exited: ' + p.output.slice(-800));
    await new Promise(r => setTimeout(r, 300));
  }
  stop(p); throw new Error('CAP did not start: ' + p.output.slice(-800));
}
const post = (p, body, token) => fetch(BASE + p, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(token && { Authorization: 'Bearer ' + token }) }, body: JSON.stringify(body) });
const get = (p, token) => fetch(BASE + p, { headers: { Authorization: 'Bearer ' + token } });
const login = async (username, password = 'demo-pass-123') => (await (await post('/auth/login', { username, password })).json()).token;

afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

test('db:init, write, restart: data, accounts and sessions are still there', async () => {
  const init = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'db.js'), 'init'], { env, encoding: 'utf8' });
  expect([init.status, init.stdout]).toEqual([0, expect.stringMatching(/Ready: 5 hospitals \(synthetic\), 11 users \(11 demo users created/)]);
  expect(init.stdout + init.stderr).not.toMatch(/demo-pass-123|test-jwt-secret/);

  let cap = await startCap();
  let adminToken, before;
  try {
    expect((await (await fetch(BASE + '/health')).json()).services).toMatch(/^Database: SQLite file · Logins: MediLink accounts/);
    adminToken = await login('admin');
    expect((await post('/auth/users', { username: 'persist.test', password: 'persist-pass-1', role: 'approver', hospital: 'H4' }, adminToken)).status).toBe(201);
    before = (await (await get('/me/city', adminToken)).json()).rows.length;
    expect(before).toBeGreaterThan(0);
  } finally { stop(cap); }
  await new Promise(r => setTimeout(r, 1000));

  const again = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'db.js'), 'init'], { env, encoding: 'utf8' });
  expect(again.stdout).toMatch(/already has MediLink data: kept/);

  cap = await startCap();
  try {
    expect((await get('/auth/me', adminToken)).status).toBe(200); // the session row survived too
    const t = await login('persist.test', 'persist-pass-1');
    expect((await (await get('/auth/me', t)).json())).toMatchObject({ username: 'persist.test', role: 'approver', hospital: 'H4' });
    expect((await (await get('/me/city', adminToken)).json()).rows.length).toBe(before);
  } finally { stop(cap); }
}, 180000);

test('production refuses to start while demo accounts still use the development password "demo"', async () => {
  const dev = { ...env, CDS_REQUIRES_DB_CREDENTIALS_URL: path.join(dir, 'dev.sqlite'), DEMO_PASSWORD: 'demo' };
  expect(spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'db.js'), 'init'], { env: dev, encoding: 'utf8' }).status).toBe(0);
  const r = spawnSync(process.execPath, [SERVE], { cwd: path.join(ROOT, 'backend'), env: { ...dev, NODE_ENV: 'production' }, encoding: 'utf8', timeout: 60000 });
  expect(r.status).not.toBe(0);
  expect(r.stdout + r.stderr).toMatch(/cannot start in production: demo accounts still use the development password "demo" \(.*admin/);
}, 120000);

test('production refuses to start without strong secrets and never prints them', async () => {
  const r = spawnSync(process.execPath, [SERVE], { cwd: path.join(ROOT, 'backend'), env: { ...env, NODE_ENV: 'production', AUTH_JWT_SECRET: 'weak-secret', TOKEN_ENCRYPTION_KEY: '' }, encoding: 'utf8', timeout: 60000 });
  expect(r.status).not.toBe(0);
  expect(r.stdout + r.stderr).toMatch(/MediLink cannot start: AUTH_JWT_SECRET is missing or too weak/);
  expect(r.stdout + r.stderr).not.toMatch(/weak-secret/);
}, 90000);
