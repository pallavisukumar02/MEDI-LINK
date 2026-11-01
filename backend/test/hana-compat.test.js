'use strict';
/*
 * HANA readiness without a HANA account (npm run test:hana-compat):
 *   1. the CDS model compiles to SAP HANA DDL (hdbtable)
 *   2. no SQLite-only SQL anywhere in srv/ (lint)
 *   3. every query the app runs in a full flow (cover, rules, routing, workflow, delivery, receipt, ledger,
 *      experience layer, metrics, jobs) is captured and rendered with SAP HANA's own CQN-to-SQL renderer
 *   4. no TIMESTAMP column is compared with an ISO "...Z" string (implicit conversion is not portable)
 *   5. HANA spatial: geo.distancesKm uses ST_Distance on HANA and Haversine elsewhere, behind one function
 * What this cannot prove: runtime behaviour on a real HANA Cloud instance (see docs/SAP_GO_LIVE.md).
 */
require('./helpers/env')({ MATCHER_URL: 'http://localhost:1', MATCHER_FALLBACK_ENABLED: 'true' });
const fs = require('fs');
const path = require('path');
const cds = require('@sap/cds');
const T = cds.test(__dirname + '/..');
T.axios.defaults.validateStatus = () => true;
const ingestH1 = require('./helpers/h1');

const captured = [];
const as = user => ({ auth: { username: user, password: 'demo' } });
const home = async u => (await T.axios.get('/me/home', as(u))).data;
const act = async (u, a, extra = {}) => { const r = await T.axios.post(a.path, { ...a.body, ...extra }, as(u)); expect([u, a.id, r.status]).toEqual([u, a.id, 200]); return r.data; };

beforeAll(async () => {
  cds.db.before('*', req => { if (req.query && typeof req.query === 'object') captured.push(req.query); });
  await ingestH1();
  // a full flow through every module, so the captured queries cover what production will run
  for (const u of ['asha', 'ravi', 'meera', 'partner', 'admin', 'lata', 'hari']) await home(u);
  const send = (await home('asha')).tasks.find(t => t.kind === 'send_request').primaryAction;
  const j = (await act('asha', send)).journey;
  await act('asha', j.actions.find(a => a.id === 'choose-plan'));
  await act('ravi', (await home('ravi')).tasks.find(t => t.kind === 'accept_request').primaryAction, { repaymentMode: 'IN_KIND' });
  await act('meera', (await home('meera')).tasks.find(t => t.kind === 'approve').primaryAction);
  await act('kiran', (await home('kiran')).tasks.find(t => t.kind === 'approve').primaryAction);
  await act('partner', (await home('partner')).tasks.find(t => t.kind === 'pickup').primaryAction, { batchNo: 'SOL24B077,SOL25A015', sealId: 'S1', loggerId: 'L1' });
  const tid = (await home('asha')).journeys.find(x => x.id === j.id).transferId;
  await T.axios.post('/odata/v4/delivery/telemetry', { transfer: tid, lat: 12.926, long: 77.555, temperatureC: 24 }, as('sim'));
  await act('partner', (await home('partner')).journeys.find(x => x.id === j.id).actions.find(a => a.id === 'report-road-closed'));
  await T.axios.post('/odata/v4/delivery/telemetry', { transfer: tid, lat: 12.9298, long: 77.5822, temperatureC: 24 }, as('sim'));
  await act('asha', (await home('asha')).tasks.find(t => t.kind === 'arrival').primaryAction, { batchNo: 'SOL24B077,SOL25A015', sealIntact: true });
  await T.axios.get("/odata/v4/cover/shortfall(drug='D-CARB450',window=14,hospital=null)", as('asha'));
  await T.axios.get('/odata/v4/cover/cityView(window=14)', as('admin'));
  await T.axios.get('/admin/metrics', as('admin'));
  await T.axios.get('/audit/verify', as('admin'));
  await cds.tx(() => require('../srv/lib/workflow').timeoutSweep(new Date(Date.now() + 3600000)));
  await require('../srv/lib/jobs').runOnce();
}, 120000);

test('the model compiles to SAP HANA tables', async () => {
  const csn = await cds.load(path.join(__dirname, '..', 'srv'));
  const out = [...cds.compile.to.hdbtable(csn)];
  expect(out.length).toBeGreaterThan(20);
  const ddl = out.map(([src]) => src).join('\n');
  expect(ddl).toMatch(/COLUMN TABLE medilink_Transfers/);
  expect(ddl).toMatch(/transferNote NVARCHAR\(1000\)/);
});

