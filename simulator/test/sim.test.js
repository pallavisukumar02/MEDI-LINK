'use strict';
const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const { interpolate, fractionAt, pathOf, createPlanner, pickExcursionTarget } = require('../sim');
const { tick, config } = require('../index');

const cold = { ID: 'a0000000-cold', loggerId: 'LOG-1', storageClass: 'COLD', minC: 2, maxC: 8, fromLat: 12.97, fromLong: 77.75, toLat: 12.935, toLong: 77.62, etaMin: 60, via: '[]' };
const amb = { ID: 'b0000000-amb', loggerId: 'LOG-2', storageClass: 'AMBIENT', minC: 2, maxC: 30, fromLat: 12.9255, fromLong: 77.5468, toLat: 12.9299, toLong: 77.5826, etaMin: 30, via: JSON.stringify([{ lat: 12.94, long: 77.56 }]) };
const fixed = () => 0.5;

test('interpolate walks the polyline including detour waypoints', () => {
  const p = pathOf(amb);
  assert.strictEqual(p.length, 3);
  assert.deepStrictEqual(interpolate(p, 0), { lat: 12.9255, long: 77.5468 });
  assert.deepStrictEqual(interpolate(p, 1), { lat: 12.9299, long: 77.5826 });
  const mid = interpolate(p, 0.3);
  assert.ok(mid.lat > 12.9255 && mid.lat <= 12.94);
});

test('a restarted simulator carries on from the last fix instead of sending the rider back', () => {
  const s = { ID: 't1', fromLat: 0, fromLong: 0, toLat: 0, toLong: 10, via: [], etaMin: 30, pickedUpAt: new Date(Date.now() - 3600e3).toISOString(), minC: 2, maxC: 8, storageClass: 'COLD' };
  assert.ok(Math.abs(fractionAt(pathOf(s), { lat: 0.1, long: 8 }) - 0.8) < 1e-9);
  const resumed = createPlanner({ excursion: false }).next([{ ...s, lastLat: 0, lastLong: 8 }])[0];
  assert.deepStrictEqual([resumed.lat, resumed.long], [0, 8]);
  assert.strictEqual(createPlanner({ excursion: false }).next([s])[0].long, 5); // no fix yet: a new delivery starts at most halfway
});

test('cold chain is preferred as the excursion target', () => {
  assert.strictEqual(pickExcursionTarget([amb, cold]), cold.ID);
  assert.strictEqual(pickExcursionTarget([amb]), amb.ID);
  assert.strictEqual(pickExcursionTarget([]), null);
});

test('exactly one deliberate excursion, on one shipment, after N ticks', () => {
  const pl = createPlanner({ excursion: true, excursionAfterTicks: 2, excursionTicks: 2, rnd: fixed });
  const all = [];
  for (let i = 0; i < 10; i++) all.push(...pl.next([amb, cold]));
  const ex = all.filter(r => r.excursion);
  assert.strictEqual(ex.length, 2);
  assert.ok(ex.every(r => r.transfer === cold.ID && r.temperatureC > 8));
  for (const r of all.filter(x => !x.excursion)) {
    const s = r.transfer === cold.ID ? cold : amb;
    assert.ok(r.temperatureC >= s.minC && r.temperatureC <= s.maxC, `in range ${r.temperatureC}`);
  }
});

test('no excursion when disabled; shipments advance but stop short of arrival', () => {
  const pl = createPlanner({ excursion: false, speedup: 1000, rnd: fixed });
  let last;
  for (let i = 0; i < 20; i++) last = pl.next([cold]);
  assert.ok(last.every(r => !r.excursion));
  assert.strictEqual(last[0].progress, 0.97);
});

