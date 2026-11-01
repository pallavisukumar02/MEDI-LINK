'use strict';
/*
 * Couriers have no account; the receiving hospital tracks the delivery live (Swiggy / Zomato style).
 * Courier link lifecycle: minted on assign, only a hash + ciphertext stored, one transfer only, the same generic 401 for
 * bad / expired / revoked links, reissue revokes the old one, revoked on cancel, read-only for 2 h after the hand-over,
 * rate limits. Pickup through the link (strict input, batch mismatch), GPS-only fixes, device-time clamp (audit F16).
 * GET /me/journeys/{id}/tracking: receiver full, supplier summary, other hospitals 404 (audit F11), admin; ETA recompute
 * from the latest fix (throttled) and the nearby / arrived steps. Ranking uses the built-in fallback (no Python).
 */
require('./helpers/env')({ MATCHER_URL: 'http://localhost:1', MATCHER_FALLBACK_ENABLED: 'true' });
const crypto = require('crypto');
const cds = require('@sap/cds');
const T = cds.test(__dirname + '/..');
T.axios.defaults.validateStatus = () => true;
const ingestH1 = require('./helpers/h1');
const courier = require('../srv/lib/courier');
const tracking = require('../srv/lib/tracking');
const config = require('../srv/lib/config');
const messages = require('../srv/lib/messages');
const { haversineKm } = require('../srv/lib/routing');

