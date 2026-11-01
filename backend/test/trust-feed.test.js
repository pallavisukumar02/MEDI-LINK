'use strict';
/*
 * Trust feed (FR-15): manual flag / recall endpoint and the LLM-based CDSCO alert parser (behind a flag).
 * The LLM is replaced by an injected fake; with LLM_PROVIDER=none parsing is refused and manual entry still works.
 */
require('./helpers/env')({ MATCHER_URL: 'http://localhost:1', MATCHER_FALLBACK_ENABLED: 'true', MEDISOFT_BASE_URL: 'http://localhost:1' });
const fs = require('fs');
const path = require('path');
const cds = require('@sap/cds');
const T = cds.test(__dirname + '/..');
T.axios.defaults.validateStatus = () => true;
const llm = require('../srv/lib/llm');

const as = user => ({ auth: { username: user, password: 'demo' } });
const get = (url, user) => T.axios.get(url, as(user));
const post = (url, body, user) => T.axios.post(url, body, as(user));
const inDays = n => new Date(Date.now() + n * 86400000).toISOString().slice(0, 10);
const ALERT = fs.readFileSync(path.resolve(__dirname, '../../seed/trust/cdsco_alert_sample.txt'), 'utf8');

/** Minimal one-page PDF carrying `text` (enough for pdf.js text extraction). */
function tinyPdf(text) {
  const esc = s => s.replace(/[\\()]/g, m => '\\' + m);
  const stream = `BT /F1 10 Tf 40 760 Td 12 TL ${text.split('\n').map(l => `(${esc(l)}) '`).join(' ')} ET`;
  const objs = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  let out = '%PDF-1.4\n'; const offs = [];
  objs.forEach((o, i) => { offs.push(out.length); out += `${i + 1} 0 obj\n${o}\nendobj\n`; });
  const xref = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offs.map(o => String(o).padStart(10, '0') + ' 00000 n \n').join('')}`;
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return Buffer.from(out, 'latin1');
}

afterEach(() => llm.setClient(undefined));

describe('manual flag / recall', () => {
  test('needs a target and a valid reason; admin only', async () => {
    expect((await post('/odata/v4/trust/recall', { reason: 'RECALL' }, 'admin')).data.error.code).toBe('FLAG_TARGET_REQUIRED');
    expect((await post('/odata/v4/trust/recall', { batchNo: 'X', reason: 'MAYBE' }, 'admin')).data.error.code).toBe('INVALID_REASON');
    expect((await post('/odata/v4/trust/recall', { batchNo: 'X' }, 'asha')).status).toBe(403);
  });

  test('recall cancels a not-yet-picked-up transfer and quarantines the lot everywhere', async () => {
    const r = await post('/odata/v4/requests/createRequest', { drug: 'D-CISP50', qty: 2, neededBy: inDays(5), allowBrandSwitch: true }, 'asha');
    const [t] = (await post('/odata/v4/requests/choosePlan', { request: r.data.request, rank: 1 }, 'asha')).data.value;
    const tl = (await get(`/odata/v4/supplier/TransferLots?$filter=transfer_ID eq ${t.ID}`, 'admin')).data.value[0];
    const rc = await post('/odata/v4/trust/recall', { batchNo: tl.batchNo, reason: 'RECALL', source: 'Manufacturer recall letter (demo)' }, 'admin');
    expect(rc.status).toBe(200);
    expect(rc.data).toMatchObject({ transfersCancelled: 1 });
    expect(rc.data.lotsQuarantined).toBeGreaterThanOrEqual(1);
    expect((await get(`/odata/v4/admin/Transfers(${t.ID})`, 'admin')).data).toMatchObject({ status: 'CANCELLED', declineReason: 'Lot flagged: RECALL' });
    // the flagged batch can never be offered again (rule 2)
    const again = await post('/odata/v4/requests/rank', { request: r.data.request }, 'asha');
    expect(again.data.exclusions.filter(e => e.batchNo === tl.batchNo).map(e => e.code)).toContain('FLAGGED_BATCH');
  });

  test('flag on an in-transit lot suggests quarantine on arrival and alerts both hospitals', async () => {
    const rc = await post('/odata/v4/trust/recall', { batchNo: 'NB24T044', manufacturer: 'Nandi Biologics (synthetic)', reason: 'NSQ' }, 'admin');
    expect(rc.data.inTransitAlerts).toBe(1);
    const t = (await get('/odata/v4/admin/Transfers(a0000000-0000-4000-8000-000000000001)', 'admin')).data;
    expect(t.quarantineSuggested).toBe(true);
    const n = (await get("/odata/v4/admin/Notifications?$filter=kind eq 'RECALL' and ref eq 'a0000000-0000-4000-8000-000000000001'", 'admin')).data.value;
    expect(n.map(x => x.hospital_ID).sort()).toEqual(['H2', 'H3']);
  });

  test('flags cannot be deleted, only deactivated', async () => {
    const f = (await get('/odata/v4/trust/Flags', 'admin')).data.value[0];
    expect((await T.axios.delete(`/odata/v4/trust/Flags(${f.ID})`, as('admin'))).status).toBe(405);
  });
});

describe('LLM-based CDSCO alert parser', () => {
  test('with LLM_PROVIDER=none parsing is refused with a clear code (manual entry still works)', async () => {
    const r = await post('/odata/v4/trust/parseAlert', { text: ALERT }, 'admin');
    expect(r.status).toBe(409);
    expect(r.data.error.code).toBe('LLM_DISABLED');
  });

  test('parses alert text into Flag rows; drops rows whose batch is not in the alert (hallucination guard)', async () => {
    llm.setClient(async () => JSON.stringify([
      { genericName: 'Carboplatin', strength: '450 mg/45 mL', batchNo: 'SOL24Z999', manufacturer: 'Sunrise Oncology Ltd (synthetic)', reason: 'Not of standard quality' },
      { genericName: 'Oxaliplatin', strength: '100 mg', batchNo: 'OX23Q404', manufacturer: 'Deccan Biogenerics (synthetic)', reason: 'Spurious' },
      { genericName: 'Cisplatin', batchNo: 'INVENTED123', manufacturer: 'Nobody', reason: 'SPURIOUS' },
    ]));
    const r = await post('/odata/v4/trust/parseAlert', { text: ALERT, source: 'CDSCO alert (synthetic sample)' }, 'admin');
    expect(r.status).toBe(200);
    expect(r.data.created).toBe(2);
    const flags = JSON.parse(r.data.flags);
    expect(flags.map(f => [f.batchNo, f.reason, f.drug_ID])).toEqual([['SOL24Z999', 'NSQ', 'D-CARB450'], ['OX23Q404', 'SPURIOUS', 'D-OXAL100']]);
    const imp = (await get('/audit/Entries?$orderby=seq', 'admin')).data.filter(e => e.action === 'FLAGS_IMPORTED').at(-1);
    expect(JSON.parse(imp.payload).dropped).toEqual(['INVENTED123']);
  });

  test('accepts the alert as a PDF', async () => {
    llm.setClient(async msgs => {
      expect(msgs[1].content).toMatch(/GEM99X01/); // text really came out of the PDF
      return '```json\n[{"genericName":"Gemcitabine","strength":"1 g","batchNo":"GEM99X01","manufacturer":"Medora Labs (synthetic)","reason":"RECALL"}]\n```';
    });
    const pdf = tinyPdf('SYNTHETIC CDSCO-style alert\n1 | Gemcitabine for Injection 1 g | GEM99X01 | Medora Labs (synthetic) | Recall');
    const r = await post('/odata/v4/trust/parseAlert', { pdfBase64: pdf.toString('base64') }, 'admin');
    expect(r.status).toBe(200);
    expect(r.data.created).toBe(1);
    expect((await get('/audit/verify', 'admin')).data.ok).toBe(true);
  });
});
