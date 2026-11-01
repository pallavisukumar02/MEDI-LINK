'use strict';
/*
 * Notifications: always a Notification row + WebSocket "alert" (the in-app alerts on /me/home), plus one outbound
 * channel, chosen here and nowhere else:
 *   - "alert-notification": SAP Alert Notification (BTP profiles, ALERT_NOTIFICATION_ENABLED=true), every alert
 *   - "smtp":               email through any SMTP server (SMTP_HOST set; the standalone replacement), for EMAIL_KINDS
 *   - "console":            no email; the alert is logged
 */
const cds = require('@sap/cds');
const config = require('./config');
const http = require('./http');
const ws = require('./ws');
const LOG = cds.log('notify');

async function notify({ hospital, kind, severity = 'INFO', message, ref, dueDate }) {
  const row = { ID: cds.utils.uuid(), hospital_ID: hospital || null, kind, severity, message, ref: ref || null, dueDate: dueDate || null, createdAt: new Date().toISOString(), read: false };
  await INSERT.into('medilink.Notifications').entries(row);
  ws.emit('alert', { hospitalId: hospital, kind, severity, message, ref });
  const ch = channel();
  if (ch === 'alert-notification') sendAlertNotification(row).catch(e => LOG.warn('Alert Notification failed:', e.message));
  else if (ch === 'smtp') { if (EMAIL_KINDS.has(kind)) sendEmail(row).catch(e => LOG.warn('Alert email failed:', e.message)); }
  else LOG.info(`alert ${kind} (${severity})${hospital ? ' for ' + hospital : ''}: ${message}`);
  return row;
}

const channel = () => (!config.standalone && config.alertNotificationEnabled ? 'alert-notification' : config.smtp.host ? 'smtp' : 'console');

// The events that page someone: new shortfall, temperature excursion, recall, licence expiring, stale feed.
const EMAIL_KINDS = new Set(['SHORTFALL', 'EXCURSION', 'RECALL', 'LICENCE_EXPIRY', 'STALE_FEED']);
const SUBJECTS = { SHORTFALL: 'Medicine shortfall', EXCURSION: 'Temperature out of range', RECALL: 'Batch recall', LICENCE_EXPIRY: 'Licence expiring', STALE_FEED: 'Stock feed not updating' };
let mailer; // nodemailer transport; tests inject a fake with setMailer
function setMailer(t) { mailer = t; }
function transport() {
  if (!mailer) {
    const { host, port, user, pass } = config.smtp;
    mailer = require('nodemailer').createTransport({ host, port, secure: port === 465, auth: user ? { user, pass } : undefined });
  }
  return mailer;
}
async function sendEmail(row) {
  const to = config.alertEmailTo;
  if (!to || !config.smtp.from) return LOG.warn('SMTP is set but ALERT_EMAIL_TO or ALERT_EMAIL_FROM is empty: alert email skipped');
  await transport().sendMail({
    from: config.smtp.from, to, subject: `MediLink: ${SUBJECTS[row.kind] || row.kind}${row.hospital_ID ? ` (${row.hospital_ID})` : ''}`,
    text: `${row.message}\n\nOpen MediLink to act on it: ${config.appBaseUrl}\n\n(MediLink prototype - synthetic data.)`,
  });
}

/** SAP Alert Notification service producer API (free tier). Credentials come from the service binding only. */
async function sendAlertNotification(row) {
  const svc = cds.env.requires['alert-notification']?.credentials || vcap('alert-notification');
  if (!svc) return;
  const auth = 'Basic ' + Buffer.from(`${svc.client_id}:${svc.client_secret}`).toString('base64');
  await http.request(`${svc.url}/cf/producer/v1/resource-events`, {
    method: 'POST', headers: { Authorization: auth, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      eventType: 'MediLink' + row.kind, severity: row.severity === 'HIGH' ? 'ERROR' : 'INFO', category: row.severity === 'HIGH' ? 'ALERT' : 'NOTIFICATION',
      subject: `MediLink ${row.kind}`, body: row.message,
      resource: { resourceName: 'medilink', resourceType: 'app', tags: { hospital: row.hospital_ID || '', ref: row.ref || '', to: config.alertEmailTo } },
    }),
  });
}

function vcap(label) {
  try { return JSON.parse(process.env.VCAP_SERVICES || '{}')[label]?.[0]?.credentials; } catch { return undefined; }
}

module.exports = { notify, vcap, channel, setMailer, EMAIL_KINDS };
