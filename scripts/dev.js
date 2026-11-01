#!/usr/bin/env node
'use strict';
/*
 * npm run dev  ->  starts the whole MediLink prototype locally, no SAP credentials needed:
 *   cap        CAP backend, development profile (SQLite in-memory, mocked users)  :4004
 *   matcher    Python FastAPI + OR-Tools                                         :5001
 *   medisoft   mock MediSoft HIS (OAuth 2.0 server + read APIs)                  :4100
 *   simulator  delivery-partner telemetry (GPS + temperature)
 * Ctrl+C stops everything. Pass --no-sim / --no-matcher to skip a process.
 *
 * npm run start:standalone (= --standalone [--pg]) starts the same processes with CAP in the standalone profile:
 * persistent database (SQLite file from npm run db:init, or PostgreSQL with --pg) and real MediLink logins.
 * Ports come from PORT (CAP) and MATCHER_URL (matcher). Never prints environment values.
 */
const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '..');
const args = new Set(process.argv.slice(2));
const win = process.platform === 'win32';
// read backend/.env without exporting it: mock-medisoft would take its PORT (CAP's) as its own
const envFile = path.join(ROOT, 'backend', '.env');
const fileEnv = fs.existsSync(envFile) ? require(path.join(ROOT, 'backend', 'node_modules', 'dotenv')).parse(fs.readFileSync(envFile)) : {};
const env = { ...fileEnv, ...process.env };
const standaloneMode = args.has('--standalone');
const profile = !standaloneMode ? 'development' : args.has('--pg') || env.CDS_PROFILE === 'standalone-pg' ? 'standalone-pg' : 'standalone';
const capPort = Number(env.PORT) || 4004;
const matcherPort = Number(new URL(env.MATCHER_URL || 'http://localhost:5001').port) || 5001;

function checkStandalone() {
  const { missing } = require(path.join(ROOT, 'backend', 'srv', 'lib', 'standalone'));
  const hard = missing(profile, env).filter(m => m.hard);
  if (hard.length) { console.error(`\n  Standalone mode needs, in backend/.env:\n${hard.map(m => `   - ${m.name}: ${m.why}`).join('\n')}\n  Run npm run env:check for the full list.\n`); process.exit(1); }
  const db = path.resolve(ROOT, 'backend', env.CDS_REQUIRES_DB_CREDENTIALS_URL || 'db/medilink.sqlite');
  if (profile === 'standalone' && !fs.existsSync(db)) { console.error('\n  No database yet. Run: npm run db:init\n'); process.exit(1); }
}

function python() {
  for (const exe of [process.env.PYTHON, 'python3', 'python', 'py'].filter(Boolean)) {
    const r = spawnSync(exe, ['-c', 'import ortools, fastapi, uvicorn'], { stdio: 'ignore' });
    if (r.status === 0) return exe;
  }
  return null;
}

const COLORS = { cap: 36, matcher: 35, medisoft: 33, simulator: 32 };
const procs = [];
function run(name, cmd, cmdArgs, cwd, env = {}) {
  const p = spawn(cmd, cmdArgs, { cwd, env: { ...process.env, ...env }, shell: win && !path.isAbsolute(cmd), stdio: ['ignore', 'pipe', 'pipe'] });
  const tag = `\x1b[${COLORS[name] || 37}m[${name}]\x1b[0m `;
  const pipe = s => s.on('data', d => String(d).split(/\r?\n/).filter(Boolean).forEach(l => console.log(tag + l)));
  pipe(p.stdout); pipe(p.stderr);
  p.on('exit', code => { console.log(`${tag}exited (${code})`); if (name === 'cap') shutdown(code ?? 1); });
  procs.push(p);
  return p;
}

async function waitFor(url, ms = 60000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try { if ((await fetch(url)).ok) return true; } catch { /* not up yet */ }
    await new Promise(r => setTimeout(r, 500));
  }
  return false;
}

let stopping = false;
function shutdown(code = 0) {
  if (stopping) return; stopping = true;
  // Windows: python runs under cmd.exe, and p.kill() would leave it running (port 5001 stays taken)
  for (const p of procs) if (!p.killed) { if (win) spawnSync('taskkill', ['/pid', String(p.pid), '/T', '/F'], { stdio: 'ignore' }); else p.kill(); }
  setTimeout(() => process.exit(code), 300);
}
process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));

(async () => {
  if (standaloneMode) checkStandalone();
  // Refresh the date-relative synthetic seed once, before anything reads it.
  try { const seed = require(path.join(ROOT, 'seed', 'generate')); if (seed.isStale()) seed.run({ quiet: true }); } catch (e) { console.warn('[dev] seed refresh skipped:', e.message); }

  run('medisoft', process.execPath, ['server.js'], path.join(ROOT, 'mock-medisoft'));
  if (!args.has('--no-matcher')) {
    const py = python();
    if (py) run('matcher', py, ['-m', 'uvicorn', 'app:app', '--port', String(matcherPort), '--log-level', 'warning'], path.join(ROOT, 'matcher'));
    else console.warn('[dev] Python with ortools/fastapi/uvicorn not found: CAP will use its built-in greedy ranking fallback. Run: pip install -r matcher/requirements.txt');
  }
  const cdsBin = path.join(ROOT, 'backend', 'node_modules', '@sap', 'cds', 'bin', 'serve.js');
  run('cap', process.execPath, [cdsBin, '--profile', profile], path.join(ROOT, 'backend'), { CDS_ENV: profile });

  const up = await waitFor(`http://localhost:${capPort}/health`);
  if (!up) { console.error(`[dev] CAP did not come up on :${capPort}`); return shutdown(1); }
  // standalone: the simulator signs in as "sim" with the demo password (HTTP Basic against MediLink accounts)
  if (!args.has('--no-sim')) run('simulator', process.execPath, ['index.js'], path.join(ROOT, 'simulator'), standaloneMode ? { SIM_USER: 'sim', SIM_PASSWORD: env.DEMO_PASSWORD || '' } : {});
  if (standaloneMode) {
    console.log(`\n  MediLink standalone stack is up (${profile}: no SAP BTP, persistent database, real logins; synthetic data):`);
    console.log(`    CAP       http://localhost:${capPort}   (sign in with POST /auth/login: asha, ravi, meera, kiran, partner, admin ... password = DEMO_PASSWORD)`);
  } else {
    console.log('\n  MediLink dev stack is up (synthetic data, no SAP credentials):');
    console.log(`    CAP       http://localhost:${capPort}   (users: asha, ravi, meera, kiran, partner, admin ... password "demo")`);
  }
  console.log('    MediSoft  http://localhost:4100');
  console.log(`    Matcher   http://localhost:${matcherPort}/health`);
  console.log('    Demo      npm run demo   (runs the PRD section 18 script against this stack)\n');
})();
