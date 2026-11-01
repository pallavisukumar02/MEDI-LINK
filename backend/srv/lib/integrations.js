'use strict';
/*
 * GET /health/integrations (admin) and the one-line headline on GET /health: what MediLink runs on and which
 * optional integrations are on (connected), off (fallback: the built-in way is used) or misconfigured, in plain
 * words. Never prints a secret: only whether one is present. "connected" for services this check does not call
 * (email, SAP Alert Notification, AI, SAP Build Process Automation) means "configured"; the text says so.
 */
const cds = require('@sap/cds');
const config = require('./config');
const http = require('./http');
const llm = require('./llm');
const { channel } = require('./notify');

const item = (service, status, text, mode) => ({ service, status, mode, text });
const missingText = keys => `${keys.join(' and ')} ${keys.length === 1 ? 'is' : 'are'} missing`;

async function ping(url) {
  try { return (await http.request(url, { timeoutMs: 2000 })).status === 200; } catch { return false; }
}

const dbName = () => (cds.env.requires.db?.credentials?.url === ':memory:' ? 'SQLite (in memory)' : 'SQLite file');
const aiOn = () => config.llmProvider !== 'none' && llm.enabled();
const ALERTS = { 'alert-notification': 'in-app + SAP Alert Notification', smtp: 'in-app + email', console: 'in-app' };

/** One line for /health, e.g. "Database: SQLite file · Logins: MediLink accounts · Approvals: built-in · Alerts: in-app · AI: off" */
function headline() {
  return `Database: ${dbName()} · Logins: MediLink accounts · Approvals: ${config.approvalMode === 'bpa' ? 'SAP Build Process Automation' : 'built-in'} · Alerts: ${ALERTS[channel()]} · AI: ${aiOn() ? config.llmProvider : 'off'}`;
}

function coreItems() {
  return [
    item('Database', 'connected', dbName() === 'SQLite file' ? 'Data is stored in a SQLite file; it survives restarts.' : 'Data is stored in SQLite in memory (tests).', 'sqlite'),
    item('Logins', 'connected', 'People sign in with MediLink accounts; an admin creates them and resets passwords.', 'medilink-accounts'),
    item('Hospital access tokens', 'connected', 'Stored encrypted (AES-256-GCM) in the MediLink database.', 'local'),
  ];
}

function alertItems() {
  const { from } = config.smtp, to = config.alertEmailTo;
  const an = config.alertNotification;
  return [
    !config.smtp.host
      ? item('Email alerts (SMTP)', 'fallback', 'Off: alerts are shown in the app only (set SMTP_HOST to also send email).', 'in-app')
      : from
        ? item('Email alerts (SMTP)', 'connected', `Shortfalls, low stock, expiring and expired lots, temperature problems, recalls, licence reminders and stale feeds are also emailed to each hospital's own pharmacists and approvers (else its admin email${to ? ', else the ALERT_EMAIL_TO list' : ''}); not called by this check.`, 'smtp')
        : item('Email alerts (SMTP)', 'misconfigured', 'SMTP is set but ALERT_EMAIL_FROM is empty, so no email goes out. In-app alerts still work.', 'smtp'),
    !an.url
      ? item('SAP Alert Notification', 'fallback', 'Off (optional): set ALERT_NOTIFICATION_URL and its client id and secret to also send every alert there.', 'off')
      : an.clientId && an.clientSecret
        ? item('SAP Alert Notification', 'connected', 'Every alert is also sent to SAP Alert Notification (not called by this check).', 'alert-notification')
        : item('SAP Alert Notification', 'misconfigured', `ALERT_NOTIFICATION_URL is set but ${missingText(['ALERT_NOTIFICATION_CLIENT_ID', 'ALERT_NOTIFICATION_CLIENT_SECRET'].filter(k => !process.env[k]))}. In-app alerts still work.`, 'alert-notification'),
  ];
}

