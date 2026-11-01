'use strict';
/*
 * Delivery + tracking (FR-21..24) over the seeded in-transit cold-chain shipment H2 -> H3 (trastuzumab, logger LOG-7781):
 * partner ownership on telemetry (transfer ID and logger ID), a real WebSocket client on /ws/tracking receiving
 * telemetry + excursion pushes, quarantine suggestion, and the manual route-closed re-plan.
 */
require('./helpers/env')();
const WebSocket = require('ws');
const cds = require('@sap/cds');
const T = cds.test(__dirname + '/..');
T.axios.defaults.validateStatus = () => true;

const as = user => ({ auth: { username: user, password: 'demo' } });
const get = (url, user) => T.axios.get(url, as(user));
const post = (url, body, user) => T.axios.post(url, body, as(user));
const COLD = 'a0000000-0000-4000-8000-000000000001';
const msgs = [];
let socket;

beforeAll(async () => {
  const url = T.axios.defaults.baseURL.replace(/^http/, 'ws') + '/ws/tracking';
  socket = new WebSocket(url, { headers: { Authorization: 'Basic ' + Buffer.from('lata:demo').toString('base64') } });
  socket.on('message', m => { try { msgs.push(JSON.parse(String(m))); } catch { /* ignore */ } });
  await new Promise((res, rej) => { socket.once('open', res); socket.once('error', rej); });
});
afterAll(() => socket?.close());

const waitFor = async (pred, ms = 3000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) { const m = msgs.find(pred); if (m) return m; await new Promise(r => setTimeout(r, 50)); }
  return null;
};

test('a partner only sees and reports on its own shipments', async () => {
  const mine = (await get('/odata/v4/delivery/activeShipments()', 'partner')).data.value;
  expect(mine.map(s => s.ID)).toContain(COLD);
  expect(mine.find(s => s.ID === COLD)).toMatchObject({ storageClass: 'COLD', minC: 2, maxC: 8 });
  expect((await get('/odata/v4/delivery/activeShipments()', 'courier2')).data.value).toHaveLength(0);
  const byId = await post('/odata/v4/delivery/telemetry', { transfer: COLD, lat: 12.95, long: 77.7, temperatureC: 5 }, 'courier2');
  expect(byId.status).toBe(403);
  const byLogger = await post('/odata/v4/delivery/telemetry', { loggerId: 'LOG-7781', lat: 12.95, long: 77.7, temperatureC: 5 }, 'courier2');
  expect(byLogger.status).toBe(403);
  expect((await post('/odata/v4/delivery/telemetry', { transfer: COLD, lat: 'x', long: 77.7, temperatureC: 5 }, 'sim')).status).toBe(400);
});

test('in-range telemetry is pushed live over the WebSocket', async () => {
  const r = await post('/odata/v4/delivery/telemetry', { loggerId: 'LOG-7781', lat: 12.9601, long: 77.7012, temperatureC: 5.2 }, 'sim');
  expect(r.data).toMatchObject({ accepted: true, excursion: false, transferId: COLD });
  const m = await waitFor(x => x.event === 'telemetry' && x.data?.transferId === COLD);
  expect(m).not.toBeNull();
  expect(Number(m.data.temperatureC)).toBe(5.2);
});

test('excursion alerts both hospitals once, suggests quarantine and pushes an excursion event', async () => {
  const r = await post('/odata/v4/delivery/telemetry', { loggerId: 'LOG-7781', lat: 12.955, long: 77.69, temperatureC: 9.6 }, 'sim');
  expect(r.data.excursion).toBe(true);
  const m = await waitFor(x => x.event === 'excursion' && x.data?.transferId === COLD);
  expect(m.data).toMatchObject({ quarantineSuggested: true, range: '2-8' });
  await post('/odata/v4/delivery/telemetry', { loggerId: 'LOG-7781', lat: 12.952, long: 77.68, temperatureC: 10.1 }, 'sim');
  const n = (await get("/odata/v4/admin/Notifications?$filter=kind eq 'EXCURSION'", 'admin')).data.value;
  expect(n.map(x => x.hospital_ID).sort()).toEqual(['H2', 'H3']); // alerted once per hospital, not per reading
  const t = (await get(`/odata/v4/admin/Transfers(${COLD})`, 'admin')).data;
  expect(t).toMatchObject({ excursion: true, quarantineSuggested: true });
});

test('road closed: re-plans around the closure, pushes replan; reopening restores the route', async () => {
  const closed = await post('/odata/v4/routes/setRouteClosed', { transfer: COLD, closed: true, note: 'Silk Board underpass flooded' }, 'admin');
  expect(closed.status).toBe(200);
  expect(closed.data).toMatchObject({ closed: true, open: true });
  expect(closed.data.note).toMatch(/Detour around Silk Board underpass flooded/);
  expect(await waitFor(x => x.event === 'replan' && x.data?.transferId === COLD)).not.toBeNull();
  const reopened = await post('/odata/v4/routes/setRouteClosed', { transfer: COLD, closed: false }, 'admin');
  expect(reopened.data.closed).toBe(false);
  expect(Number(reopened.data.distanceKm)).toBeLessThan(Number(closed.data.distanceKm));
  const done = await post('/odata/v4/routes/setRouteClosed', { transfer: 'b0000000-0000-4000-8000-000000000001', closed: true }, 'admin');
  expect(done.status).toBe(404);
});

test('weather check is fail-soft when disabled / offline', async () => {
  const r = await post('/odata/v4/routes/checkWeather', {}, 'admin');
  expect(r.status).toBe(200);
  expect(Array.isArray(r.data.value)).toBe(true);
});
