'use strict';
/*
 * B2: stock-register photo (preview -> confirm, batch-visibility guard, LLM off = LLM_DISABLED) and transfer notes
 *     (template; an LLM rewrite is used only if it keeps every number and batch code).
 * B4: GET /health/integrations in plain words; APPROVAL_MODE=bpa and LLM_PROVIDER=aicore with missing config
 *     report "misconfigured" while MediLink keeps working on its fallbacks.
 * The LLM is a fake injected with llm.setClient; no SAP credentials are used.
 */
require('./helpers/env')({ MATCHER_URL: 'http://localhost:1', MATCHER_FALLBACK_ENABLED: 'true' });
const cds = require('@sap/cds');
const T = cds.test(__dirname + '/..');
T.axios.defaults.validateStatus = () => true;
const llm = require('../srv/lib/llm');
const config = require('../srv/lib/config');
const notes = require('../srv/lib/notes');
const ingestH1 = require('./helpers/h1');

const as = user => ({ auth: { username: user, password: 'demo' } });
const act = (user, id, body) => T.axios.post(`/me/actions/${id}`, body, as(user));
const sheetLots = () => cds.tx(() => SELECT.from('medilink.Lots').where({ hospital_ID: 'H4', source: 'SHEET' }));
const COLD = 'a0000000-0000-4000-8000-000000000001';
const IMG = Buffer.from('synthetic image bytes').toString('base64');
const withEnv = async (env, fn) => {
  const old = Object.fromEntries(Object.keys(env).map(k => [k, process.env[k]]));
  Object.assign(process.env, env); config.reload();
  try { return await fn(); } finally { for (const [k, v] of Object.entries(old)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } config.reload(); }
};
afterEach(() => llm.setClient(undefined));

describe('stock-register photo', () => {
  test('LLM off: a clear "switched off" message, sheet upload suggested', async () => {
    const r = await act('hari', 'upload-photo', { imageBase64: IMG });
    expect(r.status).toBe(409);
    expect(r.data).toEqual({ code: 'LLM_DISABLED', title: 'Reading documents is switched off', message: expect.stringMatching(/needs the AI service/), fix: expect.stringMatching(/Upload your stock sheet instead/), retryable: false });
  });

  test('preview keeps only rows whose batch is visible in the transcription; nothing saved until confirmed', async () => {
    let seen;
    llm.setClient(async msgs => {
      seen = msgs;
      return JSON.stringify({
        text: 'STOCK REGISTER  Carboplatin 450 mg/45 mL Injection  Carbokem  Batch PH24A001  Qty 18  Exp 03/2027',
        rows: [
          { generic: 'Carboplatin', strength: '450 mg/45 mL', form: 'Injection', brandName: 'Carbokem', batchNo: 'PH24A001', quantity: 18, expiryDate: '03/2027', sealed: 'Y' },
          { generic: 'Carboplatin', strength: '450 mg/45 mL', form: 'Injection', batchNo: 'FAKE999', quantity: 50, expiryDate: '01/2028' }, // invented by the model
        ],
      });
    });
    const before = await sheetLots();
    const r = await act('hari', 'upload-photo', { imageBase64: IMG, mimeType: 'image/png' });
    expect(r.status).toBe(200);
    expect(seen[1].content[1].image_url.url).toBe(`data:image/png;base64,${IMG}`); // the photo really went to the model
    expect(r.data.message).toBe('We read 1 rows from your photo. Check them, then save.');
    expect(r.data.result.rows.map(x => x.batchNo)).toEqual(['PH24A001']);
    expect(r.data.result.dropped).toEqual(['FAKE999']);
    expect(r.data.next.action).toMatchObject({ id: 'confirm-photo', body: { previewId: r.data.result.previewId } });
    expect((await sheetLots()).length).toBe(before.length); // preview saves nothing

    const c = await act('hari', 'confirm-photo', r.data.next.action.body);
    expect(c.status).toBe(200);
    expect(c.data.message).toBe('Saved 1 stock rows from your photo.');
    const after = await sheetLots();
    expect(after.map(l => [l.batchNo, l.quantity, l.expiryDate])).toEqual([['PH24A001', 18, '2027-03-31']]);
    const twice = await act('hari', 'confirm-photo', r.data.next.action.body);
    expect(twice.data).toMatchObject({ code: 'PREVIEW_NOT_FOUND', title: 'This preview has expired' });
    const other = await act('asha', 'confirm-photo', r.data.next.action.body); // another hospital's preview
    expect(other.data.code).toBe('PREVIEW_NOT_FOUND');
  });

  test('a photo with no readable batch is refused in plain words', async () => {
    llm.setClient(async () => '{"text":"blurry","rows":[{"batchNo":"ZZ1"}]}');
    const r = await act('hari', 'upload-photo', { imageBase64: IMG });
    expect(r.data).toMatchObject({ code: 'PHOTO_NOTHING_READABLE', title: 'No stock rows found' });
  });
});

