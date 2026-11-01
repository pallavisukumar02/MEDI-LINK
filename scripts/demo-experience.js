#!/usr/bin/env node
'use strict';
/*
 * npm run demo:experience  ->  the PRD section 18 demo through the experience layer (/me/*) only, against a RUNNING,
 * freshly started dev stack (npm run dev). At every beat it prints each user's home screen in plain language,
 * the way a beginner-friendly UI would show it. Synthetic data, mocked users, no SAP credentials.
 * Not /me: the MediSoft login popup (the hospital software's own screen) and the courier's temperature logger feed.
 * The dev database is in memory: restart `npm run dev` before running this (or `npm run demo`) again.
 */
const BASE = (process.env.APP_BASE_URL || 'http://localhost:4004').replace(/\/$/, '');
const MS = (process.env.MEDISOFT_BASE_URL || 'http://localhost:4100').replace(/\/$/, '');
require('../simulator/index.js').loadEnv(require('path').join(__dirname, '..', 'backend', '.env')); // DEMO_PASSWORD (never printed)
// development: mocked users (Basic, password "demo"); standalone: real logins through POST /auth/login (JWT)
let standalone = false;
const tokens = {};
async function auth(u) {
  if (!standalone) return 'Basic ' + Buffer.from(`${u}:demo`).toString('base64');
  if (!tokens[u]) {
    const r = await fetch(BASE + '/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: u, password: process.env.DEMO_PASSWORD || '' }) });
    const body = await r.json();
    if (r.status !== 200) { console.error(`Login as ${u} failed: ${body.title}. ${body.fix}`); process.exit(1); }
    tokens[u] = 'Bearer ' + body.token;
  }
  return tokens[u];
}
const C = { b: s => `\x1b[1m${s}\x1b[0m`, dim: s => `\x1b[2m${s}\x1b[0m`, red: s => `\x1b[31m${s}\x1b[0m`, green: s => `\x1b[32m${s}\x1b[0m`, amber: s => `\x1b[33m${s}\x1b[0m`, grey: s => `\x1b[90m${s}\x1b[0m`, cyan: s => `\x1b[36m${s}\x1b[0m` };
const dot = c => ({ red: C.red('●'), amber: C.amber('●'), green: C.green('●'), grey: C.grey('●') }[c] || '●');

async function api(method, path, user, body, headers = {}) {
  const res = await fetch(BASE + path, { method, headers: { Authorization: await auth(user), 'Content-Type': 'application/json', ...headers }, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text();
  let data; try { data = text ? JSON.parse(text) : {}; } catch { data = text; }
  return { status: res.status, data };
}
const home = async u => (await api('GET', '/me/home', u)).data;
let taps = 0;
const tap = (u, a, values = {}) => api('POST', a.path, u, { ...(a.body || {}), ...values }, { 'Idempotency-Key': `demo-${Date.now()}-${++taps}` });
const device = body => api('POST', '/odata/v4/delivery/telemetry', 'sim', body); // courier's logger feed
const task = (h, kind) => h.tasks.find(t => t.kind === kind);

let failures = 0;
const beat = t => console.log(`\n${C.b('━━ ' + t + ' ' + '━'.repeat(Math.max(0, 70 - t.length)))}`);
const check = (cond, msg) => { console.log(`  ${cond ? C.green('✔') : C.red('✘')} ${msg}`); if (!cond) failures++; return cond; };
const must = (cond, msg) => { if (!check(cond, msg)) { console.log('\nDemo stopped. Is `npm run dev` running with a fresh (restarted) database?'); process.exit(1); } };
const said = (who, r) => console.log(`  ${C.cyan(who + ' tapped')} → ${r.status === 200 ? r.data.message : C.red(`${r.data.title}: ${r.data.message} ${C.dim('(' + r.data.fix + ')')}`)}`);

function show(user, h) {
  const who = h.hospital?.name || h.partner?.name || 'MediLink';
  console.log(`\n  ${C.b(`${user} (${h.user.role})`)} · ${who} ${C.dim('· ' + h.greeting)}`);
  if (h.hospital) console.log(`    ${h.hospital.connection.text} · ${h.hospital.licence.text}`);
  if (h.coverSummary) console.log(`    Cover: ${h.coverSummary.text}${h.coverSummary.emptyText ? C.dim(' · ' + h.coverSummary.emptyText) : ''}`);
  if (h.onboarding) console.log(`    Setting up: ${h.onboarding.step}: ${h.onboarding.message}`);
  for (const a of h.alerts.slice(0, 3)) console.log(`    ${dot(a.severity)} ${a.message}`);
  if (h.empty.alerts) console.log(`    ${C.dim(h.empty.alerts)}`);
  for (const t of h.tasks.slice(0, 3)) console.log(`    ${C.b('▶ ' + t.title)} ${C.dim('· ' + t.subtitle)}  [${t.primaryAction.label}]${t.secondaryAction ? ` [${t.secondaryAction.label}]` : ''}`);
  if (h.empty.tasks) console.log(`    ${C.dim(h.empty.tasks)}`);
  for (const j of h.journeys.slice(0, 3)) console.log(`    ${dot(j.colour)} ${C.dim(`${j.stage}/7 ${j.stageLabel}`)} ${j.headline}`);
}
const showAll = async (...users) => { for (const u of users) show(u, await home(u)); };

/** The MediSoft login popup and consent screen (the hospital software's own UI), then the redirect back to MediLink. */
async function allowInMediSoft(url) {
  const q = Object.fromEntries(new URL(url).searchParams);
  const form = o => new URLSearchParams(o).toString();
  const H = { 'Content-Type': 'application/x-www-form-urlencoded' };
  const login = await fetch(`${MS}/oauth/login`, { method: 'POST', headers: H, body: form({ ...q, username: 'pharm.jayanagar', password: 'medisoft-demo' }), redirect: 'manual' });
  const consent = await fetch(`${MS}/oauth/consent`, { method: 'POST', headers: { ...H, cookie: (login.headers.get('set-cookie') || '').split(';')[0] }, body: form({ ...q, decision: 'allow' }), redirect: 'manual' });
  return (await fetch(consent.headers.get('location'))).status;
}

(async () => {
  try { standalone = (await (await fetch(BASE + '/health')).json()).mode === 'standalone'; } catch { console.error(`CAP is not reachable at ${BASE}. Start it with: npm run dev`); process.exit(1); }
  console.log(C.b(`MediLink demo through the experience layer (/me/*) - SYNTHETIC data, ${standalone ? 'standalone mode, real logins (POST /auth/login)' : 'mocked users'}, no SAP credentials`));

  beat('1. Onboarding: licence number + Allow');
  const ob = (await api('GET', '/me/onboarding', 'asha')).data;
  must(ob.current === 'licence', `asha's checklist: ${ob.steps.map(s => (s.status === 'current' ? C.b(s.label) : s.label)).join(' → ')}`);
  said('asha', await tap('asha', ob.nextAction, { licenceNo: 'KA-BLR-20B-1004' }));
  const lic = await tap('asha', ob.nextAction, { licenceNo: 'KA-BLR-20B-1001' });
  said('asha', lic);
  must(lic.data.next?.type === 'open', `Next: "${lic.data.next?.label}" opens the hospital software's sign-in`);
  must(await allowInMediSoft(lic.data.next.url) === 200, 'Signed in to MediSoft and tapped Allow');
  await showAll('asha');

  beat('2. Carboplatin is red');
  const h2 = await home('asha');
  const send = task(h2, 'send_request');
  must(send, `Task card: ${send?.title} · ${send?.subtitle}`);

  beat('3. One tap: request sent, unsafe stock never offered, nearest supplier first');
  const r3 = await tap('asha', send.primaryAction, { allowBrandSwitch: false });
  said('asha', r3);
  const choose = task(await home('asha'), 'choose_plan');
  must(choose, `${choose?.title} · ${choose?.subtitle}`);
  for (const o of choose.primaryAction.fields.find(f => f.name === 'plan')?.options?.slice(0, 2) || []) console.log(`    option: ${o.label} ${C.dim('· ' + o.reason)}`);
  said('asha', await tap('asha', choose.primaryAction));
  await showAll('asha', 'ravi');

  beat('4. Supplier accepts in kind; approvers sign');
  const acc = task(await home('ravi'), 'accept_request');
  must(acc, `ravi sees: ${acc?.subtitle}`);
  said('ravi', await tap('ravi', acc.primaryAction, { quantity: acc.primaryAction.fields[0].default, repaymentMode: 'IN_KIND' }));
  await showAll('meera');
  said('meera', await tap('meera', task(await home('meera'), 'approve').primaryAction));
  const k = task(await home('kiran'), 'approve');
  if (k) said('kiran', await tap('kiran', k.primaryAction));
  await showAll('asha', 'ravi', 'partner');

  beat('5. Pickup, live tracking, road closed, temperature spike on another shipment');
  const pk = task(await home('partner'), 'pickup');
  must(pk, `partner: ${pk?.title} · ${pk?.subtitle}`);
  const batches = pk.primaryAction.fields[0].hint.replace(/^Expected: /, '');
  said('partner', await tap('partner', pk.primaryAction, { batchNo: batches, sealId: 'SEAL-9001', loggerId: 'LOG-9001' }));
  const jid = (await home('asha')).journeys.find(j => j.drug.id === 'D-CARB450');
  const H1 = { lat: 12.9299, long: 77.5826 }, H5 = { lat: 12.9255, long: 77.5468 };
  const at = f => ({ lat: H5.lat + (H1.lat - H5.lat) * f, long: H5.long + (H1.long - H5.long) * f });
  await device({ transfer: jid.transferId, ...at(0.2), temperatureC: 24.4 });
  await showAll('asha');
  const road = (await home('partner')).journeys.find(j => j.id === jid.id).actions.find(a => a.id === 'report-road-closed');
  said('partner', await tap('partner', road, { note: 'Silk Board junction' }));
  await device({ loggerId: 'LOG-7781', lat: 12.95, long: 77.69, temperatureC: 11.4 }); // the seeded cold-chain shipment spikes
  await showAll('asha', 'lata');

  beat('6. Arrival: scan, checks, coverage turns green, loan shown to both');
  let arr; // the simulator may move the courier between our fix and the read, so re-send the fix a few times
  for (let i = 0; i < 5 && !arr; i++) { await device({ transfer: jid.transferId, ...at(0.98), temperatureC: 24.9 }); arr = task(await home('asha'), 'arrival'); }
  must(arr, `asha: ${arr?.title} · ${arr?.subtitle}`);
  said('asha', await tap('asha', arr.primaryAction, { batchNo: batches, sealIntact: false }));
  const ok = await tap('asha', arr.primaryAction, { batchNo: batches, sealIntact: true });
  said('asha', ok);
  must(ok.status === 200 && ok.data.journey?.stage === 7, `Journey done: ${ok.data.journey?.headline}`);
  await showAll('asha', 'ravi');

  beat('7. City view and the success metrics');
  const city = (await api('GET', '/me/city', 'admin')).data;
  for (const r of city.rows.slice(0, 5)) console.log(`    ${r.text}`);
  const m = (await api('GET', '/admin/metrics', 'admin')).data.metrics;
  for (const x of m) console.log(`    ${x.met === false ? C.red('✘') : x.met ? C.green('✔') : C.dim('·')} ${x.label}: ${x.text}`);
  const health = (await api('GET', '/health/integrations', 'admin')).data;
  console.log(`    SAP services: ${health.summary}`);

  console.log(failures ? `\n${C.red(failures + ' check(s) failed')}` : `\n${C.green('Experience demo completed end to end, through /me/* only.')}`);
  process.exit(failures ? 1 : 0);
})().catch(e => { console.error('demo:experience failed:', e.message); process.exit(1); });
