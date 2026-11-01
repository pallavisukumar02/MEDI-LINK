'use strict';
/*
 * Token storage abstraction for hospital OAuth tokens (the one tokenStore adapter).
 *   - "destination": SAP BTP Destination service (hybrid / production; credentials from cds bind / VCAP)
 *   - "local":       AES-256-GCM encrypted rows in medilink.TokenVault (development; always in standalone mode,
 *                    where TOKEN_ENCRYPTION_KEY is required). Each row is bound to its hospital + provider (GCM AAD),
 *                    so a ciphertext copied to another row does not decrypt.
 * Refresh: medisoft.js refreshes before expiry and on 401, and saves the new tokens here.
 * Token values are never logged.
 */
const cds = require('@sap/cds');
const crypto = require('crypto');
const config = require('./config');
const http = require('./http');
const { vcap } = require('./notify');
const LOG = cds.log('tokens');

// ---------- local encrypted store ----------
let devKey;
function localKey() {
  if (config.tokenStoreKey) return crypto.createHash('sha256').update(config.tokenStoreKey).digest();
  if (config.standalone) throw new Error('TOKEN_ENCRYPTION_KEY is not set: hospital tokens cannot be stored. Run npm run env:check.');
  if (!devKey) {
    if (config.medisoft.clientSecret) devKey = crypto.createHash('sha256').update('medilink-token-store:' + config.medisoft.clientSecret).digest();
    else { devKey = crypto.randomBytes(32); LOG.warn('TOKEN_STORE_KEY not set: using an ephemeral key (tokens are lost on restart)'); }
  }
  return devKey;
}
function encrypt(obj, aad) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', localKey(), iv);
  if (aad) c.setAAD(Buffer.from(aad));
  const data = Buffer.concat([c.update(JSON.stringify(obj), 'utf8'), c.final()]);
  return [iv, c.getAuthTag(), data].map(b => b.toString('base64')).join('.');
}
function decrypt(s, aad) {
  const [iv, tag, data] = s.split('.').map(p => Buffer.from(p, 'base64'));
  const d = crypto.createDecipheriv('aes-256-gcm', localKey(), iv);
  if (aad) d.setAAD(Buffer.from(aad));
  d.setAuthTag(tag);
  return JSON.parse(Buffer.concat([d.update(data), d.final()]).toString('utf8'));
}

const aadOf = (hospitalId, provider) => `medilink-token:${hospitalId}:${provider}`;
const local = {
  kind: 'local',
  async save(hospitalId, provider, tokens) {
    const row = { hospital_ID: hospitalId, provider, ciphertext: encrypt(tokens, aadOf(hospitalId, provider)), updatedAt: new Date().toISOString() };
    await UPSERT.into('medilink.TokenVault').entries(row);
  },
  async get(hospitalId, provider) {
    const row = await SELECT.one.from('medilink.TokenVault').where({ hospital_ID: hospitalId, provider });
    if (!row) return null;
    try { return decrypt(row.ciphertext, aadOf(hospitalId, provider)); } catch { LOG.warn('token decrypt failed (wrong key or tampered row) for', hospitalId); return null; }
  },
  async remove(hospitalId, provider) {
    await DELETE.from('medilink.TokenVault').where({ hospital_ID: hospitalId, provider });
  },
};

// ---------- SAP BTP Destination service ----------
function destinationCreds() {
  return cds.env.requires?.destinations?.credentials || cds.env.requires?.destination?.credentials || vcap('destination');
}
let cachedToken;
async function destToken(c) {
  if (cachedToken && cachedToken.exp > Date.now() + 30000) return cachedToken.value;
  const res = await http.request(`${c.url}/oauth/token`, {
    method: 'POST', headers: { Authorization: 'Basic ' + Buffer.from(`${c.clientid}:${c.clientsecret}`).toString('base64'), 'Content-Type': 'application/x-www-form-urlencoded' },
    body: http.form({ grant_type: 'client_credentials', client_id: c.clientid }),
  });
  if (res.status !== 200) throw new Error('Destination service token request failed: ' + res.status);
  cachedToken = { value: res.json.access_token, exp: Date.now() + (res.json.expires_in || 3600) * 1000 };
  return cachedToken.value;
}
const destName = (h, p) => `medilink-${h}-${p}`.toLowerCase();
const destination = {
  kind: 'destination',
  async save(hospitalId, provider, tokens) {
    const c = destinationCreds();
    const t = await destToken(c);
    const body = {
      Name: destName(hospitalId, provider), Type: 'HTTP', URL: config.medisoft.baseUrl, Authentication: 'NoAuthentication', ProxyType: 'Internet',
      Description: `MediLink read-only token for ${hospitalId} (${provider})`,
      'medilink.tokens': JSON.stringify(tokens),
    };
    const base = `${c.uri}/destination-configuration/v1/subaccountDestinations`;
    const headers = { Authorization: 'Bearer ' + t, 'Content-Type': 'application/json' };
    let res = await http.request(base, { method: 'POST', headers, body: JSON.stringify(body) });
    if (res.status === 409) res = await http.request(base, { method: 'PUT', headers, body: JSON.stringify(body) });
    if (res.status >= 300) throw new Error('Destination save failed: ' + res.status);
  },
  async get(hospitalId, provider) {
    const c = destinationCreds();
    const t = await destToken(c);
    const res = await http.request(`${c.uri}/destination-configuration/v1/subaccountDestinations/${destName(hospitalId, provider)}`, { headers: { Authorization: 'Bearer ' + t } });
    if (res.status === 404) return null;
    if (res.status !== 200) throw new Error('Destination read failed: ' + res.status);
    try { return JSON.parse(res.json['medilink.tokens']); } catch { return null; }
  },
  async remove(hospitalId, provider) {
    const c = destinationCreds();
    const t = await destToken(c);
    await http.request(`${c.uri}/destination-configuration/v1/subaccountDestinations/${destName(hospitalId, provider)}`, { method: 'DELETE', headers: { Authorization: 'Bearer ' + t } });
  },
};

function store() {
  if (config.standalone) return local; // no BTP Destination service in standalone mode
  const pick = config.tokenStore || (destinationCreds() ? 'destination' : 'local');
  return pick === 'destination' ? destination : local;
}

module.exports = { store, local, destination, encrypt, decrypt };
