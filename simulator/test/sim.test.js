'use strict';
const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const { interpolate, pathOf, createPlanner, pickExcursionTarget } = require('../sim');
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

test('tick() reads activeShipments and posts telemetry with the partner credentials', async () => {
  const posted = [];
  const srv = http.createServer((req, res) => {
    let b = ''; req.on('data', d => (b += d)); req.on('end', () => {
      assert.match(req.headers.authorization, /^Basic /);
      res.setHeader('Content-Type', 'application/json');
      if (req.method === 'GET' && req.url.startsWith('/odata/v4/delivery/activeShipments')) return res.end(JSON.stringify({ value: [cold] }));
      if (req.method === 'POST' && req.url === '/odata/v4/delivery/telemetry') { const j = JSON.parse(b); posted.push(j); return res.end(JSON.stringify({ accepted: true, excursion: j.temperatureC > 8, transferId: j.transfer })); }
      res.statusCode = 404; res.end('{}');
    });
  }).listen(0);
  try {
    const cfg = config({ APP_BASE_URL: `http://localhost:${srv.address().port}` });
    const pl = createPlanner({ excursionAfterTicks: 0, rnd: fixed });
    const lines = [];
    await tick(cfg, pl, l => lines.push(l));
    assert.strictEqual(posted.length, 1);
    assert.deepStrictEqual(Object.keys(posted[0]).sort(), ['lat', 'loggerId', 'long', 'sealStatus', 'temperatureC', 'transfer']);
    assert.match(lines[0], /EXCURSION/);
  } finally { srv.close(); }
});
