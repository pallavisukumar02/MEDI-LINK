#!/usr/bin/env node
'use strict';
/*
 * Standalone database (no Docker, no database server on your machine):
 *   npm run db:init      backend/db/medilink.sqlite: schema + synthetic seed + demo users (password = DEMO_PASSWORD)
 *   npm run db:reset     delete it and init again (ALL data in it is lost)
 *   npm run db:init:pg   the same on PostgreSQL (DATABASE_URL in backend/.env); npm run db:reset:pg wipes and inits again
 *   npm run db:export    every MediLink table as CAP seed CSVs in backend/db/export/ (-- --pg for PostgreSQL), for
 *                        moving to SAP HANA Cloud (docs/SAP_GO_LIVE.md). Accounts, sessions and encrypted hospital
 *                        tokens are left out: on BTP, XSUAA has the users and hospitals reconnect.
 * init never overwrites a database that already has MediLink tables: it keeps the data and only adds missing demo users.
 * Reads backend/.env; never prints a value from it.
 */
const fs = require('fs');
const path = require('path');
const BACKEND = path.resolve(__dirname, '..', 'backend');
const args = process.argv.slice(2);
const reset = args.includes('reset');
process.chdir(BACKEND);
require(path.join(BACKEND, 'node_modules', 'dotenv')).config({ path: path.join(BACKEND, '.env'), quiet: true });
const profile = args.includes('--pg') || process.env.CDS_PROFILE === 'standalone-pg' ? 'standalone-pg' : 'standalone';
process.env.CDS_ENV = profile;
const cds = require(path.join(BACKEND, 'node_modules', '@sap', 'cds'));
const standalone = require(path.join(BACKEND, 'srv', 'lib', 'standalone'));
const fail = msg => { console.error(`\n  ${msg}\n`); process.exit(1); };

const NOT_EXPORTED = new Set(['medilink.Users', 'medilink.Sessions', 'medilink.TokenVault', 'medilink.OAuthStates', 'medilink.IdempotencyKeys', 'medilink.PhotoPreviews']);
const csvCell = v => (v === null || v === undefined ? '' : /[;"\r\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v));

async function exportCsv() {
  standalone.configureDb();
  const model = await cds.load('*');
  const db = await cds.connect.to('db');
  cds.model = db.model ??= model;
  const out = path.resolve(BACKEND, args[args.indexOf('--out') + 1] && args.includes('--out') ? args[args.indexOf('--out') + 1] : 'db/export');
  fs.mkdirSync(out, { recursive: true });
  let files = 0;
  for (const e of Object.values(db.model.definitions)) {
    if (e.kind !== 'entity' || !e.name.startsWith('medilink.') || e.query || e.projection || NOT_EXPORTED.has(e.name)) continue;
    const cols = Object.values(e.elements).filter(el => !el.isAssociation && !el.virtual).map(el => el.name);
    const rows = await db.run(SELECT.from(e.name).columns(cols));
    fs.writeFileSync(path.join(out, `${e.name.replace('.', '-')}.csv`), [cols.join(';'), ...rows.map(r => cols.map(c => csvCell(r[c])).join(';'))].join('\n') + '\n');
    files++;
  }
  console.log(`  Exported ${files} tables to ${path.relative(process.cwd(), out)} (accounts, sessions and hospital tokens left out).`);
  await db.disconnect?.();
  process.exit(0);
}

(async () => {
  if (args.includes('export')) return exportCsv();
  const need = standalone.missing(profile).filter(m => m.hard || m.name === 'DEMO_PASSWORD');
  if (need.length) fail(`Cannot set up the ${profile} database yet. In backend/.env:\n${need.map(m => `   - ${m.name}: ${m.why}`).join('\n')}\n  Then run this again. (npm run env:check lists everything.)`);
  try { const seed = require('../seed/generate'); if (seed.isStale()) seed.run({ quiet: true }); } catch (e) { console.warn('seed refresh skipped:', e.message); }

  standalone.configureDb();
  const file = profile === 'standalone' && cds.env.requires.db.credentials?.url;
  if (reset && file && file !== ':memory:') for (const f of [file, file + '-wal', file + '-shm']) fs.rmSync(path.resolve(BACKEND, f), { force: true });

  const model = await cds.load('*');
  const db = await cds.connect.to('db');
  const where = file ? path.relative(process.cwd(), path.resolve(BACKEND, file)) : 'PostgreSQL (DATABASE_URL)';
  let exists = false;
  try { await db.run('SELECT 1 FROM medilink_Hospitals'); exists = true; } catch { /* no tables yet */ }

  if (exists && !reset) console.log(`  ${where} already has MediLink data: kept as it is. (npm run db:reset${profile === 'standalone-pg' ? ':pg' : ''} starts again from the seed.)`);
  else {
    console.log(`  ${reset ? 'Resetting' : 'Creating'} ${where}: tables + synthetic seed data ...`);
    await cds.deploy(model).to(db, { silent: true });
  }
  cds.model = db.model ??= model;
  const users = await require(path.join(BACKEND, 'srv', 'lib', 'accounts')).seedDemoUsers();
  const [{ n }] = await db.run(SELECT.from('medilink.Hospitals').columns('count(*) as n'));
  const [{ u }] = await db.run(SELECT.from('medilink.Users').columns('count(*) as u'));
  console.log(`  Ready: ${n} hospitals (synthetic), ${u} users${users.created ? ` (${users.created} demo users created; password = DEMO_PASSWORD)` : ''}.`);
  console.log(`  Next: npm run start:standalone${profile === 'standalone-pg' ? ' -- --pg' : ''}\n`);
  await db.disconnect?.();
  process.exit(0);
})().catch(e => fail(`Database set-up failed: ${e.message}`));