describe('transfer notes', () => {
  test('factsPreserved: same numbers and batch codes, or the rewrite is rejected', () => {
    const base = 'Carboplatin 450 mg/45 mL injection: 16 vials (batch SOL24B077 x 12, SOL25A015 x 4). Keep between 2 and 30 °C.';
    expect(notes.factsPreserved(base, 'Please carry 16 vials of Carboplatin 450 mg/45 mL (batch SOL24B077 x 12, SOL25A015 x 4), kept between 2 and 30 °C.')).toBe(true);
    expect(notes.factsPreserved(base, 'Carry 17 vials of Carboplatin 450 mg/45 mL (SOL24B077 x 12, SOL25A015 x 4), 2 to 30 °C.')).toBe(false);
    expect(notes.factsPreserved(base, 'Carry 16 vials of Carboplatin 450 mg/45 mL (SOL24B078 x 12, SOL25A015 x 4), 2 to 30 °C.')).toBe(false);
    expect(notes.factsPreserved(base, 'Carry Carboplatin carefully.')).toBe(false);
  });

  test('template when the LLM is off; LLM wording only when it keeps the facts', async () => {
    const tpl = await cds.tx(() => notes.writeTransferNote(COLD));
    expect(tpl).toBe('Trastuzumab 440 mg powder for injection: 2 vials (batch NB24T044 x 2). Keep cold at 2 to 8 °C; do not freeze; keep the logger with the box. Cancer medicine: keep sealed and upright, do not open, hand over to the pharmacist only. From Sanjeevani Hospital to Lakeside Oncology Centre.');
    llm.setClient(async msgs => msgs[1].content.replace('2 vials', '3 vials'));          // changes a quantity
    expect(await cds.tx(() => notes.writeTransferNote(COLD))).toBe(tpl);
    const friendly = 'Hi! Please bring Trastuzumab 440 mg powder for injection, 2 vials (batch NB24T044 x 2). Keep cold at 2 to 8 °C, never frozen, logger stays with the box. Sealed, upright, unopened; hand to the pharmacist. Sanjeevani Hospital to Lakeside Oncology Centre.';
    llm.setClient(async () => friendly);
    expect(await cds.tx(() => notes.writeTransferNote(COLD))).toBe(friendly);
  });
});

describe('integration switches and GET /health/integrations', () => {
  const item = (r, name) => r.data.items.find(i => i.service === name);

  test('development: every SAP service reported in plain words, admin only', async () => {
    expect((await T.axios.get('/health/integrations', as('asha'))).status).toBe(403);
    const r = await T.axios.get('/health/integrations', as('admin'));
    expect(r.status).toBe(200);
    expect(r.data.summary).toMatch(/^\d+ connected, \d+ on fallback, \d+ needs? attention\.$/);
    expect(item(r, 'SAP HANA Cloud')).toMatchObject({ status: 'fallback', text: expect.stringMatching(/SQLite/) });
    expect(item(r, 'HANA spatial distances')).toMatchObject({ status: 'fallback', mode: 'haversine' });
    expect(item(r, 'SAP XSUAA (login and roles)').status).toBe('fallback');
    expect(item(r, 'SAP Build Process Automation')).toMatchObject({ status: 'fallback', mode: 'cap' });
    expect(item(r, 'SAP AI Core (generative AI hub)')).toMatchObject({ status: 'fallback', mode: 'none' });
    expect(item(r, 'SAP Destination service').status).toBe('fallback');
    expect(item(r, 'OR-Tools ranking service')).toMatchObject({ status: 'fallback', mode: 'greedy' });
    expect(JSON.stringify(r.data)).not.toMatch(/test-client-secret|test-pairing-secret|test-salt|test-token-store-key/); // values only, never secrets
  });

  test('APPROVAL_MODE=bpa without BPA settings: misconfigured, but requests and approvals still work', async () => {
    await ingestH1();
    await withEnv({ APPROVAL_MODE: 'bpa' }, async () => {
      const r = await T.axios.get('/health/integrations', as('admin'));
      expect(item(r, 'SAP Build Process Automation')).toMatchObject({ status: 'misconfigured', text: expect.stringMatching(/BPA_API_URL.*missing.*keeps approving/) });
      const home = (await T.axios.get('/me/home', as('asha'))).data;
      const sent = await T.axios.post('/me/actions/send-request', home.tasks.find(t => t.kind === 'send_request').primaryAction.body, as('asha'));
      const chosen = await T.axios.post('/me/actions/choose-plan', sent.data.journey.actions.find(a => a.id === 'choose-plan').body, as('asha'));
      expect(chosen.data.journey.stage).toBe(3);                // BPA start failed quietly; CAP flow carries on
      const card = (await T.axios.get('/me/home', as('ravi'))).data.tasks.find(t => t.kind === 'accept_request');
      const acc = await T.axios.post('/me/actions/accept-request', { ...card.primaryAction.body, repaymentMode: 'IN_KIND' }, as('ravi'));
      expect(acc.data.journey.stage).toBe(4);
    });
  });

  test('LLM_PROVIDER=aicore without key or model: misconfigured, and every LLM feature falls back', async () => {
    await withEnv({ LLM_PROVIDER: 'aicore', AICORE_MODEL_NAME: '', AICORE_SERVICE_KEY_PATH: './no-such-key.json' }, async () => {
      expect(llm.enabled()).toBe(false);
      const r = await T.axios.get('/health/integrations', as('admin'));
      expect(item(r, 'SAP AI Core (generative AI hub)')).toMatchObject({ status: 'misconfigured', text: expect.stringMatching(/AICORE_MODEL_NAME.*missing.*keeps working/) });
      expect((await act('hari', 'upload-photo', { imageBase64: IMG })).data.code).toBe('LLM_DISABLED');
      expect(await cds.tx(() => notes.writeTransferNote(COLD))).toMatch(/^Trastuzumab 440 mg/);
    });
  });
});
