'use strict';
/*
 * Notifications: always a Notification row + WebSocket "alert" (the in-app alerts on /me/home), plus one outbound
 * channel, chosen here and nowhere else:
 *   - "alert-notification": SAP Alert Notification (optional; ALERT_NOTIFICATION_URL + client id/secret), every alert
 *   - "smtp":               email through any SMTP server (SMTP_HOST set), for EMAIL_KINDS
 *   - "console":            no email; the alert is logged
 * Outbound messages go per hospital to that hospital's own people (recipients()), once the transaction has committed.
 * A monitoring run passes { digest } to collect its new rows, then sendDigest() sends one message per hospital.
 */
const cds = require('@sap/cds');
const config = require('./config');
const http = require('./http');
const ws = require('./ws');
const { t } = require('./messages');
const LOG = cds.log('notify');

async function notify({ hospital, kind, severity = 'INFO', message, ref, dueDate, dedupeKey, tier }, { digest } = {}) {
  const row = { ID: cds.utils.uuid(), hospital_ID: hospital || null, kind, severity, message, ref: ref || null, dueDate: dueDate || null, createdAt: new Date().toISOString(), read: false, dedupeKey: dedupeKey || null, tier: tier ?? null };
  await INSERT.into('medilink.Notifications').entries(row);
  ws.emit('alert', { hospitalId: hospital, kind, severity, message, ref, notificationId: row.ID });
  if (digest) digest.push(row); else await sendDigest([row]);
  return row;
}

const channel = () => (config.alertNotification.url ? 'alert-notification' : config.smtp.host ? 'smtp' : 'console');

// The events that page someone: new shortfall, temperature excursion, recall, licence expiring, stale feed, low stock, expiry.
const EMAIL_KINDS = new Set(['SHORTFALL', 'EXCURSION', 'RECALL', 'LICENCE_EXPIRY', 'STALE_FEED', 'LOW_STOCK', 'OUT_OF_STOCK', 'EXPIRING', 'EXPIRED']);
let mailer; // nodemailer transport; tests inject a fake with setMailer
function setMailer(t) { mailer = t; }
function transport() {
  if (!mailer) {
    const { host, port, user, pass } = config.smtp;
    mailer = require('nodemailer').createTransport({ host, port, secure: port === 465, auth: user ? { user, pass } : undefined });
  }
  return mailer;
}

/** Who gets a hospital's alerts: its active pharmacists and approvers with an email, else the hospital's admin email, else ALERT_EMAIL_TO. */
async function recipients(hospitalId) {
  if (hospitalId) {
    const users = await SELECT.from('medilink.Users').columns('email').where({ hospital: hospitalId, role: { in: ['pharmacist', 'approver'] }, disabled: false, email: { '!=': null } });
    if (users.length) return [...new Set(users.map(u => u.email))];
    const h = await SELECT.one.from('medilink.Hospitals').columns('adminEmail').where({ ID: hospitalId });
    if (h?.adminEmail) return [h.adminEmail];
  }
  return config.alertEmailTo.split(',').map(s => s.trim()).filter(Boolean);
}

// Outbound messages must describe committed rows only: a rolled-back run sends nothing and alerts again next time.
function afterCommit(fn) {
  const ctx = cds.context;
  if (ctx?.tx && typeof ctx.on === 'function') ctx.on('succeeded', () => setImmediate(fn));
  else setImmediate(fn);
}

/** One outbound message per hospital for these rows (several rows = one digest). */
async function sendDigest(rows) {
  const ch = channel();
  if (ch === 'console') {
    for (const r of rows) LOG.info(`alert ${r.kind} (${r.severity})${r.hospital_ID ? ' for ' + r.hospital_ID : ''}: ${r.message}`);
    return;
  }
  const byHospital = new Map();
  for (const r of rows) if (ch !== 'smtp' || EMAIL_KINDS.has(r.kind)) byHospital.set(r.hospital_ID, [...(byHospital.get(r.hospital_ID) || []), r]);
  for (const list of byHospital.values()) {
    const to = await recipients(list[0].hospital_ID);
    afterCommit(() => (ch === 'smtp' ? sendEmail(list, to) : sendAlertNotification(list, to))
      .catch(e => LOG.warn(`${ch === 'smtp' ? 'Alert email' : 'Alert Notification'} failed:`, e.message)));
  }
}

async function sendEmail(rows, to) {
  if (!config.smtp.from) return LOG.warn('SMTP is set but ALERT_EMAIL_FROM is empty: alert email skipped');
  const h = rows[0].hospital_ID;
  if (!to.length) return LOG.warn(`No recipient for ${h || 'MediLink-wide'} alerts (no user email, hospital admin email or ALERT_EMAIL_TO): alert email skipped`);
  const one = rows.length === 1;
  await transport().sendMail({
    from: config.smtp.from, to: to.join(', '),
    subject: `MediLink: ${one ? t(`email.subject.${rows[0].kind}`) || rows[0].kind : t('email.subject.digest', { n: rows.length })}${h ? ` (${h})` : ''}`,
    text: `${one ? rows[0].message : [t('email.digest', { n: rows.length }), ...rows.map(r => `- ${r.message}`)].join('\n')}\n\n${t('email.open', { url: config.appBaseUrl })}\n\n${t('email.synthetic')}`,
  });
}
/** One email to one address over SMTP (courier links to a partner's dispatch desk). False when SMTP is off. */
async function sendTo(to, subject, text) {
  if (!config.smtp.host || !config.smtp.from || !to) return false;
  await transport().sendMail({ from: config.smtp.from, to, subject, text });
  return true;
}

/** A one-off email (e.g. the connector setup link for a hospital's IT team). Returns false when SMTP is not set up. */
function sendMail(to, subject, text) {
  if (!config.smtp.host || !config.smtp.from) return false;
  afterCommit(() => transport().sendMail({ from: config.smtp.from, to, subject, text }).catch(e => LOG.warn('email failed:', e.message)));
  return true;
}

/** SAP Alert Notification producer API (free tier), Basic auth with the client id/secret of its service key. */
async function sendAlertNotification(rows, to) {
  const { url, clientId, clientSecret } = config.alertNotification;
  if (!clientId || !clientSecret) return LOG.warn('ALERT_NOTIFICATION_URL is set but the client id or secret is empty: alert not sent to SAP Alert Notification');
  const one = rows.length === 1, high = rows.some(r => r.severity === 'HIGH');
  const kind = one ? rows[0].kind : 'DIGEST';
  const auth = 'Basic ' + Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
  const res = await http.request(`${url}/cf/producer/v1/resource-events`, {
    method: 'POST', headers: { Authorization: auth, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      eventType: 'MediLink' + kind, severity: high ? 'ERROR' : 'INFO', category: high ? 'ALERT' : 'NOTIFICATION',
      subject: `MediLink ${kind}`, body: rows.map(r => r.message).join('\n'),
      resource: { resourceName: 'medilink', resourceType: 'app', tags: { hospital: rows[0].hospital_ID || '', ref: one ? rows[0].ref || '' : '', to: to.join(',') } },
    }),
  });
  if (res.status >= 300) throw new Error(`SAP Alert Notification returned ${res.status}`);
}

module.exports = { notify, sendDigest, sendMail, sendTo, recipients, channel, setMailer, EMAIL_KINDS };