test('tick() lists the courier links as admin, picks up after a minute, posts readings through each link', async () => {
  const seen = [];
  const T = { moving: 'M'.repeat(43), stale: 'S'.repeat(43), fresh: 'F'.repeat(43) };
  const picked = new Set();
  const job = (status, extra = {}) => ({ status, storageClass: 'COLD', temperatureRange: { minC: 2, maxC: 8 }, pickup: { lat: 12.97, long: 77.75 }, drop: { lat: 12.935, long: 77.62 }, route: { points: [[12.97, 77.75], [12.95, 77.7], [12.935, 77.62]] }, etaMin: 60, pickedUpAt: null, ...extra });
  const srv = http.createServer((req, res) => {
    let b = ''; req.on('data', d => (b += d)); req.on('end', () => {
      seen.push({ method: req.method, url: req.url, auth: req.headers.authorization, body: b && JSON.parse(b) });
      res.setHeader('Content-Type', 'application/json');
      const token = (/^Courier (\S+)$/.exec(req.headers.authorization || '') || [])[1];
      if (req.url === '/admin/courier-links') {
        assert.match(req.headers.authorization, /^Basic /);
        return res.end(JSON.stringify({ links: [
          { transferId: 'a0000000-moving', status: 'IN_TRANSIT', token: T.moving, createdAt: new Date().toISOString(), batches: ['NB24T044'] },
          { transferId: 'b0000000-stale', status: 'ASSIGNED', token: T.stale, createdAt: new Date(Date.now() - 120000).toISOString(), batches: ['B1', 'B2'] },
          { transferId: 'c0000000-fresh', status: 'ASSIGNED', token: T.fresh, createdAt: new Date().toISOString(), batches: ['B3'] },
        ] }));
      }
      if (req.url === '/courier/pickup' && token === T.stale) { picked.add(token); return res.end(JSON.stringify({ message: 'ok' })); }
      if (req.url === '/courier/job' && token) return res.end(JSON.stringify(job(token === T.moving || picked.has(token) ? 'IN_TRANSIT' : 'ASSIGNED', { pickedUpAt: new Date().toISOString() })));
      if (req.url === '/courier/location' && token) return res.end(JSON.stringify({ accepted: true, excursion: JSON.parse(b).temperatureC > 8 }));
      res.statusCode = 404; res.end('{}');
    });
  }).listen(0);
  try {
    const cfg = config({ APP_BASE_URL: `http://localhost:${srv.address().port}` });
    const pl = createPlanner({ excursionAfterTicks: 0, rnd: fixed });
    const lines = [];
    const readings = await tick(cfg, pl, l => lines.push(l));
    assert.strictEqual(readings.length, 2);
    const pickup = seen.filter(x => x.url === '/courier/pickup');
    assert.strictEqual(pickup.length, 1); // the fresh one is left to a person for a minute
    assert.strictEqual(pickup[0].auth, 'Courier ' + T.stale);
    assert.deepStrictEqual(pickup[0].body.batchNo, 'B1,B2');
    const posts = seen.filter(x => x.url === '/courier/location');
    assert.deepStrictEqual(posts.map(x => x.auth).sort(), ['Courier ' + T.moving, 'Courier ' + T.stale]);
    for (const p of posts) assert.deepStrictEqual(Object.keys(p.body).sort(), ['lat', 'long', 'sealStatus', 'temperatureC']);
    assert.ok(seen.every(x => x.url !== '/courier/job' || x.auth !== 'Courier ' + T.fresh));
    assert.ok(lines.some(l => /EXCURSION/.test(l)));
    assert.ok(!lines.join('\n').includes(T.moving)); // tokens are never printed
  } finally { srv.close(); }
});

test('the simulator signs in as the admin with the demo password by default', () => {
  const basic = u => 'Basic ' + Buffer.from(u).toString('base64');
  assert.strictEqual(config({ DEMO_PASSWORD: 'pw-1' }).auth, basic('admin:pw-1'));
  assert.strictEqual(config({ SIM_USER: 'ops', SIM_PASSWORD: 'pw-2' }).auth, basic('ops:pw-2'));
  assert.strictEqual(config({ SIM_BEARER_TOKEN: 'abc' }).auth, 'Bearer abc');
});
