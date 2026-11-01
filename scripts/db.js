#!/usr/bin/env node
'use strict';
/*
 * The MediLink database: a SQLite file (backend/db/medilink.sqlite), no database server.
 *   npm run db:init      schema + synthetic seed + demo users (password = DEMO_PASSWORD)
 *   npm run db:reset     delete it and init again (ALL data in it is lost; stop MediLink first)
 * init never overwrites a database that already has MediLink tables: it keeps the data and only adds missing demo users.
 * npm run dev runs init by itself when the file does not exist yet. Reads backend/.env; never prints a value from it.
 */
const fs = require('fs');
const path = require('path');
const BACKEND = path.resolve(__dirname, '..', 'backend');
const reset = process.argv.includes('reset');
process.chdir(BACKEND);
require('./dev-env').ensureDevEnv('db'); // a fresh clone can run db:init / db:reset before npm run dev
require(path.join(BACKEND, 'node_modules', 'dotenv')).config({ path: path.join(BACKEND, '.env'), quiet: true });
const cds = require(path.join(BACKEND, 'node_modules', '@sap', 'cds'));
const config = require(path.join(BACKEND, 'srv', 'lib', 'config'));
const fail = msg => { console.error(`\n  ${msg}\n`); process.exit(1); };

(async () => {
  const need = config.missing().filter(m => m.hard || m.name === 'DEMO_PASSWORD');
  if (need.length) fail(`Cannot set up the database yet. In backend/.env:\n${need.map(m => `   - ${m.name}: ${m.why}`).join('\n')}\n  Then run this again. (npm run env:check lists everything.)`);
  try { const seed = require('../seed/generate'); if (seed.isStale()) seed.run({ quiet: true }); } catch (e) { console.warn('seed refresh skipped:', e.message); }

  const file = cds.env.requires.db.credentials?.url;
  if (reset && file && file !== ':memory:') for (const f of [file, file + '-wal', file + '-shm']) fs.rmSync(path.resolve(BACKEND, f), { force: true });

  const model = await cds.load('*');
  const db = await cds.connect.to('db');
  const where = path.relative(process.cwd(), path.resolve(BACKEND, file));
  let exists = false;
  try { await db.run('SELECT 1 FROM medilink_Hospitals'); exists = true; } catch { /* no tables yet */ }

  if (exists && !reset) console.log(`  ${where} already has MediLink data: kept as it is. (npm run db:reset starts again from the seed.)`);
  else {
    console.log(`  ${reset ? 'Resetting' : 'Creating'} ${where}: tables + synthetic seed data ...`);
    await cds.deploy(model).to(db, { silent: true });
  }
  cds.model = db.model ??= model;
  const users = await require(path.join(BACKEND, 'srv', 'lib', 'accounts')).seedDemoUsers();
  const [{ n }] = await db.run(SELECT.from('medilink.Hospitals').columns('count(*) as n'));
  const [{ u }] = await db.run(SELECT.from('medilink.Users').columns('count(*) as u'));
  console.log(`  Ready: ${n} hospitals (synthetic), ${u} users${users.created ? ` (${users.created} demo users created; password = DEMO_PASSWORD)` : ''}.\n`);
  await db.disconnect?.();
  process.exit(0);
})().catch(e => fail(`Database set-up failed: ${e.message}`));
