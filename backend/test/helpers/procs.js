'use strict';
// Spawns mock-medisoft and the Python matcher for integration / e2e tests.
const { spawn, spawnSync } = require('child_process');
const path = require('path');
const ROOT = path.resolve(__dirname, '..', '..', '..');

function python() {
  for (const exe of [process.env.PYTHON, 'python3', 'python', 'py'].filter(Boolean)) {
    const r = spawnSync(exe, ['-c', 'import ortools, fastapi, uvicorn'], { stdio: 'ignore' });
    if (r.status === 0) return exe;
  }
  return null;
}

async function waitFor(url, ms = 30000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try { const r = await fetch(url); if (r.ok) return true; } catch { /* not up yet */ }
    await new Promise(r => setTimeout(r, 300));
  }
  throw new Error('timeout waiting for ' + url);
}

function start(cmd, args, cwd, env) {
  const p = spawn(cmd, args, { cwd, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'], shell: process.platform === 'win32' && !path.isAbsolute(cmd) });
  p.output = '';
  p.stdout.on('data', d => (p.output += d));
  p.stderr.on('data', d => (p.output += d));
  return p;
}

async function startMedisoft(port, env = {}) {
  const p = start(process.execPath, ['server.js'], path.join(ROOT, 'mock-medisoft'), { MEDISOFT_PORT: String(port), ...env });
  await waitFor(`http://localhost:${port}/health`);
  return p;
}

async function startMatcher(port, env = {}) {
  const exe = python();
  if (!exe) return null;
  const p = start(exe, ['-m', 'uvicorn', 'app:app', '--port', String(port), '--log-level', 'warning'], path.join(ROOT, 'matcher'), { LLM_PROVIDER: 'none', ...env });
  await waitFor(`http://localhost:${port}/health`);
  return p;
}

// Windows: the matcher runs under cmd.exe and p.kill() would orphan python, so kill the whole tree
function stop(...ps) { for (const p of ps) if (p && !p.killed) { if (process.platform === 'win32') spawnSync('taskkill', ['/pid', String(p.pid), '/T', '/F'], { stdio: 'ignore' }); else p.kill(); } }

module.exports = { startMedisoft, startMatcher, stop, python, ROOT };