const as = (user, headers = {}) => ({ auth: { username: user, password: 'demo' }, headers });
const home = async user => (await T.axios.get('/me/home', as(user))).data;
const act = (user, a, values = {}, key) => T.axios.post(a.path || `/me/actions/${a}`, { ...(a.body || {}), ...values }, as(user, key ? { 'Idempotency-Key': key } : {}));
const task = (h, kind) => h.tasks.find(x => x.kind === kind);
const jOf = (h, id) => h.journeys.find(j => j.id === id);
const byLink = token => ({ headers: { Authorization: 'Courier ' + token } });
const job = token => T.axios.get('/courier/job', byLink(token));
const cpost = (path, body, token) => T.axios.post(path, body, byLink(token));
const tokenOf = url => new URL(url).hash.replace(/^#t=/, '');
const sha = v => crypto.createHash('sha256').update(v).digest('hex');
const db = fn => cds.tx({ user: cds.User.privileged }, fn);
const links = async () => (await T.axios.get('/admin/courier-links', as('admin'))).data.links;
const audit = async action => db(() => SELECT.from('medilink.AuditLog').where({ action }));
const COLD = 'a0000000-0000-4000-8000-000000000001'; // seeded in-transit H2 -> H3
const H1 = { lat: 12.9299, long: 77.5826 }, H5 = { lat: 12.9255, long: 77.5468 };
const at = f => ({ lat: Math.round((H5.lat + (H1.lat - H5.lat) * f) * 1e6) / 1e6, long: Math.round((H5.long + (H1.long - H5.long) * f) * 1e6) / 1e6 });
const s = {};

beforeAll(async () => { await ingestH1(); });

/** asha asks for carboplatin, ravi (H5) gives it, two approvers sign: a courier is assigned. */
async function toAssigned() {
  const r = await act('asha', task(await home('asha'), 'send_request').primaryAction, { allowBrandSwitch: false });
  const id = r.data.journey.id;
  await act('asha', r.data.journey.actions.find(a => a.id === 'choose-plan'));
  await act('ravi', task(await home('ravi'), 'accept_request').primaryAction, { repaymentMode: 'IN_KIND' });
  await act('meera', task(await home('meera'), 'approve').primaryAction);
  await act('kiran', task(await home('kiran'), 'approve').primaryAction);
  const j = jOf(await home('asha'), id);
  expect(j.key).toBe('waiting_pickup');
  return { request: id, transfer: j.transferId, url: `/me/journeys/${id}/tracking` };
}

describe('courier link lifecycle', () => {
  test('minted when the courier is assigned; only a hash and a ciphertext are stored; the supplier shares it', async () => {
    Object.assign(s, await toAssigned());
    const rows = await db(() => SELECT.from('medilink.CourierLinks').where({ transfer_ID: s.transfer }));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ partner_ID: 'P1', tokenHash: expect.stringMatching(/^[0-9a-f]{64}$/), revokedAt: null });
    expect((new Date(rows[0].expiresAt) - new Date(rows[0].createdAt)) / 3600000).toBeCloseTo(24, 3); // COURIER_LINK_TTL_HOURS

    const share = jOf(await home('ravi'), s.request).actions.find(a => a.id === 'courier-link');
    const r = await act('ravi', share, {}, 'share-key');
    expect(r.status).toBe(200);
    expect(r.headers['cache-control']).toBe('no-store');
    s.token = tokenOf(r.data.result.url);
    expect(r.data.result).toEqual({ url: `${config.appBaseUrl}/courier.html#t=${s.token}`, expiresAt: rows[0].expiresAt });
    expect(s.token).toMatch(/^[A-Za-z0-9_-]{43}$/); // 256 bits, base64url
    expect(sha(s.token)).toBe(rows[0].tokenHash);
    expect(JSON.stringify(rows)).not.toContain(s.token);
    // never kept in clear anywhere else: no idempotent replay of the response, nothing in the audit log
    expect(await db(() => SELECT.from('medilink.IdempotencyKeys').where({ actionId: 'courier-link' }))).toEqual([]);
    expect((await audit('COURIER_LINK_ISSUED')).some(e => e.payload.includes(s.transfer))).toBe(true);
    expect(JSON.stringify(await db(() => SELECT.from('medilink.AuditLog')))).not.toContain(s.token);

    expect(tokenOf((await act('meera', 'courier-link', { transferId: s.transfer })).data.result.url)).toBe(s.token); // supplier's approver
    expect((await act('admin', 'courier-link', { transferId: s.transfer })).status).toBe(200);
    const receiver = await act('asha', 'courier-link', { transferId: s.transfer });
    expect([receiver.status, receiver.data.code]).toEqual([403, 'COURIER_LINK_NOT_YOURS']);
    expect((await act('sunil', 'reissue-courier-link', { transferId: s.transfer })).status).toBe(403);
    expect(JSON.stringify(await home('asha'))).not.toContain(s.token);
  });

  test('GET /courier/job: this one delivery, no batch numbers, no patient data, not cached', async () => {
    const r = await job(s.token);
    expect(r.status).toBe(200);
    expect(r.headers).toMatchObject({ 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' });
    expect(r.data).toMatchObject({
      status: 'ASSIGNED', readOnly: false, next: 'pickup', qty: 16, drug: { name: 'Carboplatin', strength: '450 mg/45 mL', form: 'Injection' },
      storageClass: 'AMBIENT', temperatureRange: { minC: 2, maxC: 30 }, partner: { name: 'CoolRoute Logistics (synthetic)' },
      pickup: { name: expect.stringMatching(/^Banashankari Care Hospital/), address: expect.any(String), ...H5 }, drop: { name: expect.stringMatching(/^City Cancer Hospital/), ...H1 },
    });
    expect(r.data.route.points).toEqual([[H5.lat, H5.long], [H1.lat, H1.long]]);
    expect(r.data.route.steps.map(x => x.instruction)).toEqual([expect.stringMatching(/^Collect the medicine at Banashankari/), expect.stringMatching(/^Deliver to the pharmacy at City Cancer Hospital/)]);
    expect(r.data.handlingNote).toMatch(/16 vials \(batch •••• x \d+/);
    expect(JSON.stringify(r.data)).not.toMatch(/SOL24B077|SOL25A015|patient|"H[1-5]"/i);
  });

  test('bad, expired and revoked links all get the same generic 401; reissue revokes the old link and emails the new one', async () => {
    const sent = [];
    const notify = require('../srv/lib/notify');
    notify.setMailer({ sendMail: async m => { sent.push(m); return {}; } });
    Object.assign(process.env, { SMTP_HOST: 'smtp.test', ALERT_EMAIL_FROM: 'medilink@test.example' }); config.reload();
    let r;
    try {
      const re = jOf(await home('ravi'), s.request).actions.find(a => a.id === 'reissue-courier-link');
      expect(re.confirm).toBe('Make a new courier link? The old link stops working at once.');
      r = await act('ravi', re);
      await new Promise(res => setTimeout(res, 200)); // the email goes out after the commit
    } finally { Object.assign(process.env, { SMTP_HOST: '', ALERT_EMAIL_FROM: '' }); config.reload(); notify.setMailer(undefined); }
    expect(r.data.message).toBe('New courier link ready. The old link no longer works.');
    const revoked = s.token;
    s.token = tokenOf(r.data.result.url);
    expect(s.token).not.toBe(revoked);
    expect((await job(s.token)).status).toBe(200);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ to: 'dispatch@coolroute.example', subject: expect.stringMatching(/^MediLink delivery: 16 x Carboplatin/) });
    expect(sent[0].text).toContain(r.data.result.url);
    expect(sent[0].text).toMatch(/^Hello CoolRoute Logistics \(synthetic\),\n\n/);

    const cold = (await links()).find(l => l.transferId === COLD).token; // the seeded delivery's link, now past its expiry
    await db(() => UPDATE('medilink.CourierLinks').set({ expiresAt: new Date(Date.now() - 1000).toISOString() }).where({ tokenHash: sha(cold) }));
    const generic = messages.error('COURIER_LINK_INVALID');
    expect(generic.title).toBe('This link does not work');
    for (const h of [undefined, 'Bearer x', 'Courier short', `Courier ${'A'.repeat(43)}`, `Courier ${revoked}`, `Courier ${cold}`]) {
      const x = await T.axios.get('/courier/job', h ? { headers: { Authorization: h } } : {});
      expect([x.status, x.data]).toEqual([401, generic]);
    }
    expect((await cpost('/courier/location', { lat: 12.95, long: 77.69, temperatureC: 5 }, cold)).status).toBe(401);
    const mine = action => audit(action).then(es => es.filter(e => e.payload.includes(s.transfer)));
    expect(await mine('COURIER_LINK_REISSUED')).toHaveLength(1);
    expect((await mine('COURIER_LINK_REVOKED'))[0].payload).toMatch(/REISSUED/);
    expect((await links()).map(l => l.transferId)).toEqual([s.transfer]); // admin list: working links only
  });

  test('cancelling the request revokes the link', async () => {
    expect((await act('asha', 'cancel-request', { requestId: s.request })).status).toBe(200);
    expect((await job(s.token)).status).toBe(401);
    expect((await db(() => SELECT.from('medilink.CourierLinks').where({ transfer_ID: s.transfer }))).every(l => l.revokedAt)).toBe(true);
    expect((await audit('COURIER_LINK_REVOKED')).some(e => e.payload.includes(s.transfer) && /CANCELLED/.test(e.payload))).toBe(true);
  });
});