test('no SQLite-only SQL in srv/', () => {
  const SQLITE_ONLY = /\b(julianday|strftime|datetime\s*\(|date\s*\(\s*'now'|group_concat|sqlite_\w+|PRAGMA\b|AUTOINCREMENT|INSERT\s+OR\s+(REPLACE|IGNORE)|ON\s+CONFLICT|json_extract|json_each|typeof\s*\()/i;
  const files = dir => fs.readdirSync(dir, { withFileTypes: true }).flatMap(e => (e.isDirectory() ? files(path.join(dir, e.name)) : /\.(js|cds)$/.test(e.name) ? [path.join(dir, e.name)] : []));
  const hits = [];
  for (const f of files(path.join(__dirname, '..', 'srv'))) {
    fs.readFileSync(f, 'utf8').split('\n').forEach((line, i) => {
      const code = line.replace(/\/\/.*$/, '');
      if (SQLITE_ONLY.test(code)) hits.push(`${path.relative(process.cwd(), f)}:${i + 1}: ${line.trim()}`);
    });
  }
  expect(hits).toEqual([]);
});

test('every captured query renders as SAP HANA SQL', () => {
  const HANAService = require('@cap-js/hana/lib/HANAService');
  const hana = Object.create(cds.db, { server: { value: { major: 4 } } }); // SAP HANA Cloud = HANA 4
  expect(captured.length).toBeGreaterThan(300);
  const kinds = new Set(), failures = [];
  for (const q of captured) {
    const kind = Object.keys(q).find(k => ['SELECT', 'INSERT', 'UPSERT', 'UPDATE', 'DELETE'].includes(k));
    if (!kind) continue;
    kinds.add(kind);
    try {
      const { sql } = new HANAService.CQN2SQL(hana).render(cds.ql.clone(q));
      expect(sql).not.toMatch(/\bLIMIT\s+\d+\s*,/i);
    } catch (e) { failures.push(`${kind} ${JSON.stringify(q).slice(0, 160)}: ${e.message}`); }
  }
  expect(failures).toEqual([]);
  expect([...kinds].sort()).toEqual(expect.arrayContaining(['DELETE', 'INSERT', 'SELECT', 'UPDATE']));
});

test('no TIMESTAMP column is compared with an ISO string', () => {
  const offenders = [];
  const typeOf = (entity, col) => cds.model.definitions[entity]?.elements?.[col]?.type;
  for (const q of captured) {
    const k = Object.keys(q)[0], body = q[k];
    const entity = body?.from?.ref?.[0] || body?.entity?.ref?.[0] || body?.entity;
    const where = body?.where || [];
    for (let i = 0; i + 2 < where.length; i++) {
      const [a, op, b] = where.slice(i, i + 3);
      if (a?.ref && typeof op === 'string' && /^[<>=!]+$/.test(op) && typeof b?.val === 'string' && /T\d{2}:\d{2}/.test(b.val)
        && ['cds.Timestamp', 'cds.DateTime'].includes(typeOf(entity, a.ref.at(-1)))) offenders.push(`${entity}.${a.ref.at(-1)} ${op} '${b.val}'`);
    }
  }
  expect(offenders).toEqual([]);
});

test('HANA spatial: ST_Distance on HANA, Haversine in development, behind geo.distancesKm', async () => {
  const geo = require('../srv/lib/geo');
  const H1 = { ID: 'H1', lat: 12.9299, long: 77.5826 }, H5 = { ID: 'H5', lat: 12.9255, long: 77.5468 }, H2 = { ID: 'H2', lat: 12.9698, long: 77.75 };
  const dev = await geo.distancesKm(H1, [H5, H2]);
  expect(dev.H5).toBeCloseTo(require('../srv/lib/routing').haversineKm(H1, H5), 6);
  const { sql, values } = geo.hanaQuery(H1, [H5, H2]);
  expect(sql).toBe('SELECT ? AS "ID", NEW ST_Point(?, ?).ST_SRID(4326).ST_Distance(NEW ST_Point(?, ?).ST_SRID(4326)) / 1000 AS "KM" FROM DUMMY UNION ALL SELECT ? AS "ID", NEW ST_Point(?, ?).ST_SRID(4326).ST_Distance(NEW ST_Point(?, ?).ST_SRID(4326)) / 1000 AS "KM" FROM DUMMY');
  expect(values.slice(0, 5)).toEqual(['H5', 77.5468, 12.9255, 77.5826, 12.9299]); // x = longitude, y = latitude
  // simulate HANA: the query result is used as is; a HANA error falls back to Haversine
  const realKind = cds.db.kind, realRun = cds.db.run;
  try {
    cds.db.kind = 'hana';
    cds.db.run = async (s, v) => (s.includes('ST_Distance') ? [{ ID: 'H5', KM: 3.91 }, { ID: 'H2', KM: 18.2 }] : realRun.call(cds.db, s, v));
    expect(await geo.distancesKm(H1, [H5, H2])).toEqual({ H5: 3.91, H2: 18.2 });
    cds.db.run = async () => { throw new Error('invalid spatial reference'); };
    expect((await geo.distancesKm(H1, [H5])).H5).toBeCloseTo(dev.H5, 6);
  } finally { cds.db.kind = realKind; cds.db.run = realRun; }
});
