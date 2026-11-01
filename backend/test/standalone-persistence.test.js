'use strict';
/*
 * Standalone SQLite file survives a restart: npm run db:init (scripts/db.js) builds the file, a real CAP process in the
 * standalone profile writes to it, a second process started on the same file still has the data, the accounts and
 * even the issued login token. db:init on an existing file keeps the data. Uses a temp file, never backend/db.
 */
require('./helpers/env')();
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const { stop, ROOT } = require('./helpers/procs');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'medilink-sa-'));
const PORT = 4600 + Math.floor(Math.random() * 300);
const BASE = `http://localhost:${PORT}`;
const env = {
  ...process.env, NODE_ENV: '', CDS_ENV: 'standalone', CDS_REQUIRES_DB_CREDENTIALS_URL: path.join(dir, 'medilink.sqlite'),
  DEMO_PASSWORD: 'demo-pass-123', PORT: String(PORT), JOBS_ENABLED: 'false', MATCHER_URL: 'http://localhost:1',
};

async function startCap() {
  const p = spawn(process.execPath, [path.join(ROOT, 'backend', 'node_modules', '@sap', 'cds', 'bin', 'serve.js'), '--profile', 'standalone'], { cwd: path.join(ROOT, 'backend'), env, stdio: ['ignore', 'pipe', 'pipe'] });
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
  expect([init.status, init.stdout]).toEqual([0, expect.stringMatching(/Ready: 5 hospitals \(synthetic\), 14 users \(14 demo users created/)]);
  expect(init.stdout + init.stderr).not.toMatch(/demo-pass-123|test-jwt-secret/);

  let cap = await startCap();
  let adminToken, before;
  try {
    expect((await (await fetch(BASE + '/health')).json()).services).toMatch(/^Database: SQLite file \(standalone\)/);
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

test('db:export writes CAP seed CSVs that load back unchanged (moving to HANA Cloud); no accounts or tokens', async () => {
  const out = path.join(dir, 'export');
  const r = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'db.js'), 'export', '--out', out], { env, encoding: 'utf8' });
  expect([r.status, r.stdout]).toEqual([0, expect.stringMatching(/Exported \d+ tables/)]);
  const files = fs.readdirSync(out);
  for (const f of ['medilink-Hospitals.csv', 'medilink-Lots.csv', 'medilink-AuditLog.csv', 'medilink-ConnectorTokens.csv']) expect(files).toContain(f);
  for (const f of ['medilink-Users.csv', 'medilink-Sessions.csv', 'medilink-TokenVault.csv']) expect(files).not.toContain(f);
  expect(fs.readFileSync(path.join(out, 'medilink-Hospitals.csv'), 'utf8')).not.toMatch(/\$2[ab]\$|demo-pass/);

  const cds = require('@sap/cds');
  const model = await cds.load(path.join(ROOT, 'backend', 'srv'));
  const csvs = Object.fromEntries(files.map(f => [f, fs.readFileSync(path.join(out, f), 'utf8')]));
  const db = await cds.deploy(model, { silent: true }, csvs).to('sqlite::memory:');
  for (const [entity, file] of [['medilink.Hospitals', 'medilink-Hospitals.csv'], ['medilink.Lots', 'medilink-Lots.csv'], ['medilink.AuditLog', 'medilink-AuditLog.csv']]) {
    const [{ n }] = await db.run(SELECT.from(entity).columns('count(*) as n'));
    expect([entity, n]).toEqual([entity, fs.readFileSync(path.join(out, file), 'utf8').trim().split('\n').length - 1]);
  }
  const h1 = await db.run(SELECT.one.from('medilink.Hospitals').where({ ID: 'H1' }));
  expect(h1.address).toMatch(/,/); // commas inside values survive
}, 120000);