describe('the courier on the road', () => {
  test('pickup through the link: strict input, batch mismatch, then custody with the rider details', async () => {
    Object.assign(s, await toAssigned());
    const link = (await links()).find(l => l.transferId === s.transfer);
    s.token = link.token;
    s.batches = link.batches.join(', ');
    const early = await cpost('/courier/location', { lat: 12.93, long: 77.55 }, s.token);
    expect([early.status, early.data.code]).toEqual([409, 'INVALID_STATUS']); // no fixes before pickup
    const scan = { batchNo: s.batches, sealId: 'SEAL-2', loggerId: 'LOG-2' };
    for (const b of [{ ...scan, extra: 1 }, { ...scan, riderPhone: 'call me' }, { sealId: 'SEAL-2', loggerId: 'LOG-2' }, { ...scan, sealId: 7 }, 'x'.repeat(3000)]) {
      expect((await cpost('/courier/pickup', b, s.token)).data.code).toBe('INVALID_INPUT');
    }
    const bad = await cpost('/courier/pickup', { ...scan, batchNo: 'WRONG1' }, s.token);
    expect([bad.status, bad.data.code, bad.data.title]).toEqual([409, 'BATCH_MISMATCH', 'Wrong batch']);
    const ok = await cpost('/courier/pickup', { ...scan, riderName: 'Asif (synthetic)', riderPhone: '+91 90000 00002' }, s.token);
    expect(ok.status).toBe(200);
    expect(ok.data).toMatchObject({ message: 'Pickup recorded. Tracking is live.', job: { status: 'IN_TRANSIT', next: 'deliver', rider: { name: 'Asif (synthetic)', phone: '+91 90000 00002' } } });
    expect((await cpost('/courier/pickup', scan, s.token)).status).toBe(409); // already picked up
    expect(await db(() => SELECT.one.from('medilink.Transfers').columns('status', 'sealId', 'loggerId').where({ ID: s.transfer }))).toEqual({ status: 'IN_TRANSIT', sealId: 'SEAL-2', loggerId: 'LOG-2' });
    expect((await audit('PICKUP')).find(e => e.payload.includes(s.transfer)).actor).toMatch(/^courier:P1:[0-9a-f]{8}$/);
  });

  test('GPS-only fixes from the phone, readings from the logger; old device times clamped to pickup; bad values refused', async () => {
    expect((await cpost('/courier/location', { ...at(0.2), accuracyM: 8 }, s.token)).data).toEqual({ accepted: true, excursion: false });
    expect((await cpost('/courier/location', { ...at(0.25), temperatureC: 24.1, ts: '2020-01-01T00:00:00Z' }, s.token)).status).toBe(200);
    const logs = await db(() => SELECT.from('medilink.ConditionLogs').where({ transfer_ID: s.transfer }));
    const { pickedUpAt } = await db(() => SELECT.one.from('medilink.Transfers').columns('pickedUpAt').where({ ID: s.transfer }));
    expect(logs).toHaveLength(2);
    expect(logs.find(l => l.temperatureC === null)).toMatchObject({ excursion: false });
    expect(Number(logs.find(l => l.temperatureC === null).accuracyM)).toBe(8);
    expect(new Date(logs.find(l => l.temperatureC !== null).loggedAt).getTime()).toBe(new Date(pickedUpAt).getTime()); // F16: no backfill
    for (const b of [{ lat: 200, long: 77.5 }, { lat: 12.9, long: 77.5, temperatureC: 'x' }, { lat: 12.9, long: 77.5, temperatureC: 400 }, { lat: 12.9, long: 77.5, sealStatus: 'OPEN' },
      { lat: 12.9, long: 77.5, ts: 'yesterday' }, { lat: 12.9 }, { lat: '12.9', long: 77.5 }, [1, 2]]) {
      expect((await cpost('/courier/location', b, s.token)).status).toBe(400);
    }
    // proof of condition counts temperature readings only
    const { proofOfCondition } = require('../srv/lib/receipt');
    const fix = (m, c = null) => ({ loggedAt: `2026-01-01T10:${String(m).padStart(2, '0')}:00Z`, temperatureC: c, sealStatus: 'INTACT' });
    const base = { transfer: { pickedUpAt: '2026-01-01T10:00:00Z', sealId: 'S' }, lots: [{ batchNo: 'B1' }], batchNo: 'B1', sealIntact: true, arrivedAt: new Date('2026-01-01T10:40:00Z') };
    const gps = [5, 10, 15, 20, 25, 30, 35].map(m => fix(m));
    expect(proofOfCondition({ ...base, logs: gps }).checks.traceComplete).toBe(false);
    expect(proofOfCondition({ ...base, logs: [...gps, fix(10, 5), fix(20, 5.5), fix(30, 6)] })).toMatchObject({ pass: true, readings: 3, minC: 5, maxC: 6 });
  });

  test('tracking: the receiver sees everything, the supplier a summary, admin everything, anyone else 404', async () => {
    const r = await T.axios.get(s.url, as('asha'));
    expect(r.status).toBe(200);
    expect(r.data).toMatchObject({ journeyId: s.request, requestId: s.request, perspective: 'receiver' });
    expect(r.data.legs).toHaveLength(1);
    const leg = r.data.legs[0];
    expect(leg).toMatchObject({
      transferId: s.transfer, status: 'IN_TRANSIT', qty: 16, drug: { name: 'Carboplatin 450 mg' }, partner: { name: 'CoolRoute Logistics (synthetic)' },
      riderName: 'Asif (synthetic)', riderPhone: '+91 90000 00002', origin: { name: expect.stringMatching(/^Banashankari/), ...H5 }, destination: { name: expect.stringMatching(/^City Cancer/), ...H1 },
      position: { ...at(0.2), accuracyM: 8 }, excursion: false, delayed: false, routeNote: null,
      temperature: { current: 24.1, min: 24.1, max: 24.1, range: { minC: 2, maxC: 30 }, inRange: true, readings: [{ c: 24.1, at: expect.any(String) }] },
    });
    expect(leg.steps.map(x => [x.key, x.label, x.done])).toEqual([['confirmed', 'Courier assigned', true], ['picked_up', 'Picked up', true], ['on_the_way', 'On the way', true], ['nearby', 'Nearby', false], ['arrived', 'Arrived', false], ['delivered', 'Delivered', false]]);
    for (const x of leg.steps) expect(x.at === null ? !x.done : !isNaN(Date.parse(x.at))).toBe(true);
    expect(leg.route).toEqual([[H5.lat, H5.long], [H1.lat, H1.long]]);
    expect(leg.trail).toHaveLength(2);
    expect(leg.remainingKm).toBeGreaterThan(0);
    expect(leg.etaText).toMatch(/^~\d+ min · \d{1,2}:\d{2} (am|pm)$/);

    const sup = (await T.axios.get(s.url, as('ravi'))).data;
    expect(sup.perspective).toBe('supplier');
    expect(sup.legs[0]).toMatchObject({ riderName: 'Asif (synthetic)', riderPhone: null, position: null, trail: [], route: [], temperature: { current: 24.1, inRange: true, readings: [] } });
    expect(sup.legs[0].steps).toEqual(leg.steps);
    expect((await T.axios.get(s.url, as('meera'))).data.perspective).toBe('supplier');
    expect((await T.axios.get(s.url, as('admin'))).data.legs[0]).toMatchObject({ riderPhone: '+91 90000 00002', position: { accuracyM: 8 } });
    expect((await T.axios.get(`/me/journeys/${s.transfer}/tracking`, as('asha'))).data.legs[0].transferId).toBe(s.transfer); // a transfer ID works too

    for (const u of ['sunil', 'lata', 'anil', 'bpa']) {
      for (const id of [s.request, s.transfer]) expect([(await T.axios.get(`/me/journeys/${id}/tracking`, as(u))).status, u]).toEqual([404, u]);
      expect((await T.axios.get(`/me/journeys/${s.request}`, as(u))).status).toBe(404); // audit F11
    }
    expect((await T.axios.get('/me/journeys/00000000-0000-4000-8000-000000000000/tracking', as('asha'))).data).toMatchObject({ code: 'NOT_FOUND' });
    expect((await T.axios.get(s.url)).status).toBe(401);
    // the receiving pharmacist reports a closed road: the map shows the detour, the message and the card show the same time
    const rc = await act('asha', jOf(await home('asha'), s.request).actions.find(a => a.id === 'report-road-closed'), { note: 'Silk Board junction' });
    const clock = /about (\d{1,2}:\d{2} (am|pm))\.$/.exec(rc.data.message)?.[1];
    expect(clock).toBeDefined();
    expect(jOf(await home('asha'), s.request).headline).toBe(`Re-routed around Silk Board junction, new ETA ${clock}`);
    const detour = (await T.axios.get(s.url, as('asha'))).data.legs[0];
    expect(detour.route.length).toBeGreaterThan(2); // pickup -> point around the closure -> drop
    expect(detour.routeNote).toMatch(/^Detour around Silk Board junction/);
    expect((await T.axios.post('/odata/v4/routes/setRouteClosed', { transfer: s.transfer, closed: false }, as('admin'))).status).toBe(200);
  });

  test('ETA follows the latest fix at most once a minute; nearby within 1 km, arrived within 500 m', async () => {
    const etaOf = async () => (await db(() => SELECT.one.from('medilink.Transfers').columns('eta').where({ ID: s.transfer }))).eta;
    const until = async (fn, ms = 3000) => { for (const end = Date.now() + ms; Date.now() < end; await new Promise(r => setTimeout(r, 50))) if (await fn()) return true; return false; };
    const before = await etaOf();
    tracking._etaAt.clear(); // a minute has passed
    await cpost('/courier/location', { ...at(0.5), temperatureC: 24.4 }, s.token);
    expect(await until(async () => (await etaOf()) !== before)).toBe(true); // refreshed right after the commit
    const e1 = await etaOf();
    const driveMs = haversineKm(at(0.5), H1) * config.roadFactor / config.citySpeedKmh * 3600000;
    expect(Math.abs(new Date(e1).getTime() - (Date.now() + driveMs))).toBeLessThan(90000);
    await cpost('/courier/location', { ...at(0.6), temperatureC: 24.4 }, s.token);
    await new Promise(r => setTimeout(r, 300));
    expect(await etaOf()).toBe(e1); // throttled
    const steps = async () => Object.fromEntries((await T.axios.get(s.url, as('asha'))).data.legs[0].steps.map(x => [x.key, x.done]));

    await cpost('/courier/location', { ...at(0.8), temperatureC: 24.5 }, s.token); // ~0.8 km before the pharmacy
    expect(await steps()).toMatchObject({ nearby: true, arrived: false });
    expect(jOf(await home('asha'), s.request)).toMatchObject({ stage: 5, key: 'on_the_way' });
    await cpost('/courier/location', { ...at(0.9), temperatureC: 24.5 }, s.token); // ~0.4 km
    expect(await steps()).toMatchObject({ nearby: true, arrived: true, delivered: false });
    expect(jOf(await home('asha'), s.request)).toMatchObject({ stage: 6, key: 'arrived' });

    const ahead = await cpost('/courier/location', { ...at(0.95), temperatureC: 24.6, ts: new Date(Date.now() + 3600000).toISOString() }, s.token);
    expect(ahead.status).toBe(200);
    const last = await db(() => SELECT.one.from('medilink.ConditionLogs').where({ transfer_ID: s.transfer }).orderBy('loggedAt desc'));
    expect(new Date(last.loggedAt).getTime()).toBeLessThanOrEqual(Date.now() + 60000); // a fast device clock: at most a minute ahead
  });

  test('after the hand-over the link shows the finished job, for 2 h only', async () => {
    const acc = await act('asha', 'accept-delivery', { transferId: s.transfer, batchNo: s.batches, sealIntact: true, qtyReceived: 16 });
    expect(acc.status).toBe(200);
    const done = await job(s.token);
    expect(done.data).toMatchObject({ status: 'DELIVERED', readOnly: true, next: 'done' });
    expect((await cpost('/courier/location', { lat: 12.93, long: 77.58 }, s.token)).data.code).toBe('INVALID_STATUS');
    expect((await cpost('/courier/road-closed', {}, s.token)).status).toBe(409);
    expect((await T.axios.get(s.url, as('asha'))).data.legs[0].steps.every(x => x.done)).toBe(true);
    const [row] = await db(() => SELECT.from('medilink.CourierLinks').where({ transfer_ID: s.transfer, revokedAt: null }));
    const { deliveredAt } = await db(() => SELECT.one.from('medilink.Transfers').columns('deliveredAt').where({ ID: s.transfer }));
    expect(new Date(row.expiresAt) - new Date(deliveredAt)).toBe(2 * 3600000);
    // two hours later
    await db(async () => {
      await UPDATE('medilink.Transfers').set({ deliveredAt: new Date(Date.now() - 3 * 3600000).toISOString() }).where({ ID: s.transfer });
      await UPDATE('medilink.CourierLinks').set({ expiresAt: new Date(Date.now() - 3600000).toISOString() }).where({ ID: row.ID });
    });
    expect((await job(s.token)).status).toBe(401);
    expect((await T.axios.get(s.url, as('asha'))).data.legs).toEqual([]);
  });

  test('rate limits per link and per IP, before the link is even looked up', async () => {
    const saved = { ...courier.LIMITS };
    try {
      courier._hits.clear(); courier.LIMITS.perLink = 3;
      const one = `Courier ${'B'.repeat(43)}`;
      const codes = [];
      for (let i = 0; i < 4; i++) codes.push((await T.axios.get('/courier/job', { headers: { Authorization: one } })).status);
      expect(codes).toEqual([401, 401, 401, 429]);
      courier._hits.clear(); courier.LIMITS.perIp = 2;
      const many = [];
      for (const c of 'CDE') many.push(await T.axios.get('/courier/job', { headers: { Authorization: `Courier ${c.repeat(43)}` } }));
      expect(many.map(x => x.status)).toEqual([401, 401, 429]);
      expect(many[2].data).toMatchObject({ code: 'COURIER_TOO_MANY_REQUESTS', title: 'Too many updates', fix: 'Wait a minute, then try again.' });
    } finally { Object.assign(courier.LIMITS, saved); courier._hits.clear(); }
  });
});
