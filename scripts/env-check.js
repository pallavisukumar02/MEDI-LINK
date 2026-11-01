#!/usr/bin/env node
'use strict';
/*
 * npm run env:check [-- --profile standalone|standalone-pg|development|hybrid|production]
 * Says, in plain words, which variables backend/.env still needs for the chosen profile (default: CDS_PROFILE, else
 * standalone). Never prints a value: only names and what they are for. Exit code 1 if something required is missing.
 */
const fs = require('fs');
const path = require('path');
const BACKEND = path.resolve(__dirname, '..', 'backend');
const { missing, warnings, PROFILES } = require(path.join(BACKEND, 'srv', 'lib', 'standalone'));

function report(profile, env) {
  const lines = [`Profile: ${profile}`];
  const need = missing(profile, env);
  if (PROFILES.includes(profile)) {
    lines.push(need.length ? 'Still needed in backend/.env:' : 'All required variables are set.');
    for (const m of need) lines.push(`  - ${m.name}: ${m.why}${m.hard ? ' (MediLink will not start without it)' : ''}`);
  } else if (profile === 'development') lines.push('Nothing is required: development runs on built-in defaults with mocked users.');
  else lines.push('SAP service credentials (HANA, XSUAA, Destination, AI Core) come from cds bind or Cloud Foundry, not from backend/.env. See docs/SAP_GO_LIVE.md.');
  const warn = warnings(profile, env);
  if (warn.length) { lines.push('Please check:'); for (const w of warn) lines.push(`  - ${w}`); }
  const optional = [
    ['Email alerts', env.SMTP_HOST ? 'on (SMTP)' : 'off (set SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, ALERT_EMAIL_FROM, ALERT_EMAIL_TO)'],
    ['AI', String(env.LLM_PROVIDER || 'none').toLowerCase() === 'none' ? 'off (templates only; optional LLM_PROVIDER=openai-compatible)' : `LLM_PROVIDER=${env.LLM_PROVIDER}`],
    ['Road distances', env.ORS_API_KEY ? 'OpenRouteService' : 'straight line x road factor (optional ORS_API_KEY)'],
    ['SAP sandbox hospital', env.SAP_API_HUB_KEY ? 'live sandbox' : 'offline copy (optional SAP_API_HUB_KEY from api.sap.com)'],
  ];
  lines.push('Optional:', ...optional.map(([k, v]) => `  - ${k}: ${v}`));
  return { ok: !need.length, text: lines.join('\n') };
}

if (require.main === module) {
  const file = path.join(BACKEND, '.env');
  const fileEnv = fs.existsSync(file) ? require(path.join(BACKEND, 'node_modules', 'dotenv')).parse(fs.readFileSync(file)) : {};
  const env = { ...fileEnv, ...process.env };
  const i = process.argv.indexOf('--profile');
  const profile = (i > 0 && process.argv[i + 1]) || env.CDS_PROFILE || 'standalone';
  if (!fs.existsSync(file)) console.log('backend/.env does not exist yet: copy backend/.env.example to backend/.env first.\n');
  const r = report(profile, env);
  console.log(r.text);
  process.exit(r.ok ? 0 : 1);
}
module.exports = { report };
