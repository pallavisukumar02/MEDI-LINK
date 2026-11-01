'use strict';
// Live updates are filtered per user (PRD item 8.3): only the supplier, receiver and partner of a transfer (and
// admins) get its events, a client cannot join another hospital's context, and journey.updated carries the same
// journey shape as GET /me/home, built for the receiving socket's point of view.
require('./helpers/env')();
const cds = require('@sap/cds');
const WebSocket = require('ws');
const T = cds.test(__dirname + '/..');
T.axios.defaults.validateStatus = () => true;
const { contextsFor, audience } = require('../srv/lib/ws');

const COLD = 'a0000000-0000-4000-8000-000000000001'; // seeded in-transit shipment H2 -> H3, partner P1
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
  for (const u of ['lata', 'sunil', 'asha', 'partner', 'admin']) sockets[u] = await connect(u);
  // asha tries to listen in on Lakeside's events; the server resets her to her own contexts
  sockets.asha.send(JSON.stringify({ event: 'wsContext', data: { context: 'hospital:H3' } }));
  await wait(300);
});
afterAll(() => { for (const s of Object.values(sockets)) s.close(); cds.ws?.close?.(); });

test('contexts follow the user: hospital + role, partner, admin', () => {
  const user = (attr, roles) => ({ attr, is: r => roles.includes(r) });
  expect(contextsFor(user({ hospital: 'H5' }, ['pharmacist']))).toEqual(['hospital:H5', 'hospital:H5:pharmacist']);
  expect(contextsFor(user({ hospital: ['H5'] }, ['approver']))).toEqual(['hospital:H5', 'hospital:H5:approver']);
  expect(contextsFor(user({ partner: 'P1' }, ['partner']))).toEqual(['partner:P1']);
  expect(contextsFor(user({}, ['admin']))).toEqual(['admin']);
  expect(audience('status', {}, { supplier_ID: 'H2', receiver_ID: 'H3', partner_ID: 'P1' }).sort()).toEqual(['admin', 'hospital:H2', 'hospital:H3', 'partner:P1']);
  expect(audience('alert', { hospitalId: 'H4' }, null).sort()).toEqual(['admin', 'hospital:H4']);
});

test('a temperature reading reaches the two hospitals, the courier and admin only, plus journey.updated', async () => {
  const r = await T.axios.post('/odata/v4/delivery/telemetry', { loggerId: 'LOG-7781', lat: 12.95, long: 77.69, temperatureC: 11.4 }, { auth: { username: 'sim', password: 'demo' } });
  expect(r.data.excursion).toBe(true);
  const got = (u, ev) => inbox[u].some(m => m.event === ev);
  expect(await until(() => ['lata', 'sunil', 'partner', 'admin'].every(u => got(u, 'excursion') && got(u, 'journey.updated')))).toBe(true);
  await wait(500);
  expect(inbox.asha.filter(m => ['telemetry', 'excursion', 'journey.updated'].includes(m.event))).toEqual([]);

  const lj = inbox.lata.filter(m => m.event === 'journey.updated').at(-1).data;
  expect(lj).toMatchObject({ perspective: 'receiver', journeyId: 'b0000000-0000-4000-8000-000000000001' });
  expect(lj.journey).toMatchObject({ key: 'excursion', colour: 'red', headline: "Temperature went out of range. Don't use until checked", transferId: COLD });
  const sj = inbox.sunil.filter(m => m.event === 'journey.updated').at(-1).data;
  expect(sj.journey).toMatchObject({ perspective: 'supplier', headline: 'Temperature went out of range on the way' });
  const pj = inbox.partner.filter(m => m.event === 'journey.updated').at(-1).data;
  expect(pj.journey.perspective).toBe('partner');
  // same shape as the home screen card
  const home = (await T.axios.get('/me/home', { auth: { username: 'lata', password: 'demo' } })).data;
  const card = home.journeys.find(j => j.id === lj.journeyId);
  expect(Object.keys(lj.journey).sort()).toEqual(Object.keys(card).sort());
});
