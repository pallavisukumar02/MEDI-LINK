'use strict';
/*
 * Delivery + tracking (FR-21..24) over the seeded in-transit cold-chain shipment H2 -> H3 (trastuzumab, logger LOG-7781):
 * the courier link reaches only its own delivery, a real WebSocket client on /ws/tracking receiving tracking + excursion
 * pushes, quarantine suggestion, and the manual route-closed re-plan (by admin and by the courier's link).
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
let socket, link;
const courier = (path, body) => T.axios.post(path, body, { headers: { Authorization: 'Courier ' + link.token } });

beforeAll(async () => {
  const url = T.axios.defaults.baseURL.replace(/^http/, 'ws') + '/ws/tracking';
  socket = new WebSocket(url, { headers: { Authorization: 'Basic ' + Buffer.from('lata:demo').toString('base64') } });
  socket.on('message', m => { try { msgs.push(JSON.parse(String(m))); } catch { /* ignore */ } });
  await new Promise((res, rej) => { socket.once('open', res); socket.once('error', rej); });
  link = (await get('/admin/courier-links', 'admin')).data.links.find(l => l.transferId === COLD);
});
afterAll(() => socket?.close());

const waitFor = async (pred, ms = 3000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) { const m = msgs.find(pred); if (m) return m; await new Promise(r => setTimeout(r, 50)); }
  return null;
};

test('the seeded delivery has a courier link; delivery operations are admin-only', async () => {
  expect(link).toMatchObject({ status: 'IN_TRANSIT', partnerId: 'P1', url: expect.stringMatching(/\/courier\.html#t=[A-Za-z0-9_-]{43}$/) });
  const all = (await get('/odata/v4/delivery/activeShipments()', 'admin')).data.value;
  expect(all.find(s => s.ID === COLD)).toMatchObject({ storageClass: 'COLD', minC: 2, maxC: 8 });
  for (const u of ['lata', 'sunil']) expect((await get('/odata/v4/delivery/activeShipments()', u)).status).toBe(403);
  expect((await get('/admin/courier-links', 'lata')).status).toBe(403);
  expect((await post('/odata/v4/delivery/telemetry', { transfer: COLD, lat: 'x', long: 77.7, temperatureC: 5 }, 'admin')).status).toBe(400);
  expect((await courier('/courier/location', { lat: 'x', long: 77.7 })).status).toBe(400);
});

test('in-range readings from the link are pushed live to the receiving hospital', async () => {
  const r = await courier('/courier/location', { lat: 12.9601, long: 77.7012, temperatureC: 5.2 });
  expect(r.data).toEqual({ accepted: true, excursion: false });
  const m = await waitFor(x => x.event === 'tracking' && x.data?.transferId === COLD && x.data.position?.lat === 12.9601);
  expect(m).not.toBeNull();
  expect(m.data.temperature).toMatchObject({ current: 5.2, inRange: true });
});

test('excursion alerts both hospitals once, suggests quarantine and pushes an excursion event', async () => {
  const r = await courier('/courier/location', { lat: 12.955, long: 77.69, temperatureC: 9.6 });
  expect(r.data.excursion).toBe(true);
  const m = await waitFor(x => x.event === 'excursion' && x.data?.transferId === COLD);
  expect(m.data).toMatchObject({ quarantineSuggested: true, range: '2-8' });
  await post('/odata/v4/delivery/telemetry', { loggerId: 'LOG-7781', lat: 12.952, long: 77.68, temperatureC: 10.1 }, 'admin'); // logger addressing (ops)
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
  const rc = await courier('/courier/road-closed', { note: 'Tree down on Old Airport Road' });
  expect(rc.status).toBe(200);
  expect(rc.data).toMatchObject({ open: true, message: 'Thanks. We found a new route.' });
  const job = (await T.axios.get('/courier/job', { headers: { Authorization: 'Courier ' + link.token } })).data;
  expect(job.route.points.length).toBeGreaterThan(2); // pickup -> detour point(s) -> drop
  expect(job.route.steps.map(x => x.instruction)).toEqual(expect.arrayContaining([expect.stringMatching(/^Detour around .*Tree down on Old Airport Road/)]));
  await post('/odata/v4/routes/setRouteClosed', { transfer: COLD, closed: false }, 'admin');
});

test('weather check is fail-soft when disabled / offline', async () => {
  const r = await post('/odata/v4/routes/checkWeather', {}, 'admin');
  expect(r.status).toBe(200);
  expect(Array.isArray(r.data.value)).toBe(true);
});
