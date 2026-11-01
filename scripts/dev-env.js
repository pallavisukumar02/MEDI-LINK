'use strict';
// Development only: create backend/.env with random secrets in place of every change-me placeholder (never in production).
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const BACKEND = path.resolve(__dirname, '..', 'backend');
const envFile = path.join(BACKEND, '.env');

function ensureDevEnv(tag = 'dev') {
  if (process.env.NODE_ENV === 'production' || fs.existsSync(envFile)) return envFile;
  const text = fs.readFileSync(path.join(BACKEND, '.env.example'), 'utf8')
    .replace(/^DEMO_PASSWORD=\S*/m, 'DEMO_PASSWORD=demo')
    .replace(/^([A-Z0-9_]+)=change-me\S*/gm, (_, k) => `${k}=${crypto.randomBytes(32).toString('hex')}`);
  fs.writeFileSync(envFile, text, { mode: 0o600, flag: 'wx' });
  console.log(`[${tag}] created backend/.env with fresh random development secrets (git-ignored; never commit it)`);
  return envFile;
}

module.exports = { ensureDevEnv, envFile };
