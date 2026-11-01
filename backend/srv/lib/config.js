'use strict';
// Central, read-only view of environment configuration (never logs secret values).
const num = (v, d) => (v === undefined || v === '' || isNaN(Number(v)) ? d : Number(v));
const bool = (v, d) => (v === undefined || v === '' ? d : /^(1|true|yes|on)$/i.test(String(v).trim()));
const str = (v, d) => (v === undefined || v === '' ? d : String(v).trim());
const proxyOf = v => (/^\d+$/.test(v) ? Number(v) : /^(true|false)$/i.test(v) ? v.toLowerCase() === 'true' : v); // hop count, boolean or IP/CIDR list

function load(env = process.env) {
  return {
    appBaseUrl: str(env.APP_BASE_URL, 'http://localhost:4004'),
    timeZone: str(env.APP_TIME_ZONE, 'Asia/Kolkata'), // times shown to users ("arriving ~3:40 pm")
    safetyMarginPct: num(env.DEFAULT_SAFETY_MARGIN_PCT, 20),
    coverWindowDays: num(env.DEFAULT_COVER_WINDOW_DAYS, 14),
    expiryBufferDays: num(env.EXPIRY_BUFFER_DAYS, 7),
    nearExpiryDays: num(env.NEAR_EXPIRY_DAYS, 60),
    expiryAlertDays: str(env.EXPIRY_ALERT_DAYS, '90,60,30,7'), // expiry alert tiers in days (lib/monitor.js)
    supplierResponseTimeoutMin: num(env.SUPPLIER_RESPONSE_TIMEOUT_MIN, 30),
    syncIntervalSec: num(env.SYNC_INTERVAL_SEC, 900),
    staleFeedMinutes: num(env.STALE_FEED_MINUTES, 60),
    coldChainMinC: num(env.COLD_CHAIN_MIN_C, 2),
    coldChainMaxC: num(env.COLD_CHAIN_MAX_C, 8),
    ambientMinC: num(env.AMBIENT_MIN_C, 2),
    ambientMaxC: num(env.AMBIENT_MAX_C, 30),
    frozenMinC: num(env.FROZEN_MIN_C, -25),
    frozenMaxC: num(env.FROZEN_MAX_C, -15),
    longRouteKm: num(env.LONG_ROUTE_KM, 25),
    longRouteMin: num(env.LONG_ROUTE_MIN, 90),
    handlingMin: num(env.ROUTE_HANDLING_MIN, 20),
    citySpeedKmh: num(env.CITY_SPEED_KMH, 22),
    roadFactor: num(env.ROAD_FACTOR, 1.3),
    nearbyKm: num(env.NEARBY_KM, 1), // live tracking: courier this close to the receiver = "nearby"
    courierLinkTtlHours: num(env.COURIER_LINK_TTL_HOURS, 24), // hard expiry of a courier link
    licenceReminderDays: num(env.LICENCE_REMINDER_DAYS, 30),
    patientRefSalt: str(env.PATIENT_REF_HASH_SALT, ''),
    matcherUrl: str(env.MATCHER_URL, 'http://localhost:5001'),
    matcherTimeoutMs: num(env.MATCHER_TIMEOUT_MS, 10000),
    matcherFallback: bool(env.MATCHER_FALLBACK_ENABLED, true),
    matcherToken: str(env.MATCHER_TOKEN, ''),
    orsKey: str(env.ORS_API_KEY, ''),
    orsBaseUrl: str(env.ORS_BASE_URL, 'https://api.openrouteservice.org'),
    openMeteoUrl: str(env.OPEN_METEO_BASE_URL, 'https://api.open-meteo.com/v1/forecast'),
    weatherCheckEnabled: bool(env.WEATHER_CHECK_ENABLED, true),
    weatherCloseMmPerH: num(env.WEATHER_CLOSE_MM_PER_H, 20),
    llmProvider: str(env.LLM_PROVIDER, 'none').toLowerCase(), // none | openai-compatible | aicore
    llmBaseUrl: str(env.LLM_BASE_URL, '').replace(/\/+$/, ''),
    llmApiKey: str(env.LLM_API_KEY, ''),
    llmModel: str(env.LLM_MODEL, ''),
    aicoreResourceGroup: str(env.AICORE_RESOURCE_GROUP, 'default'),
    aicoreModel: str(env.AICORE_MODEL_NAME, ''),
    aicoreKeyPath: str(env.AICORE_SERVICE_KEY_PATH, './aicore-key.json'),
    trustFeedLlmEnabled: bool(env.TRUST_FEED_LLM_ENABLED, true),
    approvalMode: str(env.APPROVAL_MODE, 'cap').toLowerCase(), // cap (built-in) | bpa (SAP Build Process Automation)
    bpaApiUrl: str(env.BPA_API_URL, ''),
    bpaDefinitionId: str(env.BPA_DEFINITION_ID, ''),
    alertNotification: { url: str(env.ALERT_NOTIFICATION_URL, '').replace(/\/+$/, ''), clientId: str(env.ALERT_NOTIFICATION_CLIENT_ID, ''), clientSecret: str(env.ALERT_NOTIFICATION_CLIENT_SECRET, '') },
    alertEmailTo: str(env.ALERT_EMAIL_TO, ''),
    smtp: { host: str(env.SMTP_HOST, ''), port: num(env.SMTP_PORT, 587), user: str(env.SMTP_USER, ''), pass: str(env.SMTP_PASS, ''), from: str(env.ALERT_EMAIL_FROM, '') },
    authJwtSecret: str(env.AUTH_JWT_SECRET, ''),
    authJwtTtl: str(env.AUTH_JWT_TTL, '8h'),
    medisoft: {
      baseUrl: str(env.MEDISOFT_BASE_URL, 'http://localhost:4100'),
      clientId: str(env.MEDISOFT_OAUTH_CLIENT_ID, 'medilink-client'),
      clientSecret: str(env.MEDISOFT_OAUTH_CLIENT_SECRET, 'dev-medisoft-secret'), // dev default only; set a random value in .env
      redirectUri: str(env.MEDISOFT_OAUTH_REDIRECT_URI, 'http://localhost:4004/oauth/medisoft/callback'),
      scopes: str(env.MEDISOFT_SCOPES, 'stock.read schedule.read'),
    },
    sapHub: {
      key: str(env.SAP_API_HUB_KEY, ''),
      base: str(env.SAP_API_HUB_SANDBOX_BASE, 'https://sandbox.api.sap.com/s4hanacloud'),
      stockPath: str(env.SAP_API_MATERIAL_STOCK_PATH, '/sap/opu/odata/sap/API_MATERIAL_STOCK_SRV'),
      batchPath: str(env.SAP_API_BATCH_PATH, '/sap/opu/odata4/sap/api_batch/srvd_a2x/sap/batch/0001'),
    },
    connectorPairingSecret: str(env.CONNECTOR_PAIRING_SECRET, ''),
    tokenStoreKey: str(env.TOKEN_ENCRYPTION_KEY, ''),
    jobsEnabled: bool(env.JOBS_ENABLED, true),
    demoFreshSeed: bool(env.DEMO_FRESH_SEED, true),
    // Express "trust proxy": off by default. Behind a reverse proxy use the hop count (1) or the proxy IPs/CIDRs, never "true".
    trustProxy: proxyOf(str(env.TRUST_PROXY, 'false')),
  };
}

