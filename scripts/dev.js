#!/usr/bin/env node
'use strict';
/*
 * npm run dev  ->  starts the whole MediLink prototype locally, no SAP credentials needed:
 *   cap        CAP backend, development profile (SQLite in-memory, mocked users)  :4004
 *   matcher    Python FastAPI + OR-Tools                                         :5001
 *   medisoft   mock MediSoft HIS (OAuth 2.0 server + read APIs)                  :4100
 *   simulator  delivery-partner telemetry (GPS + temperature)
 * Ctrl+C stops everything. Pass --no-sim / --no-matcher to skip a process.
 * Never prints environment values.
 */
const { spawn, spawnSync } = require('child_process');
const path = require('path');
const ROOT = path.resolve(__dirname, '..');
const args = new Set(process.argv.slice(2));
const win = process.platform === 'win32';

function python() {
  for (const exe of [process.env.PYTHON, 'python3', 'python', 'py'].filter(Boolean)) {
    const r = spawnSync(exe, ['-c', 'import ortools, fastapi, uvicorn'], { stdio: 'ignore', shell: win });
    if (r.status === 0) return exe;
  }
  return null;
}

const COLORS = { cap: 36, matcher: 35, medisoft: 33, simulator: 32 };
const procs = [];
function run(name, cmd, cmdArgs, cwd, env = {}) {
  const p = spawn(cmd, cmdArgs, { cwd, env: { ...process.env, ...env }, shell: win, stdio: ['ignore', 'pipe', 'pipe'] });
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
  for (const p of procs) if (!p.killed) p.kill();
  setTimeout(() => process.exit(code), 300);
}
process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));

(async () => {
  // Refresh the date-relative synthetic seed once, before anything reads it.
  try { const seed = require(path.join(ROOT, 'seed', 'generate')); if (seed.isStale()) seed.run({ quiet: true }); } catch (e) { console.warn('[dev] seed refresh skipped:', e.message); }

  run('medisoft', process.execPath, ['server.js'], path.join(ROOT, 'mock-medisoft'));
  if (!args.has('--no-matcher')) {
    const py = python();
    if (py) run('matcher', py, ['-m', 'uvicorn', 'app:app', '--port', '5001', '--log-level', 'warning'], path.join(ROOT, 'matcher'));
    else console.warn('[dev] Python with ortools/fastapi/uvicorn not found: CAP will use its built-in greedy ranking fallback. Run: pip install -r matcher/requirements.txt');
  }
  const cdsBin = path.join(ROOT, 'backend', 'node_modules', '@sap', 'cds', 'bin', 'serve.js');
  run('cap', process.execPath, [cdsBin, '--profile', 'development'], path.join(ROOT, 'backend'), { CDS_ENV: 'development' });

  const up = await waitFor('http://localhost:4004/health');
  if (!up) { console.error('[dev] CAP did not come up on :4004'); return shutdown(1); }
  if (!args.has('--no-sim')) run('simulator', process.execPath, ['index.js'], path.join(ROOT, 'simulator'));
  console.log('\n  MediLink dev stack is up (synthetic data, no SAP credentials):');
  console.log('    CAP       http://localhost:4004   (users: asha, ravi, meera, kiran, partner, admin ... password "demo")');
  console.log('    MediSoft  http://localhost:4100');
  console.log('    Matcher   http://localhost:5001/health');
  console.log('    Demo      npm run demo   (runs the PRD section 18 script against this stack)\n');
})();
