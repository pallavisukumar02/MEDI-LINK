'use strict';
// Central, read-only view of environment configuration (never logs secret values).
const num = (v, d) => (v === undefined || v === '' || isNaN(Number(v)) ? d : Number(v));
const bool = (v, d) => (v === undefined || v === '' ? d : /^(1|true|yes|on)$/i.test(String(v).trim()));
const str = (v, d) => (v === undefined || v === '' ? d : String(v).trim());

function load(env = process.env) {
  const standalone = require('./standalone').isStandalone();
  const llm = str(env.LLM_PROVIDER, 'none').toLowerCase();
  return {
    standalone, // no SAP BTP services (profiles standalone / standalone-pg)
    appBaseUrl: str(env.APP_BASE_URL, 'http://localhost:4004'),
    timeZone: str(env.APP_TIME_ZONE, 'Asia/Kolkata'), // times shown to users ("arriving ~3:40 pm")
    safetyMarginPct: num(env.DEFAULT_SAFETY_MARGIN_PCT, 20),
    coverWindowDays: num(env.DEFAULT_COVER_WINDOW_DAYS, 14),
    expiryBufferDays: num(env.EXPIRY_BUFFER_DAYS, 7),
    nearExpiryDays: num(env.NEAR_EXPIRY_DAYS, 60),
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
    llmProvider: standalone && llm === 'aicore' ? 'none' : llm, // aicore | openai-compatible | none; AI Core is BTP, so off in standalone
    llmBaseUrl: str(env.LLM_BASE_URL, '').replace(/\/+$/, ''),
    llmApiKey: str(env.LLM_API_KEY, ''),
    llmModel: str(env.LLM_MODEL, ''),
    aicoreResourceGroup: str(env.AICORE_RESOURCE_GROUP, 'default'),
    aicoreModel: str(env.AICORE_MODEL_NAME, ''),
    aicoreKeyPath: str(env.AICORE_SERVICE_KEY_PATH, './aicore-key.json'),
    trustFeedLlmEnabled: bool(env.TRUST_FEED_LLM_ENABLED, true),
    approvalMode: standalone ? 'cap' : str(env.APPROVAL_MODE, 'cap').toLowerCase(), // cap | bpa (BPA is BTP: never in standalone)
    bpaApiUrl: str(env.BPA_API_URL, ''),
    bpaDefinitionId: str(env.BPA_DEFINITION_ID, ''),
    bpaDestination: str(env.BPA_DESTINATION, 'medilink-bpa'),
    alertNotificationEnabled: bool(env.ALERT_NOTIFICATION_ENABLED, false),
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
    tokenStore: str(env.TOKEN_STORE, ''), // '' = auto | local | destination
    tokenStoreKey: str(env.TOKEN_ENCRYPTION_KEY, str(env.TOKEN_STORE_KEY, '')), // TOKEN_STORE_KEY = older name
    jobsEnabled: bool(env.JOBS_ENABLED, true),
    demoFreshSeed: bool(env.DEMO_FRESH_SEED, true),
  };
}

let cached;
module.exports = new Proxy({}, {
  get(_, k) {
    if (k === 'reload') return () => (cached = load());
    if (k === 'load') return load;
    cached ??= load();
    return cached[k];
  },
});
