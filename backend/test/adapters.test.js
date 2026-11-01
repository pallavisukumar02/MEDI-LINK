'use strict';
/*
 * Adapters that need no SAP service:
 *   notify.js  SMTP email (nodemailer, fake transport) for shortfall / excursion / recall / licence / stale feed
 *   llm.js     LLM_PROVIDER=openai-compatible against a fake OpenAI-style server; the number/batch guards still apply
 *   scripts/env-check.js  plain-language report of missing variables, never a value
 */
require('./helpers/env')({ MATCHER_URL: 'http://localhost:1', MATCHER_FALLBACK_ENABLED: 'true' });
const http = require('http');
const path = require('path');
const cds = require('@sap/cds');
const T = cds.test(__dirname + '/..');
T.axios.defaults.validateStatus = () => true;
const config = require('../srv/lib/config');
const notify = require('../srv/lib/notify');
const llm = require('../srv/lib/llm');
const notes = require('../srv/lib/notes');

const COLD = 'a0000000-0000-4000-8000-000000000001';
const withEnv = async (env, fn) => {
  const old = Object.fromEntries(Object.keys(env).map(k => [k, process.env[k]]));
  Object.assign(process.env, env); config.reload();
  try { return await fn(); } finally { for (const [k, v] of Object.entries(old)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } config.reload(); }
};
const tick = () => new Promise(r => setTimeout(r, 50));

describe('SMTP alerts', () => {
  const SMTP = { SMTP_HOST: 'smtp.example.test', SMTP_PORT: '587', SMTP_USER: 'u', SMTP_PASS: 'p', ALERT_EMAIL_FROM: 'medilink@example.test', ALERT_EMAIL_TO: 'pharmacy@example.test' };
  let sent;
  beforeEach(() => { sent = []; notify.setMailer({ sendMail: async m => { sent.push(m); return { messageId: 'x' }; } }); });
  afterAll(() => notify.setMailer(undefined));

  test('the five paging events go out by email; others stay in the app', async () => {
    await withEnv(SMTP, async () => {
      expect(notify.channel()).toBe('smtp');
      for (const kind of ['SHORTFALL', 'EXCURSION', 'RECALL', 'LICENCE_EXPIRY', 'STALE_FEED', 'ROUTE', 'SUPPLY_REQUEST']) {
        await cds.tx(() => notify.notify({ hospital: 'H1', kind, severity: 'HIGH', message: `Synthetic ${kind} message` }));
      }
      await tick();
      expect(sent.map(m => m.subject)).toEqual([
        'MediLink: Medicine shortfall (H1)', 'MediLink: Temperature out of range (H1)', 'MediLink: Batch recall (H1)',
        'MediLink: Licence expiring (H1)', 'MediLink: Stock feed not updating (H1)',
      ]);
      // H1's staff have no email yet, so its alerts go to the hospital's admin email (routing: test/monitor.test.js)
      expect(sent[0]).toMatchObject({ from: 'medilink@example.test', to: 'admin.h1@example.org', text: expect.stringMatching(/^Synthetic SHORTFALL message[\s\S]*synthetic data/) });
      const rows = await cds.tx(() => SELECT.from('medilink.Notifications').where({ message: { like: 'Synthetic %' } }));
      expect(rows.length).toBe(7); // every alert is still in the app
      const h = (await T.axios.get('/health/integrations', { auth: { username: 'admin', password: 'demo' } })).data;
      expect(JSON.stringify(h)).not.toMatch(/"p"|smtp\.example\.test/); // no SMTP host or password in the report
    });
  });

  test('no recipient = no email, no crash; SMTP off = console; a failing server does not break the alert', async () => {
    await withEnv({ ...SMTP, ALERT_EMAIL_TO: '' }, async () => {
      await cds.tx(() => notify.notify({ hospital: null, kind: 'SHORTFALL', message: 'Synthetic no-recipient' }));
      await tick();
      expect(sent).toEqual([]);
    });
    await withEnv({ SMTP_HOST: '' }, async () => expect(notify.channel()).toBe('console'));
    notify.setMailer({ sendMail: async () => { throw new Error('connection refused'); } });
    await withEnv(SMTP, async () => {
      const row = await cds.tx(() => notify.notify({ hospital: 'H1', kind: 'RECALL', message: 'Synthetic failing server' }));
      expect(row.kind).toBe('RECALL');
    });
  });
});