// ---------- required variables (server start-up check, npm run db:init, npm run env:check) ----------
const weak = v => !v || /change-me|placeholder|^<.*>$/i.test(v);
const secret = v => !weak(v) && v.length >= 32;
const production = env => env.NODE_ENV === 'production';
// hard = the server will not start without it
const VARS = [
  { name: 'AUTH_JWT_SECRET', hard: true, ok: secret, why: 'signs login tokens (at least 32 random characters)' },
  { name: 'TOKEN_ENCRYPTION_KEY', hard: true, ok: secret, why: 'encrypts hospital access tokens (at least 32 random characters; keep it stable or hospitals must reconnect)' },
  { name: 'DEMO_PASSWORD', ok: (v, env) => !weak(v) && (!production(env) || v.length >= 8), why: 'password of the demo users that npm run db:init creates (at least 8 characters in production)' },
  { name: 'PATIENT_REF_HASH_SALT', ok: v => !weak(v), why: 'salt for hashing patient numbers at the source (same value for MediSoft and the connector)' },
  { name: 'MEDISOFT_OAUTH_CLIENT_SECRET', ok: v => !weak(v), why: 'OAuth client secret shared by MediLink and the MediSoft hospital software' },
  { name: 'CONNECTOR_PAIRING_SECRET', ok: v => !weak(v), why: 'protects one-time pairing codes for database connectors' },
];

/** Required variables that are missing or still placeholders: [{ name, why, hard }]. Never returns a value. */
function missing(env = process.env) {
  return VARS.filter(v => !v.ok(env[v.name] || '', env)).map(({ name, why, hard }) => ({ name, why, hard: !!hard }));
}

/** Optional settings that are only half filled in. Plain sentences, no values. */
function warnings(env = process.env) {
  const out = [];
  const half = (on, keys, what) => { for (const k of keys) if (env[on] && !env[k]) out.push(`${on} is set but ${k} is empty, so ${what}.`); };
  half('SMTP_HOST', ['ALERT_EMAIL_FROM'], 'alert emails cannot be sent');
  half('ALERT_NOTIFICATION_URL', ['ALERT_NOTIFICATION_CLIENT_ID', 'ALERT_NOTIFICATION_CLIENT_SECRET'], 'SAP Alert Notification stays off');
  const llm = String(env.LLM_PROVIDER || 'none').toLowerCase();
  if (llm === 'openai-compatible') for (const k of ['LLM_BASE_URL', 'LLM_MODEL']) if (!env[k]) out.push(`LLM_PROVIDER is openai-compatible but ${k} is empty, so AI stays off.`);
  if (llm === 'aicore' && !env.AICORE_MODEL_NAME) out.push('LLM_PROVIDER is aicore but AICORE_MODEL_NAME is empty, so AI stays off.');
  if (String(env.APPROVAL_MODE || 'cap').toLowerCase() === 'bpa') for (const k of ['BPA_API_URL', 'BPA_DEFINITION_ID', 'BPA_TOKEN_URL', 'BPA_CLIENT_ID', 'BPA_CLIENT_SECRET']) if (!env[k]) out.push(`APPROVAL_MODE is bpa but ${k} is empty, so MediLink keeps running approvals itself.`);
  return out;
}

/** Throws a plain-language error if MediLink cannot run safely (no login secret, no token key). */
function assertConfig(env = process.env) {
  const hard = missing(env).filter(m => m.hard);
  if (hard.length) throw new Error(`MediLink cannot start: ${hard.map(m => `${m.name} is missing or too weak (${m.why})`).join('; ')}. Run npm run env:check.`);
}

const helpers = { load, missing, warnings, assertConfig };
let cached;
module.exports = new Proxy({}, {
  get(_, k) {
    if (k === 'reload') return () => (cached = load());
    if (k in helpers) return helpers[k];
    cached ??= load();
    return cached[k];
  },
});
