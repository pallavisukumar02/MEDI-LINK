#!/usr/bin/env node
'use strict';
/*
 * npm run demo  ->  runs the PRD section 18 three-minute demo script against a RUNNING dev stack (npm run dev).
 * Uses only the demo users (HTTP Basic, DEMO_PASSWORD from backend/.env) and synthetic data. The demo changes the
 * data: before running it again, stop npm run dev, run npm run db:reset, start npm run dev.
 *
 * Env: APP_BASE_URL (http://localhost:4004), MEDISOFT_BASE_URL (http://localhost:4100)
 */
require('../simulator/index.js').loadEnv(require('path').join(__dirname, '..', 'backend', '.env')); // DEMO_PASSWORD (never printed)
const BASE = (process.env.APP_BASE_URL || 'http://localhost:4004').replace(/\/$/, '');
const MS = (process.env.MEDISOFT_BASE_URL || 'http://localhost:4100').replace(/\/$/, '');
const auth = u => 'Basic ' + Buffer.from(`${u}:${process.env.DEMO_PASSWORD || 'demo'}`).toString('base64');

async function api(method, path, user, body) {
  const res = await fetch(BASE + path, { method, headers: { Authorization: auth(user), 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text();
  let json; try { json = text ? JSON.parse(text) : {}; } catch { json = text; }
  return { status: res.status, data: json };
}
const get = (p, u) => api('GET', p, u);
const post = (p, u, b) => api('POST', p, u, b);
async function courier(path, token, body) { // the courier has no account: its per-delivery link is the credential
  const res = await fetch(BASE + path, { method: 'POST', headers: { Authorization: 'Courier ' + token, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  return { status: res.status, data: await res.json() };
}

let failures = 0;
const beat = t => console.log(`\n\x1b[1m${t}\x1b[0m`);
const ok = (cond, msg, extra = '') => { console.log(`  ${cond ? '\x1b[32m✔\x1b[0m' : '\x1b[31m✘\x1b[0m'} ${msg}${extra ? '  ' + extra : ''}`); if (!cond) failures++; return cond; };
const must = (cond, msg) => { if (!ok(cond, msg)) { console.log('\nDemo stopped. Is `npm run dev` running on a fresh database (stop it, npm run db:reset, start it again)?'); process.exit(1); } };

/** Simulates the pharmacist's browser: MediSoft login popup + consent screen, then the redirect back to CAP. */
async function allowInMediSoft(authorizeUrl) {
  const q = Object.fromEntries(new URL(authorizeUrl).searchParams);
  const form = o => new URLSearchParams(o).toString();
  const H = { 'Content-Type': 'application/x-www-form-urlencoded' };
  const login = await fetch(`${MS}/oauth/login`, { method: 'POST', headers: H, body: form({ ...q, username: 'pharm.jayanagar', password: 'medisoft-demo' }), redirect: 'manual' });
  const cookie = (login.headers.get('set-cookie') || '').split(';')[0];
  const consent = await fetch(`${MS}/oauth/consent`, { method: 'POST', headers: { ...H, cookie }, body: form({ ...q, decision: 'allow' }), redirect: 'manual' });
  const cb = consent.headers.get('location');
  const back = await fetch(cb);
  return { status: back.status, html: await back.text() };
}

(async () => {
  try { await fetch(BASE + '/health'); } catch { console.error(`CAP is not reachable at ${BASE}. Start it with: npm run dev`); process.exit(1); }
  console.log('MediLink demo (PRD section 18) - SYNTHETIC data, demo users, no SAP credentials');

  beat('1. Onboard live: licence number + Allow');
  const exp = await post('/onboarding/licence', 'asha', { licenceNo: 'KA-BLR-20B-1004' });
  ok(exp.status === 403 && exp.data.error?.code === 'LICENCE_EXPIRED', 'Expired licence KA-BLR-20B-1004 refused', `"${exp.data.error?.message}"`);
  const lic = await post('/onboarding/licence', 'asha', { licenceNo: 'KA-BLR-20B-1001' });
  must(lic.status === 200 && lic.data.next === 'OAUTH_ALLOW', `Licence found: ${lic.data.message}`);
  const cb = await allowInMediSoft(lic.data.authorizeUrl);
  ok(cb.status === 200 && /board will be ready/.test(cb.html), 'Signed in to "MediSoft", tapped Allow: read-only token stored, consent logged');

  beat('2. Carboplatin is red');
  const board = await get('/odata/v4/cover/board(window=14,hospital=null)', 'asha');
  const carb = board.data.value?.find(r => r.drugId === 'D-CARB450');
  must(carb && carb.status === 'RED', `Carboplatin 450 mg: ${carb?.message}`);
  const card = await get("/odata/v4/cover/shortfall(drug='D-CARB450',window=14,hospital=null)", 'asha');
  ok(card.data.affected?.length > 0, `${card.data.affected?.length} booked patients affected first (hashed refs only), ${card.data.affected?.filter(a => a.curative).length} with curative intent`);

  beat('3. Tap Request (prefilled): hard rules + OR-Tools ranking');
  const r = await post('/odata/v4/requests/createRequest', 'asha', { drug: 'D-CARB450' });
  must(r.status === 200, `Request created: ${r.data.qty} doses needed by ${r.data.neededBy} (engine ${r.data.ranking?.engine})`);
  const ex = r.data.ranking.exclusions;
  ok(ex.some(e => e.code === 'FLAGGED_BATCH'), 'Flagged lot dropped out', ex.find(e => e.code === 'FLAGGED_BATCH')?.detail);
  ok(ex.some(e => e.code === 'SUPPLIER_LICENCE_INVALID'), 'Unlicensed site dropped out', ex.find(e => e.code === 'SUPPLIER_LICENCE_INVALID')?.hospitalName);
  const p1 = r.data.ranking.plans[0];
  must(p1, `Plan 1: ${p1?.reason}`);

  beat('4. Supplier accepts in kind; approver signs');
  const [t] = (await post('/odata/v4/requests/choosePlan', 'asha', { request: r.data.request, rank: 1 })).data.value;
  const supplierUser = { H5: 'ravi', H2: 'sunil', H3: 'lata' }[t.supplierId];
  const rv = await get(`/odata/v4/supplier/review(transfer=${t.ID})`, supplierUser);
  ok(rv.data.ownBookingsStayCovered, `Supplier ${t.supplierId} sees its own bookings stay covered (after: ${rv.data.coverAfter?.message || rv.data.coverAfter?.status})`);
  const acc = await post('/odata/v4/supplier/accept', supplierUser, { transfer: t.ID, repaymentMode: 'IN_KIND' });
  must(acc.data.status === 'PENDING_APPROVAL', 'Accepted; repayment in kind; loan recorded in the ledger');
  let ap = await post('/odata/v4/approval/approveTransfer', 'meera', { transfer: t.ID });
  if (ap.data.status === 'PENDING_SECOND_APPROVAL') { ok(true, `First sign-off; second sign-off required (${ap.data.riskReasons})`); ap = await post('/odata/v4/approval/approveTransfer', 'kiran', { transfer: t.ID }); }
  must(ap.data.status === 'ASSIGNED', `Approved; licensed partner ${ap.data.partnerId} assigned`);

  beat('5. Road flooded: re-plan. Temperature spike on another shipment: quarantine alert');
  const lots = (await get(`/odata/v4/supplier/TransferLots?$filter=transfer_ID eq ${t.ID}`, supplierUser)).data.value;
  const link = await post('/me/actions/courier-link', supplierUser, { transferId: t.ID });
  must(link.status === 200, `Courier link shared by the supplier (no courier account): ${String(link.data.result?.url).replace(/#t=.*/, '#t=…')}`);
  const token = new URL(link.data.result.url).hash.replace(/^#t=/, '');
  const pk = await courier('/courier/pickup', token, { batchNo: lots.map(l => l.batchNo).join(','), sealId: 'SEAL-9001', loggerId: 'LOG-9001' });
  must(pk.data.job?.status === 'IN_TRANSIT', `Pickup scan through the link: batch ${lots.map(l => l.batchNo).join(', ')}, seal SEAL-9001, logger LOG-9001`);
  const sup = (await get(`/odata/v4/cover/Hospitals('${t.supplierId}')`, 'admin')).data, rec = (await get("/odata/v4/cover/Hospitals('H1')", 'admin')).data;
  const at = f => ({ lat: Number(sup.lat) + (Number(rec.lat) - Number(sup.lat)) * f, long: Number(sup.long) + (Number(rec.long) - Number(sup.long)) * f });
  await courier('/courier/location', token, { ...at(0.2), temperatureC: 24.4 });
  const rc = await post('/odata/v4/routes/setRouteClosed', 'admin', { transfer: t.ID, closed: true, note: 'Flooded underpass' });
  ok(rc.status === 200 && rc.data.open, `Route re-planned: ${rc.data.note} (${rc.data.distanceKm} km, ~${rc.data.etaMin} min)`);
  let exc = (await get("/odata/v4/admin/Notifications?$filter=kind eq 'EXCURSION'", 'admin')).data.value;
  if (!exc.length) { // simulator not running: raise the spike ourselves on the seeded cold-chain shipment
    const cold = (await get('/admin/courier-links', 'admin')).data.links?.find(l => l.transferId === 'a0000000-0000-4000-8000-000000000001');
    if (cold) await courier('/courier/location', cold.token, { lat: 12.95, long: 77.69, temperatureC: 11.4 });
    exc = (await get("/odata/v4/admin/Notifications?$filter=kind eq 'EXCURSION'", 'admin')).data.value;
  }
  ok(exc.length >= 2, `Excursion alert to both hospitals: "${exc[0]?.message}"`);

  beat('6. Arrival: proof of condition, coverage turns green, ledger, audit chain');
  await courier('/courier/location', token, { ...at(0.98), temperatureC: 24.9 });
  const arr = await post('/odata/v4/receipt/arrivalScan', 'asha', { transfer: t.ID, batchNo: lots.map(l => l.batchNo).join(','), sealIntact: true, qtyReceived: t.qty, decision: 'ACCEPT' });
  must(arr.data.proofOfCondition === 'PASS', `Proof of condition PASS; status ${arr.data.status}`);
  const after = (await get('/odata/v4/cover/board(window=14,hospital=null)', 'asha')).data.value.find(x => x.drugId === 'D-CARB450');
  ok(after.status === 'GREEN', `Carboplatin coverage is ${after.status}: ${after.covered} of ${after.booked} doses covered`);
  const loan = (await get('/odata/v4/ledger/Loans', 'asha')).data.value.find(l => l.transfer_ID === t.ID);
  ok(loan?.status === 'OPEN', `Ledger: ${loan?.lender_ID} lent ${loan?.qty} units to ${loan?.borrower_ID}, repay ${loan?.repaymentMode} (landed cost INR ${loan?.landedCost})`);
  const v = await get('/audit/verify', 'admin');
  ok(v.data.ok, `Audit chain verifies: ${v.data.count} entries, head ${String(v.data.head).slice(0, 12)}...`);

  beat('7. City view: aggregated, anonymised shortfalls');
  const city = (await get('/odata/v4/cover/cityView(window=14)', 'admin')).data.value;
  for (const c of city.slice(0, 5)) console.log(`  ${c.genericName} ${c.strength}: ${c.hospitalsShort} hospital(s) short, ${c.dosesShort} of ${c.dosesBooked} doses, city surplus ${c.citySurplus}`);

  console.log(failures ? `\n\x1b[31m${failures} check(s) failed\x1b[0m` : '\n\x1b[32mDemo script completed end to end.\x1b[0m');
  process.exit(failures ? 1 : 0);
})().catch(e => { console.error('demo failed:', e.message); process.exit(1); });
