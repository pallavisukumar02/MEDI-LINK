'use strict';
// Deterministic, credential-free environment for tests. Must be required before @sap/cds.
// MEDILINK_TEST_PROFILE=standalone (npm run test:standalone) runs the same tests under the standalone profile:
// MediLink accounts instead of mocked users (same names, password "demo"), in-memory SQLite.
const STANDALONE = {
  CDS_ENV: 'standalone', CDS_REQUIRES_DB_CREDENTIALS_URL: ':memory:', DEMO_PASSWORD: 'demo',
};
module.exports = function testEnv(over = {}) {
  Object.assign(process.env, {
    LLM_PROVIDER: 'none', ORS_API_KEY: '', SAP_API_HUB_KEY: '', ALERT_NOTIFICATION_ENABLED: 'false', APPROVAL_MODE: 'cap',
    WEATHER_CHECK_ENABLED: 'false', JOBS_ENABLED: 'false', TOKEN_STORE: 'local', TOKEN_STORE_KEY: 'test-token-store-key',
    MEDISOFT_OAUTH_CLIENT_ID: 'medilink-client', MEDISOFT_OAUTH_CLIENT_SECRET: 'test-client-secret',
    MEDISOFT_OAUTH_REDIRECT_URI: 'http://localhost:4004/oauth/medisoft/callback', PATIENT_REF_HASH_SALT: 'test-salt',
    CONNECTOR_PAIRING_SECRET: 'test-pairing-secret', SEED_ANCHOR_DATE: '', CDS_ENV: '', SMTP_HOST: '', LLM_BASE_URL: '', LLM_MODEL: '',
    AUTH_JWT_SECRET: 'test-jwt-secret-0123456789abcdef0123456789abcdef', TOKEN_ENCRYPTION_KEY: 'test-token-encryption-key-0123456789abcdef',
    ...(module.exports.standalone && STANDALONE),
    ...over,
  });
};
module.exports.standalone = process.env.MEDILINK_TEST_PROFILE === 'standalone';
