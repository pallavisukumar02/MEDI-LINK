'use strict';
// Live updates are filtered per user (PRD item 8.3): only the supplier and receiver of a transfer (and admins) get its
// events, live "tracking" (position, temperature, ETA) only the receiver and admins (the supplier a status-only copy),
// a client cannot join another hospital's context, and journey.updated carries the same journey shape as GET /me/home,
// built for the receiving socket's point of view.
require('./helpers/env')();
const cds = require('@sap/cds');
const WebSocket = require('ws');
const T = cds.test(__dirname + '/..');
T.axios.defaults.validateStatus = () => true;
const { contextsFor, audience } = require('../srv/lib/ws');

const COLD = 'a0000000-0000-4000-8000-000000000001'; // seeded in-transit shipment H2 -> H3, partner P1
const admin = { auth: { username: 'admin', password: 'demo' } };
let token; // the seeded shipment's courier link
const sockets = {};
const inbox = {};

function connect(user) {
  return new Promise((resolve, reject) => {
    const port = cds.app.server.address().port;
    const ws = new WebSocket(`ws://localhost:${port}/ws/tracking`, { headers: { authorization: 'Basic ' + Buffer.from(`${user}:demo`).toString('base64') } });
    inbox[user] = [];
    ws.on('message', m => { try { inbox[user].push(JSON.parse(String(m))); } catch { /* ignore */ } });
    ws.on('open', () => setTimeout(() => resolve(ws), 300)); // let wsConnect enter the contexts
    ws.on('error', reject);
  });
}
const wait = ms => new Promise(r => setTimeout(r, ms));
async function until(fn, ms = 4000) { const end = Date.now() + ms; while (Date.now() < end) { if (fn()) return true; await wait(100); } return false; }

beforeAll(async () => {
  for (const u of ['lata', 'sunil', 'asha', 'admin']) sockets[u] = await connect(u);
  token = (await T.axios.get('/admin/courier-links', admin)).data.links.find(l => l.transferId === COLD).token;
  // asha tries to listen in on Lakeside's events; the server resets her to her own contexts
  sockets.asha.send(JSON.stringify({ event: 'wsContext', data: { context: 'hospital:H3' } }));
  await wait(300);
});
afterAll(() => { for (const s of Object.values(sockets)) s.close(); cds.ws?.close?.(); });

test('contexts follow the user: hospital + role, admin; tracking goes to the receiver only', () => {
  const user = (attr, roles) => ({ attr, is: r => roles.includes(r) });
  expect(contextsFor(user({ hospital: 'H5' }, ['pharmacist']))).toEqual(['hospital:H5', 'hospital:H5:pharmacist']);
  expect(contextsFor(user({ hospital: ['H5'] }, ['approver']))).toEqual(['hospital:H5', 'hospital:H5:approver']);
  expect(contextsFor(user({ partner: 'P1' }, ['partner']))).toEqual([]); // couriers have no account and no socket
  expect(contextsFor(user({}, ['admin']))).toEqual(['admin']);
  expect(audience('status', {}, { supplier_ID: 'H2', receiver_ID: 'H3' }).sort()).toEqual(['admin', 'hospital:H2', 'hospital:H3']);
  expect(audience('tracking', {}, { supplier_ID: 'H2', receiver_ID: 'H3' }).sort()).toEqual(['admin', 'hospital:H3']);
  expect(audience('alert', { hospitalId: 'H4' }, null).sort()).toEqual(['admin', 'hospital:H4']);
});

test('a GPS fix: full tracking to the receiver and admin, status only to the supplier, nothing to others', async () => {
  const r = await T.axios.post('/courier/location', { lat: 12.96, long: 77.70, accuracyM: 15 }, { headers: { Authorization: 'Courier ' + token } });
  expect(r.data).toEqual({ accepted: true, excursion: false });
  const tracking = u => inbox[u].filter(m => m.event === 'tracking').at(-1)?.data;
  expect(await until(() => ['lata', 'sunil', 'admin'].every(tracking))).toBe(true);
  expect(tracking('lata')).toMatchObject({ transferId: COLD, requestId: 'b0000000-0000-4000-8000-000000000001', status: 'IN_TRANSIT', position: { lat: 12.96, long: 77.7, accuracyM: 15 }, temperature: { range: { minC: 2, maxC: 8 } }, etaText: expect.stringMatching(/^~\d+ min · \d{1,2}:\d{2} (am|pm)$|^Arriving now$/) });
  expect(Number(tracking('lata').remainingKm)).toBeGreaterThan(0);
  expect(tracking('admin').position).toBeDefined();
  expect(tracking('sunil')).toEqual({ transferId: COLD, requestId: 'b0000000-0000-4000-8000-000000000001', status: 'IN_TRANSIT' }); // supplier: summary
  await wait(300);
  expect(inbox.asha.filter(m => m.event === 'tracking')).toEqual([]);
});

test('a temperature reading reaches the two hospitals and admin only, plus journey.updated', async () => {
  const r = await T.axios.post('/courier/location', { lat: 12.95, long: 77.69, temperatureC: 11.4 }, { headers: { Authorization: 'Courier ' + token } });
  expect(r.data.excursion).toBe(true);
  const got = (u, ev) => inbox[u].some(m => m.event === ev);
  expect(await until(() => ['lata', 'sunil', 'admin'].every(u => got(u, 'excursion') && got(u, 'journey.updated')))).toBe(true);
  await wait(500);
  expect(inbox.asha.filter(m => ['tracking', 'excursion', 'journey.updated'].includes(m.event))).toEqual([]);

  const lj = inbox.lata.filter(m => m.event === 'journey.updated').at(-1).data;
  expect(lj).toMatchObject({ perspective: 'receiver', journeyId: 'b0000000-0000-4000-8000-000000000001' });
  expect(lj.journey).toMatchObject({ key: 'excursion', colour: 'red', headline: "Temperature went out of range. Don't use until checked", transferId: COLD });
  const sj = inbox.sunil.filter(m => m.event === 'journey.updated').at(-1).data;
  expect(sj.journey).toMatchObject({ perspective: 'supplier', headline: 'Temperature went out of range on the way' });
  // same shape as the home screen card
  const home = (await T.axios.get('/me/home', { auth: { username: 'lata', password: 'demo' } })).data;
  const card = home.journeys.find(j => j.id === lj.journeyId);
  expect(Object.keys(lj.journey).sort()).toEqual(Object.keys(card).sort());
});

test('journey.updated follows tracking steps: none for an ordinary fix, one when the courier gets near', async () => {
  const h3 = (await T.axios.get("/odata/v4/admin/Hospitals('H3')", admin)).data;
  const fix = body => T.axios.post('/courier/location', body, { headers: { Authorization: 'Courier ' + token } });
  const updates = () => inbox.lata.filter(m => m.event === 'journey.updated').length;
  await wait(500);
  const n0 = updates();
  expect((await fix({ lat: 12.955, long: 77.69 })).data.accepted).toBe(true); // still far away: position only
  expect(await until(() => inbox.lata.filter(m => m.event === 'tracking' && m.data.position?.lat === 12.955).length > 0)).toBe(true);
  await wait(400);
  expect(updates()).toBe(n0);
  await fix({ lat: Number(h3.lat) + 0.007, long: Number(h3.long) }); // ~0.8 km: the "nearby" step
  expect(await until(() => updates() > n0)).toBe(true);
});
