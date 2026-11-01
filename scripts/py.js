#!/usr/bin/env node
'use strict';
// Cross-platform Python launcher for npm scripts: node scripts/py.js <cwd> <python args...>
// Picks $PYTHON, python3, python or py (Windows), whichever runs.
const { spawnSync } = require('child_process');
const path = require('path');
const [cwd, ...args] = process.argv.slice(2);
const win = process.platform === 'win32';
const exe = [process.env.PYTHON, 'python3', 'python', 'py'].filter(Boolean)
  .find(e => spawnSync(e, ['--version'], { stdio: 'ignore', shell: win }).status === 0);
if (!exe) { console.error('Python 3.11+ not found (set PYTHON=<path to python>)'); process.exit(1); }
const r = spawnSync(exe, args, { cwd: path.resolve(__dirname, '..', cwd || '.'), stdio: 'inherit', shell: win });
process.exit(r.status ?? 1);