describe('OpenAI-compatible LLM', () => {
  let server, port, seen, answer;
  beforeAll(async () => {
    server = http.createServer((req, res) => {
      let body = '';
      req.on('data', d => (body += d));
      req.on('end', () => {
        seen.push({ url: req.url, auth: req.headers.authorization, body: JSON.parse(body) });
        const a = answer(JSON.parse(body));
        res.writeHead(a.status || 200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(a.status ? { error: 'boom' } : { choices: [{ message: { role: 'assistant', content: a } }] }));
      });
    });
    await new Promise(r => server.listen(0, r));
    port = server.address().port;
  });
  afterAll(() => server.close());
  beforeEach(() => { seen = []; });
  const LLM = () => ({ LLM_PROVIDER: 'openai-compatible', LLM_BASE_URL: `http://localhost:${port}/v1/`, LLM_API_KEY: 'test-llm-key', LLM_MODEL: 'free-model-1' });

  test('chat goes to {LLM_BASE_URL}/chat/completions with the key and model', async () => {
    answer = () => 'hello';
    await withEnv(LLM(), async () => {
      expect(llm.enabled()).toBe(true);
      expect(await llm.chat([{ role: 'user', content: 'hi' }], { maxTokens: 10 })).toBe('hello');
    });
    expect(seen[0]).toEqual({ url: '/v1/chat/completions', auth: 'Bearer test-llm-key', body: { model: 'free-model-1', messages: [{ role: 'user', content: 'hi' }], max_tokens: 10, temperature: 0 } });
    await withEnv({ ...LLM(), LLM_MODEL: '' }, async () => expect(llm.enabled()).toBe(false));
  });

  test('transfer note: a rewrite that changes a number is discarded, a faithful one is used, an API error keeps the template', async () => {
    await withEnv(LLM(), async () => {
      answer = b => b.messages[1].content.replace(/\d+ vials/, '99 vials');
      const changed = await cds.tx(() => notes.writeTransferNote(COLD));
      expect(changed).not.toMatch(/99 vials/);
      answer = b => 'Please: ' + b.messages[1].content;
      expect(await cds.tx(() => notes.writeTransferNote(COLD))).toMatch(/^Please: Trastuzumab 440 mg/);
      answer = () => ({ status: 500 });
      expect(await cds.tx(() => notes.writeTransferNote(COLD))).toMatch(/^Trastuzumab 440 mg/);
    });
  });

  test('stock-register photo: rows whose batch is not in the transcription are dropped', async () => {
    answer = () => JSON.stringify({
      text: 'Carboplatin 450 mg/45 mL Injection Carbokem Batch PH24A777 Qty 5 Exp 03/2027',
      rows: [
        { generic: 'Carboplatin', strength: '450 mg/45 mL', form: 'Injection', brandName: 'Carbokem', batchNo: 'PH24A777', quantity: 5, expiryDate: '03/2027' },
        { generic: 'Carboplatin', strength: '450 mg/45 mL', form: 'Injection', batchNo: 'INVENTED1', quantity: 50, expiryDate: '01/2028' },
      ],
    });
    await withEnv(LLM(), async () => {
      const r = await T.axios.post('/me/actions/upload-photo', { imageBase64: Buffer.from('synthetic').toString('base64') }, { auth: { username: 'hari', password: 'demo' } });
      expect(r.status).toBe(200);
      expect(r.data.result.rows.map(x => x.batchNo)).toEqual(['PH24A777']);
      expect(r.data.result.dropped).toEqual(['INVENTED1']);
      const h = (await T.axios.get('/health/integrations', { auth: { username: 'admin', password: 'demo' } })).data;
      expect(h.items.find(i => i.mode === 'openai-compatible')).toMatchObject({ status: 'connected', text: expect.stringMatching(/free-model-1/) });
      expect(JSON.stringify(h)).not.toMatch(/test-llm-key/);
    });
  });
});

describe('npm run env:check', () => {
  const { report } = require(path.join(__dirname, '..', '..', 'scripts', 'env-check.js'));
  test('lists what is missing, in words, without values', () => {
    const r = report({ AUTH_JWT_SECRET: 'short', MEDISOFT_OAUTH_CLIENT_SECRET: 'change-me-random-32-chars', LLM_PROVIDER: 'aicore', SMTP_HOST: 'mail.example.test', APPROVAL_MODE: 'bpa' });
    expect(r.ok).toBe(false);
    for (const k of ['AUTH_JWT_SECRET', 'TOKEN_ENCRYPTION_KEY', 'DEMO_PASSWORD', 'MEDISOFT_OAUTH_CLIENT_SECRET']) expect(r.text).toMatch(new RegExp(`- ${k}: `));
    expect(r.text).toMatch(/LLM_PROVIDER is aicore but AICORE_MODEL_NAME is empty/);
    expect(r.text).toMatch(/APPROVAL_MODE is bpa but BPA_API_URL is empty/);
    expect(r.text).toMatch(/SMTP_HOST is set but ALERT_EMAIL_FROM is empty/);
    expect(r.text).not.toMatch(/short|mail\.example\.test/);
    const full = { AUTH_JWT_SECRET: 'a'.repeat(40), TOKEN_ENCRYPTION_KEY: 'b'.repeat(40), DEMO_PASSWORD: 'demo', PATIENT_REF_HASH_SALT: 's', MEDISOFT_OAUTH_CLIENT_SECRET: 'm', CONNECTOR_PAIRING_SECRET: 'c' };
    expect(report(full)).toMatchObject({ ok: true, text: expect.stringMatching(/^Checking for development/) });
    const prod = report({ ...full, NODE_ENV: 'production' }); // "demo" is fine on a laptop, not in production
    expect(prod.ok).toBe(false);
    expect(prod.text).toMatch(/- DEMO_PASSWORD: .*at least 8 characters in production/);
    expect(report({ ...full, NODE_ENV: 'production', DEMO_PASSWORD: 'long-demo-pass' }).ok).toBe(true);
  });
});
