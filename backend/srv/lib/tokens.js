'use strict';
/*
 * Hospital OAuth tokens: AES-256-GCM encrypted rows in medilink.TokenVault, keyed by TOKEN_ENCRYPTION_KEY (required;
 * the server will not start without it). Each row is bound to its hospital + provider (GCM AAD), so a ciphertext
 * copied to another row does not decrypt.
 * Refresh: medisoft.js refreshes before expiry and on 401, and saves the new tokens here.
 * Token values are never logged.
 */
const cds = require('@sap/cds');
const crypto = require('crypto');
const config = require('./config');
const LOG = cds.log('tokens');

function localKey() {
  if (!config.tokenStoreKey) throw new Error('TOKEN_ENCRYPTION_KEY is not set: hospital tokens cannot be stored. Run npm run env:check.');
  return crypto.createHash('sha256').update(config.tokenStoreKey).digest();
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

const store = () => local;

module.exports = { store, local, encrypt, decrypt };
