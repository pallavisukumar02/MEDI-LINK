#!/usr/bin/env node
'use strict';
/*
 * npm run env:check
 * Says, in plain words, which variables backend/.env still needs and which optional integrations are on. Production
 * rules apply when NODE_ENV=production. Never prints a value: only names and what they are for. Exit code 1 if
 * something required is missing.
 */
const fs = require('fs');
const path = require('path');
const BACKEND = path.resolve(__dirname, '..', 'backend');
const { missing, warnings } = require(path.join(BACKEND, 'srv', 'lib', 'config'));

function report(env) {
  const need = missing(env);
  const lines = [`Checking for ${env.NODE_ENV === 'production' ? 'production (NODE_ENV=production)' : 'development'}.`];
  lines.push(need.length ? 'Still needed in backend/.env:' : 'All required variables are set.');
  for (const m of need) lines.push(`  - ${m.name}: ${m.why}${m.hard ? ' (MediLink will not start without it)' : ''}`);
  const warn = warnings(env);
  if (warn.length) { lines.push('Please check:'); for (const w of warn) lines.push(`  - ${w}`); }
  const llm = String(env.LLM_PROVIDER || 'none').toLowerCase();
  const optional = [
    ['Email alerts', env.SMTP_HOST ? 'on (SMTP)' : 'off (set SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, ALERT_EMAIL_FROM, ALERT_EMAIL_TO)'],
    ['SAP Alert Notification', env.ALERT_NOTIFICATION_URL ? 'on' : 'off (optional: ALERT_NOTIFICATION_URL, ALERT_NOTIFICATION_CLIENT_ID, ALERT_NOTIFICATION_CLIENT_SECRET)'],
    ['AI', llm === 'none' ? 'off (templates only; optional LLM_PROVIDER=openai-compatible or aicore)' : `LLM_PROVIDER=${llm}`],
    ['Approvals', String(env.APPROVAL_MODE || 'cap').toLowerCase() === 'bpa' ? 'SAP Build Process Automation (APPROVAL_MODE=bpa)' : 'built-in (optional APPROVAL_MODE=bpa for SAP Build Process Automation)'],
    ['Road distances', env.ORS_API_KEY ? 'OpenRouteService' : 'straight line x road factor (optional ORS_API_KEY)'],
    ['SAP sandbox hospital', env.SAP_API_HUB_KEY ? 'live sandbox' : 'offline copy (optional SAP_API_HUB_KEY from api.sap.com)'],
  ];
  lines.push('Optional:', ...optional.map(([k, v]) => `  - ${k}: ${v}`));
  return { ok: !need.length, text: lines.join('\n') };
}

if (require.main === module) {
  const file = path.join(BACKEND, '.env');
  const fileEnv = fs.existsSync(file) ? require(path.join(BACKEND, 'node_modules', 'dotenv')).parse(fs.readFileSync(file)) : {};
  if (!fs.existsSync(file)) console.log('backend/.env does not exist yet: npm run dev creates it for development; for production copy backend/.env.example and fill it in.\n');
  const r = report({ ...fileEnv, ...process.env });
  console.log(r.text);
  process.exit(r.ok ? 0 : 1);
}
module.exports = { report };
