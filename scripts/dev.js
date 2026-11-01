#!/usr/bin/env node
'use strict';
/*
 * npm run dev  ->  starts the whole MediLink prototype locally (synthetic data):
 *   cap        CAP backend: SQLite file backend/db/medilink.sqlite, MediLink accounts  :4004
 *   matcher    Python FastAPI + OR-Tools                                             :5001
 *   medisoft   mock MediSoft HIS (OAuth 2.0 server + read APIs)                      :4100
 *   simulator  courier rider + temperature logger, through each delivery's courier link
 * On a fresh clone it first creates backend/.env from backend/.env.example with fresh random secrets (file mode 0600,
 * never printed; DEMO_PASSWORD=demo) and, if missing, the database with the synthetic seed and demo users (db:init).
 * Ctrl+C stops everything. Pass --no-sim / --no-matcher to skip a process.
 * Ports come from PORT (CAP) and MATCHER_URL (matcher). Never prints environment values.
 */
const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '..');
const args = new Set(process.argv.slice(2));
const win = process.platform === 'win32';
const envFile = path.join(ROOT, 'backend', '.env');

if (process.env.NODE_ENV === 'production') { console.error('\n  npm run dev is for development. In production use: npm start\n'); process.exit(1); }
require('./dev-env').ensureDevEnv();
// read backend/.env without exporting it: mock-medisoft would take its PORT (CAP's) as its own
const fileEnv = require(path.join(ROOT, 'backend', 'node_modules', 'dotenv')).parse(fs.readFileSync(envFile));
const env = { ...fileEnv, ...process.env };
const capPort = Number(env.PORT) || 4004;
const matcherPort = Number(new URL(env.MATCHER_URL || 'http://localhost:5001').port) || 5001;

function prepare() {
  const hard = require(path.join(ROOT, 'backend', 'srv', 'lib', 'config')).missing(env).filter(m => m.hard);
  if (hard.length) { console.error(`\n  MediLink needs, in backend/.env:\n${hard.map(m => `   - ${m.name}: ${m.why}`).join('\n')}\n  Run npm run env:check for the full list.\n`); process.exit(1); }
  const db = path.resolve(ROOT, 'backend', env.CDS_REQUIRES_DB_CREDENTIALS_URL || 'db/medilink.sqlite');
  if (!fs.existsSync(db)) {
    const r = spawnSync(process.execPath, [path.join(__dirname, 'db.js'), 'init'], { stdio: 'inherit' });
    if (r.status !== 0) process.exit(r.status ?? 1);
  }
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
  // Refresh the date-relative synthetic seed once, before anything reads it (db:init loads it into a new database).
  try { const seed = require(path.join(ROOT, 'seed', 'generate')); if (seed.isStale()) seed.run({ quiet: true }); } catch (e) { console.warn('[dev] seed refresh skipped:', e.message); }
  prepare();

  run('medisoft', process.execPath, ['server.js'], path.join(ROOT, 'mock-medisoft'));
  if (!args.has('--no-matcher')) {
    const py = python();
    if (py) run('matcher', py, ['-m', 'uvicorn', 'app:app', '--port', String(matcherPort), '--log-level', 'warning'], path.join(ROOT, 'matcher'), env); // backend/.env: LLM_*, AICORE_*, MATCHER_TOKEN
    else console.warn('[dev] Python with ortools/fastapi/uvicorn not found: CAP will use its built-in greedy ranking fallback. Run: pip install -r matcher/requirements.txt');
  }
  const cdsBin = path.join(ROOT, 'backend', 'node_modules', '@sap', 'cds', 'bin', 'serve.js');
  run('cap', process.execPath, [cdsBin], path.join(ROOT, 'backend'));

  const up = await waitFor(`http://localhost:${capPort}/health`);
  if (!up) { console.error(`[dev] CAP did not come up on :${capPort}`); return shutdown(1); }
  // the simulator lists the courier links as "admin" with the demo password (HTTP Basic), then acts through each link
  if (!args.has('--no-sim')) run('simulator', process.execPath, ['index.js'], path.join(ROOT, 'simulator'), { SIM_USER: 'admin', SIM_PASSWORD: env.DEMO_PASSWORD || '' });
  console.log('\n  MediLink dev stack is up (synthetic data; database backend/db/medilink.sqlite, npm run db:reset starts it again):');
  console.log(`    CAP       http://localhost:${capPort}   (users: asha, ravi, meera, kiran, admin ... password = DEMO_PASSWORD, "demo" by default; couriers use a link)`);
  console.log('    MediSoft  http://localhost:4100');
  console.log(`    Matcher   http://localhost:${matcherPort}/health`);
  console.log('    Demo      npm run demo   (runs the PRD section 18 script against this stack)\n');
})();
