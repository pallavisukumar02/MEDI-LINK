'use strict';
const cds = require('@sap/cds');
const crypto = require('crypto');
const config = require('../lib/config');
const audit = require('../lib/audit');
const medisoft = require('../lib/medisoft');
const sync = require('../lib/sync');
const tokens = require('../lib/tokens');
const notify = require('../lib/notify');
const { isEmail } = require('../lib/accounts');
const { t } = require('../lib/messages');
const { hospitalOf, isAdmin } = require('../lib/users');
const ratelimit = require('../lib/ratelimit');
const { wrap } = require('./_util');

const LABEL = { MEDISOFT: 'MediSoft HIS', SAP_SANDBOX: 'SAP S/4HANA', CONNECTOR: 'your in-house pharmacy database', SHEET: 'a daily stock sheet', NONE: 'no recognised software' };
const yearOf = d => String(d).slice(0, 4);

function pairingHash(code) {
  const secret = config.connectorPairingSecret || 'dev-pairing-secret';
  return crypto.createHmac('sha256', secret).update(code.toUpperCase()).digest('hex');
}

module.exports = cds.service.impl(function () {
  this.on('licence', wrap(async req => {
    const own = isAdmin(req) ? null : hospitalOf(req); // fail closed: no hospital attribute -> NO_HOSPITAL
    ratelimit.check(req, 'licence', 20, 15 * ratelimit.MIN); // licence numbers are guessable
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
    if (own && own !== h.ID) return req.reject({ status: 403, code: 'FORBIDDEN_HOSPITAL', message: 'This licence belongs to a different hospital than your account' });
    const software = req.data.software && LABEL[req.data.software] ? req.data.software : h.software;
    if (software !== h.software) await UPDATE('medilink.Hospitals').set({ software }).where({ ID: h.ID });
    const base = { hospitalId: h.ID, hospitalName: h.name, address: h.address, licenceNo, licenceValidTill: validTill, licenceValid: true, software, softwareLabel: LABEL[software], connected: !!h.connected };
    const head = `${h.name} · Licence valid till ${yearOf(validTill)} · Your stock is in ${LABEL[software]}.`;
    await audit.log(req.user.id, 'ONBOARDING_LICENCE_OK', { licenceNo, hospital: h.ID, software });
    await UPDATE('medilink.Hospitals').set({ licenceCheckedAt: new Date().toISOString() }).where({ ID: h.ID, licenceCheckedAt: null });

    if (software === 'MEDISOFT') {
      const state = crypto.randomBytes(24).toString('hex'), { verifier, challenge } = medisoft.pkce();
      await INSERT.into('medilink.OAuthStates').entries({ state, hospital_ID: h.ID, userId: req.user.id, expiresAt: new Date(Date.now() + 10 * 60000).toISOString(), codeVerifier: verifier });
      return { ...base, next: 'OAUTH_ALLOW', authorizeUrl: medisoft.authorizeUrl(state, challenge), message: `${head} Tap "Allow MediLink to read stock and chemo bookings".` };
    }
    if (software === 'CONNECTOR') {
      const code = crypto.randomBytes(5).toString('hex').toUpperCase();
      await INSERT.into('medilink.PairingCodes').entries({ codeHash: pairingHash(code), hospital_ID: h.ID, expiresAt: new Date(Date.now() + 24 * 3600000).toISOString() });
      const itContact = String(req.data.itContact || '').trim().slice(0, 120) || null;
      if (itContact) await UPDATE('medilink.Hospitals').set({ itContact }).where({ ID: h.ID });
      const itSetupLink = `${config.appBaseUrl}/connector/setup?hospital=${h.ID}`;
      // the link only: the pairing code stays on the pharmacist's screen, so a mistyped address cannot pair a connector
      const emailed = isEmail(itContact) && notify.sendMail(itContact, t('email.subject.it_setup', { hospital: h.name }), t('email.it_setup', { hospital: h.name, link: itSetupLink }));
      await audit.log(req.user.id, 'IT_HANDOFF_SENT', { hospital: h.ID, itContact: itContact ? 'provided' : 'none', emailed: !!emailed });
      return { ...base, next: 'WAIT_FOR_IT', pairingCode: code, itSetupLink, message: `${head} ${t(emailed ? 'onboarding.it.emailed' : 'onboarding.it.share', { contact: itContact })}` };
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
    // Consent withdrawn: hashed patient bookings are erased now. Stock rows stay (in-flight transfers and receipts read
    // them) but a disconnected hospital is left out of matching and the city view; the next snapshot after reconnecting replaces them.
    const bookingsPurged = await DELETE.from('medilink.Bookings').where({ hospital_ID: hId });
    await audit.log(req.user.id, 'CONSENT_REVOKED', { hospital: hId, providers: [t ? 'MEDISOFT' : null, 'CONNECTOR'].filter(Boolean), bookingsPurged });
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
