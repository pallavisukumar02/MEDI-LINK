'use strict';
const cds = require('@sap/cds');
const crypto = require('crypto');
const config = require('../lib/config');
const audit = require('../lib/audit');
const medisoft = require('../lib/medisoft');
const sync = require('../lib/sync');
const tokens = require('../lib/tokens');
const { hospitalOf, isAdmin } = require('../lib/users');
const { wrap } = require('./_util');

const LABEL = { MEDISOFT: 'MediSoft HIS', SAP_SANDBOX: 'SAP S/4HANA', CONNECTOR: 'your in-house pharmacy database', SHEET: 'a daily stock sheet', NONE: 'no recognised software' };
const yearOf = d => String(d).slice(0, 4);

function pairingHash(code) {
  const secret = config.connectorPairingSecret || 'dev-pairing-secret';
  return crypto.createHmac('sha256', secret).update(code.toUpperCase()).digest('hex');
}

module.exports = cds.service.impl(function () {
  this.on('licence', wrap(async req => {
    const licenceNo = String(req.data.licenceNo || '').trim().toUpperCase();
    if (!licenceNo) return req.reject({ status: 400, code: 'LICENCE_REQUIRED', message: 'Enter the drug licence number printed on your displayed licence' });
    const lic = await SELECT.one.from('medilink.Licences').where({ licenceNo, partyType: 'HOSPITAL' });
    const h = lic && await SELECT.one.from('medilink.Hospitals').where({ ID: lic.partyId });
    if (!h) {
      await audit.log(req.user.id, 'ONBOARDING_REFUSED', { licenceNo, reason: 'LICENCE_UNKNOWN' });
      return req.reject({ status: 404, code: 'LICENCE_UNKNOWN', message: `We could not find licence ${licenceNo} in the hospital directory. Check the number on your displayed licence, or contact MediLink support.` });
    }
    const today = new Date().toISOString().slice(0, 10);
    const validTill = lic.validTill || h.licenceValidTill;
    if (!validTill || String(validTill) < today) {
      await audit.log(req.user.id, 'ONBOARDING_REFUSED', { licenceNo, hospital: h.ID, reason: 'LICENCE_EXPIRED', validTill });
      return req.reject({ status: 403, code: 'LICENCE_EXPIRED', message: `Licence ${licenceNo} for ${h.name} expired on ${validTill}. Renew it with the State Drugs Control Department before connecting to MediLink.` });
    }
    const own = req.user.attr?.hospital;
    if (own && !isAdmin(req) && own !== h.ID) return req.reject({ status: 403, code: 'FORBIDDEN_HOSPITAL', message: 'This licence belongs to a different hospital than your account' });
    const software = req.data.software && LABEL[req.data.software] ? req.data.software : h.software;
    if (software !== h.software) await UPDATE('medilink.Hospitals').set({ software }).where({ ID: h.ID });
    const base = { hospitalId: h.ID, hospitalName: h.name, address: h.address, licenceNo, licenceValidTill: validTill, licenceValid: true, software, softwareLabel: LABEL[software], connected: !!h.connected };
    const head = `${h.name} · Licence valid till ${yearOf(validTill)} · Your stock is in ${LABEL[software]}.`;
    await audit.log(req.user.id, 'ONBOARDING_LICENCE_OK', { licenceNo, hospital: h.ID, software });

    if (software === 'MEDISOFT') {
      const state = crypto.randomBytes(24).toString('hex');
      await INSERT.into('medilink.OAuthStates').entries({ state, hospital_ID: h.ID, userId: req.user.id, expiresAt: new Date(Date.now() + 10 * 60000).toISOString() });
      return { ...base, next: 'OAUTH_ALLOW', authorizeUrl: medisoft.authorizeUrl(state), message: `${head} Tap "Allow MediLink to read stock and chemo bookings".` };
    }
    if (software === 'CONNECTOR') {
      const code = crypto.randomBytes(5).toString('hex').toUpperCase();
      await INSERT.into('medilink.PairingCodes').entries({ codeHash: pairingHash(code), hospital_ID: h.ID, expiresAt: new Date(Date.now() + 24 * 3600000).toISOString() });
      await audit.log(req.user.id, 'IT_HANDOFF_SENT', { hospital: h.ID, itContact: req.data.itContact ? 'provided' : 'admin-email' });
      return { ...base, next: 'WAIT_FOR_IT', pairingCode: code, itSetupLink: `${config.appBaseUrl}/connector/setup?hospital=${h.ID}`, message: `${head} We sent your IT team a setup link for a small read-only connector. Waiting for your IT team.` };
    }
    if (software === 'SAP_SANDBOX') {
      const r = await sync.syncHospital(h.ID);
      return { ...base, connected: true, next: 'SAP_ADMIN', message: `${head} Your SAP admin connected MediLink once for your hospital; stock synced (${r?.mode}).` };
    }
    return { ...base, next: 'SHEET_UPLOAD', message: `${head} Upload your daily stock sheet (or a photo of the register) to keep your board current.` };
  }));

  this.on('revokeAccess', wrap(async req => {
    const hId = hospitalOf(req, req.data.hospital);
    const store = tokens.store();
    const t = await store.get(hId, medisoft.PROVIDER).catch(() => null);
    if (t) { await medisoft.revoke(t.refresh_token || t.access_token); await store.remove(hId, medisoft.PROVIDER); }
    const now = new Date().toISOString();
    await UPDATE('medilink.ConnectorTokens').set({ revokedAt: now }).where({ hospital_ID: hId, revokedAt: null });
    await UPDATE('medilink.Consents').set({ revokedAt: now }).where({ hospital_ID: hId, revokedAt: null });
    await UPDATE('medilink.Hospitals').set({ connected: false }).where({ ID: hId });
    await audit.log(req.user.id, 'CONSENT_REVOKED', { hospital: hId, providers: [t ? 'MEDISOFT' : null, 'CONNECTOR'].filter(Boolean) });
    return { hospitalId: hId, revoked: true, message: 'MediLink access revoked. No further data will be read.' };
  }));

  this.on('status', wrap(async req => {
    const hId = hospitalOf(req, req.data.hospital);
    const h = await SELECT.one.from('medilink.Hospitals').where({ ID: hId });
    const consents = await SELECT.from('medilink.Consents').where({ hospital_ID: hId }).orderBy('grantedAt desc');
    return { hospitalId: hId, connected: !!h?.connected, software: h?.software, lastSyncedAt: h?.lastSyncedAt, feedStale: !!h?.feedStale, tokenStore: tokens.store().kind, consents: consents.map(c => ({ provider: c.provider, scopes: c.scopes, grantedBy: c.grantedBy, grantedAt: c.grantedAt, revokedAt: c.revokedAt })) };
  }));
});
module.exports.pairingHash = pairingHash;