function aiItem() {
  const name = 'AI (LLM)';
  if (config.llmProvider === 'openai-compatible') {
    const missing = ['LLM_BASE_URL', 'LLM_MODEL'].filter(k => !process.env[k]);
    return missing.length
      ? item(name, 'misconfigured', `LLM_PROVIDER is "openai-compatible" but ${missingText(missing)}. Everything keeps working without it.`, 'openai-compatible')
      : item(name, 'connected', `Configured with model ${config.llmModel} on an OpenAI-compatible API (not called by this check).`, 'openai-compatible');
  }
  if (config.llmProvider === 'aicore') {
    const missing = [!config.aicoreModel && 'AICORE_MODEL_NAME', config.aicoreModel && !llm.enabled() && 'the SAP AI Core service key file (AICORE_SERVICE_KEY_PATH)'].filter(Boolean);
    return missing.length
      ? item(name, 'misconfigured', `LLM_PROVIDER is "aicore" but ${missingText(missing)}. Everything keeps working without it.`, 'aicore')
      : item(name, 'connected', `Configured with SAP AI Core, model ${config.aicoreModel} (not called by this check).`, 'aicore');
  }
  return item(name, 'fallback', 'Off: templates write the explanations; photo reading and alert parsing are switched off.', 'none');
}

function approvalItem() {
  const name = 'SAP Build Process Automation';
  if (config.approvalMode !== 'bpa') return item(name, 'fallback', 'Off (optional): MediLink runs supplier answers, sign-offs and the 30-minute timer itself (APPROVAL_MODE=cap).', 'cap');
  const missing = ['BPA_API_URL', 'BPA_DEFINITION_ID', 'BPA_TOKEN_URL', 'BPA_CLIENT_ID', 'BPA_CLIENT_SECRET'].filter(k => !process.env[k]);
  return missing.length
    ? item(name, 'misconfigured', `Approval mode is "bpa" but ${missingText(missing)}. MediLink keeps approving with its built-in flow until this is fixed.`, 'bpa')
    : item(name, 'connected', 'Configured: supplier answers, sign-offs and the 30-minute timer run in SAP Build Process Automation (not called by this check).', 'bpa');
}

async function sourceItems() {
  const out = [];
  out.push(config.sapHub.key
    ? item('SAP Business Accelerator Hub (sandbox)', 'connected', 'The SAP hospital reads live sandbox stock (falls back to the offline copy if the sandbox is down).', 'live')
    : item('SAP Business Accelerator Hub (sandbox)', 'fallback', 'The SAP hospital reads the offline sandbox copy (no API key set).', 'fixture'));

  const matcherUp = await ping(`${config.matcherUrl}/health`);
  out.push(matcherUp
    ? item('OR-Tools ranking service', 'connected', 'Supplier plans are ranked with Google OR-Tools.', 'ortools')
    : item('OR-Tools ranking service', config.matcherFallback ? 'fallback' : 'misconfigured', config.matcherFallback ? 'The ranking service is not reachable; MediLink ranks with its simpler built-in method.' : 'The ranking service is not reachable and the built-in fallback is switched off: requests cannot be ranked.', 'greedy'));

  out.push(config.orsKey
    ? item('OpenRouteService (roads)', 'connected', 'Road distances and drive times come from OpenRouteService.', 'ors')
    : item('OpenRouteService (roads)', 'fallback', 'Distances are straight-line (Haversine) x road factor; drive times use the average city speed.', 'haversine'));
  out.push(config.weatherCheckEnabled
    ? item('Open-Meteo (rain check)', 'connected', 'Heavy rain on a delivery route triggers a re-route (no key needed; not called by this check).', 'open-meteo')
    : item('Open-Meteo (rain check)', 'fallback', 'Weather check is off; roads are closed with the manual "Road closed" button only.', 'manual'));

  const medisoftUp = await ping(`${config.medisoft.baseUrl}/health`);
  out.push(item('MediSoft HIS (partner software)', medisoftUp ? 'connected' : 'misconfigured', medisoftUp ? 'The partner hospital software answers.' : 'The partner hospital software does not answer; MediSoft hospitals cannot sync.', 'oauth'));
  return out;
}

async function report() {
  const out = [...coreItems(), ...alertItems(), aiItem(), approvalItem(), ...await sourceItems()];
  const n = s => out.filter(i => i.status === s).length;
  const bad = n('misconfigured');
  return {
    checkedAt: new Date().toISOString(), headline: headline(),
    approvalMode: config.approvalMode, llmProvider: config.llmProvider,
    summary: `${n('connected')} connected, ${n('fallback')} on fallback, ${bad} need${bad === 1 ? 's' : ''} attention.`,
    items: out,
  };
}

module.exports = { report, headline };
