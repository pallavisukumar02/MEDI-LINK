'use strict';
// Deterministic, credential-free environment for tests. Must be required before @sap/cds.
// The [test] profile runs on in-memory SQLite; the server seeds the demo users with DEMO_PASSWORD "demo".
// The matcher and MediSoft point at a closed port unless a test starts its own (on a free port): a running
// npm run dev or another test run is never reached.
module.exports = function testEnv(over = {}) {
  Object.assign(process.env, {
    MATCHER_URL: 'http://localhost:1', MEDISOFT_BASE_URL: 'http://localhost:1', LLM_PROVIDER: 'none', ORS_API_KEY: '', SAP_API_HUB_KEY: '', ALERT_NOTIFICATION_URL: '', APPROVAL_MODE: 'cap',
    WEATHER_CHECK_ENABLED: 'false', JOBS_ENABLED: 'false', DEMO_PASSWORD: 'demo',
    MEDISOFT_OAUTH_CLIENT_ID: 'medilink-client', MEDISOFT_OAUTH_CLIENT_SECRET: 'test-client-secret',
    MEDISOFT_OAUTH_REDIRECT_URI: 'http://localhost:4004/oauth/medisoft/callback', PATIENT_REF_HASH_SALT: 'test-salt',
    CONNECTOR_PAIRING_SECRET: 'test-pairing-secret', SEED_ANCHOR_DATE: '', CDS_ENV: '', SMTP_HOST: '', LLM_BASE_URL: '', LLM_MODEL: '',
    AUTH_JWT_SECRET: 'test-jwt-secret-0123456789abcdef0123456789abcdef', TOKEN_ENCRYPTION_KEY: 'test-token-encryption-key-0123456789abcdef',
    ...over,
  });
};
