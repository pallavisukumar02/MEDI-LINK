'use strict';
/*
 * GET /health/integrations (admin): which SAP and external services are connected, running on their built-in
 * fallback, or misconfigured, in plain words. Never prints a secret: only whether one is present.
 * "connected" for services this check does not call (BPA, AI Core, Alert Notification) means "configured";
 * the text says so.
 */
const cds = require('@sap/cds');
const config = require('./config');
const http = require('./http');
const llm = require('./llm');
const { vcap } = require('./notify');

const item = (service, status, text, mode) => ({ service, status, mode, text });

async function ping(url) {
  try { return (await http.request(url, { timeoutMs: 2000 })).status === 200; } catch { return false; }
}

async function report() {
  const out = [];
  const db = cds.env.requires.db?.kind;
  out.push(db === 'hana'
    ? item('SAP HANA Cloud', 'connected', 'Data is stored in SAP HANA Cloud (HDI container).', 'hana')
    : item('SAP HANA Cloud', 'fallback', 'Using the local SQLite database (development). Bind HANA Cloud to switch.', db));
  out.push(db === 'hana'
    ? item('HANA spatial distances', 'connected', 'Straight-line distances come from HANA ST_Distance.', 'st_distance')
    : item('HANA spatial distances', 'fallback', 'Straight-line distances are computed in the app (Haversine).', 'haversine'));

  const auth = cds.env.requires.auth?.kind;
  const xsuaaCreds = cds.env.requires.auth?.credentials || vcap('xsuaa');
  out.push(auth === 'xsuaa'
    ? item('SAP XSUAA (login and roles)', xsuaaCreds ? 'connected' : 'misconfigured', xsuaaCreds ? 'Users sign in with SAP BTP and get roles from XSUAA.' : 'Login is set to XSUAA but no XSUAA binding was found.', 'xsuaa')
    : item('SAP XSUAA (login and roles)', 'fallback', 'Demo users with password "demo" (development / hybrid only).', auth));

  const tokens = require('./tokens').store();
  const destCreds = cds.env.requires?.destinations?.credentials || cds.env.requires?.destination?.credentials || vcap('destination');
  out.push(tokens.kind === 'destination'
    ? item('SAP Destination service', destCreds ? 'connected' : 'misconfigured', destCreds ? 'Hospital access tokens are stored in the Destination service.' : 'Token store is set to the Destination service, but no binding was found.', 'destination')
    : item('SAP Destination service', 'fallback', 'Hospital access tokens are stored encrypted in the local database.', 'local'));

  if (config.approvalMode === 'bpa') {
    const missing = ['BPA_API_URL', 'BPA_DEFINITION_ID', 'BPA_TOKEN_URL', 'BPA_CLIENT_ID', 'BPA_CLIENT_SECRET'].filter(k => !process.env[k]);
    out.push(missing.length
      ? item('SAP Build Process Automation', 'misconfigured', `Approval mode is "bpa" but ${missing.join(', ')} ${missing.length === 1 ? 'is' : 'are'} missing. MediLink keeps approving with its built-in flow until this is fixed.`, 'bpa')
      : item('SAP Build Process Automation', 'connected', 'Configured: supplier answers, sign-offs and the 30-minute timer run in Build Process Automation (not called by this check).', 'bpa'));
  } else out.push(item('SAP Build Process Automation', 'fallback', 'MediLink runs approvals and the 30-minute timer itself (APPROVAL_MODE=cap).', 'cap'));

  if (config.llmProvider === 'aicore') {
    const missing = [!config.aicoreModel && 'AICORE_MODEL_NAME', !llm.enabled() && config.aicoreModel && 'an AI Core service key or binding'].filter(Boolean);
    out.push(missing.length
      ? item('SAP AI Core (generative AI hub)', 'misconfigured', `LLM_PROVIDER is "aicore" but ${missing.join(' and ')} ${missing.length === 1 ? 'is' : 'are'} missing. Everything keeps working without it.`, 'aicore')
      : item('SAP AI Core (generative AI hub)', 'connected', `Configured with model ${config.aicoreModel} (not called by this check).`, 'aicore'));
  } else out.push(item('SAP AI Core (generative AI hub)', 'fallback', 'AI is off: templates write the explanations; photo reading and alert parsing are switched off.', 'none'));

  if (config.alertNotificationEnabled) {
    const b = cds.env.requires['alert-notification']?.credentials || vcap('alert-notification');
    out.push(item('SAP Alert Notification', b ? 'connected' : 'misconfigured', b ? 'Configured: alerts are also sent by email (not called by this check).' : 'Email alerts are switched on but no Alert Notification binding was found. In-app alerts still work.', 'alert-notification'));
  } else out.push(item('SAP Alert Notification', 'fallback', 'Alerts are shown in the app only.', 'in-app'));

  out.push(config.sapHub.key
    ? item('SAP Business Accelerator Hub (sandbox)', 'connected', 'The SAP hospital reads live sandbox stock (falls back to the offline copy if the sandbox is down).', 'live')
    : item('SAP Business Accelerator Hub (sandbox)', 'fallback', 'The SAP hospital reads the offline sandbox copy (no API key set).', 'fixture'));

  const matcherUp = await ping(`${config.matcherUrl}/health`);
  out.push(matcherUp
    ? item('OR-Tools ranking service', 'connected', 'Supplier plans are ranked with Google OR-Tools.', 'ortools')
    : item('OR-Tools ranking service', config.matcherFallback ? 'fallback' : 'misconfigured', config.matcherFallback ? 'The ranking service is not reachable; MediLink ranks with its simpler built-in method.' : 'The ranking service is not reachable and the built-in fallback is switched off: requests cannot be ranked.', 'greedy'));

  out.push(config.orsKey
    ? item('OpenRouteService (roads)', 'connected', 'Road distances and drive times come from OpenRouteService.', 'ors')
    : item('OpenRouteService (roads)', 'fallback', 'Distances are straight-line x road factor; drive times use the average city speed.', 'haversine'));
  out.push(config.weatherCheckEnabled
    ? item('Open-Meteo (rain check)', 'connected', 'Heavy rain on a delivery route triggers a re-route (no key needed; not called by this check).', 'open-meteo')
    : item('Open-Meteo (rain check)', 'fallback', 'Weather check is off; roads are closed with the manual "Road closed" button only.', 'manual'));

  const medisoftUp = await ping(`${config.medisoft.baseUrl}/health`);
  out.push(item('MediSoft HIS (partner software)', medisoftUp ? 'connected' : 'misconfigured', medisoftUp ? 'The partner hospital software answers.' : 'The partner hospital software does not answer; MediSoft hospitals cannot sync.', 'oauth'));

  const n = s => out.filter(i => i.status === s).length;
  const bad = n('misconfigured');
  return {
    checkedAt: new Date().toISOString(), approvalMode: config.approvalMode, llmProvider: config.llmProvider,
    summary: `${n('connected')} connected, ${n('fallback')} on fallback, ${bad} need${bad === 1 ? 's' : ''} attention.`,
    items: out,
  };
}

module.exports = { report };
