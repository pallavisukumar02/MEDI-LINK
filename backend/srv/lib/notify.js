'use strict';
// Notifications: always a Notification row + WebSocket "alert"; optionally SAP Alert Notification (email).
const cds = require('@sap/cds');
const config = require('./config');
const http = require('./http');
const ws = require('./ws');
const LOG = cds.log('notify');

async function notify({ hospital, kind, severity = 'INFO', message, ref, dueDate }) {
  const row = { ID: cds.utils.uuid(), hospital_ID: hospital || null, kind, severity, message, ref: ref || null, dueDate: dueDate || null, createdAt: new Date().toISOString(), read: false };
  await INSERT.into('medilink.Notifications').entries(row);
  ws.emit('alert', { hospitalId: hospital, kind, severity, message, ref });
  if (config.alertNotificationEnabled) sendAlertNotification(row).catch(e => LOG.warn('Alert Notification failed:', e.message));
  return row;
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

module.exports = { notify, vcap };
