'use strict';
/*
 * Agentic AI (srv/lib/agents, docs/AGENTS.md): agents propose, rules verify, humans approve.
 *   copilot     read-only questions; rules path with LLM_PROVIDER=none, LLM path keeps only grounded answers
 *   intake      pasted stock list -> validated rows, one clarifying question, nothing saved until confirmed
 *   planner     compliance re-runs the hard rules, critic checks donor cover / roads / partners, the LLM can never
 *               pick a plan that failed the rules
 *   watchtower  excursion / no open road -> proposal a person approves; incident report filed in the audit chain
 * The LLM is a fake injected with llm.setClient; no SAP credentials are used.
 */
require('./helpers/env')({ MATCHER_URL: 'http://localhost:1', MATCHER_FALLBACK_ENABLED: 'true' });
const cds = require('@sap/cds');
const T = cds.test(__dirname + '/..');
T.axios.defaults.validateStatus = () => true;
const llm = require('../srv/lib/llm');
const config = require('../srv/lib/config');
const ingestH1 = require('./helpers/h1');

const as = user => ({ auth: { username: user, password: 'demo' } });
const act = (user, id, body) => T.axios.post(`/me/actions/${id}`, body, as(user));
const home = async user => (await T.axios.get('/me/home', as(user))).data;
const ask = (user, question) => act(user, 'ask-copilot', { question });
const IN_TRANSIT = 'a0000000-0000-4000-8000-000000000001'; // synthetic seed: trastuzumab (cold) H2 -> H3, on the way
const HEX64 = /\b[0-9a-f]{64}\b/;
const audits = action => cds.tx(() => SELECT.from('medilink.AuditLog').where({ action }));
const mmyyyy = n => { const d = new Date(Date.now() + n * 86400000); return `${String(d.getUTCMonth() + 1).padStart(2, '0')}/${d.getUTCFullYear()}`; };

beforeAll(async () => { await ingestH1(); });
afterEach(() => llm.setClient(undefined));

describe('copilot (LLM off: rules path, same tools)', () => {
  test('which drugs will run short: answered from the cover engine, with source and confidence', async () => {
    const r = await ask('asha', 'Which drugs will run short in the next 14 days?');
    expect(r.status).toBe(200);
    expect(r.data.result).toMatchObject({ mode: 'rules', confidence: 'high', sources: [{ tool: 'cover_outlook', args: { days: 14 } }] });
    expect(r.data.message).toMatch(/Carboplatin 450 mg \(\d+ of \d+ booked doses short from/);
    expect(r.data.message).not.toMatch(HEX64); // counts only, never a patient reference
  });

  test('which lots expire this month / in 60 days', async () => {
    const r = await ask('asha', 'Which lots expire in the next 60 days?');
    expect(r.data.result.sources[0]).toEqual({ tool: 'expiring_lots', args: { days: 60 } });
    expect(r.data.message).toMatch(/batch|No batch expires/);
  });

  test('who can lend carboplatin within 15 km: the 8 hard rules run, flagged and unlicensed stock never offered', async () => {
    const r = await ask('asha', 'Who can lend carboplatin 450 mg within 15 km?');
    expect(r.data.result.sources[0]).toMatchObject({ tool: 'find_lenders', args: { maxKm: 15 } });
    expect(r.data.message).toMatch(/Banashankari Care Hospital \(\d+ vials, [\d.]+ km/);
    expect(r.data.message).not.toMatch(/Lakeside|Hebbal/); // flagged batch (Lakeside) and expired licence (Hebbal)
  });

  test('an unclear question gets one clarifying question, not a guess', async () => {
    const r = await ask('asha', 'hello');
    expect(r.data.result).toMatchObject({ confidence: 'low', question: expect.any(String) });
    const drug = await ask('asha', 'How much xyzumab do we have?');
    expect(drug.data.result.question).toMatch(/Which medicine/);
  });

  test('read-only, own hospital only, approvers may ask, admins and empty questions refused', async () => {
    expect((await ask('meera', 'What deliveries are on the way?')).status).toBe(200);
    expect((await ask('admin', 'Which drugs will run short?')).status).toBe(403);
    expect((await ask('asha', '')).data.code).toBe('INVALID_INPUT');
    const runs = await cds.tx(() => SELECT.from('medilink.AgentRuns').where({ agent: 'copilot' }));
    expect(runs.length).toBeGreaterThanOrEqual(5);
    expect((await audits('AGENT_RUN')).length).toBeGreaterThanOrEqual(5);
  });
});

describe('copilot (LLM on)', () => {
  test('the model plans tool calls; the grounded answer is used and every tool call is audited', async () => {
    const seen = [];
    let n = 0;
    llm.setClient(async msgs => {
      seen.push(JSON.stringify(msgs));
      if (n++ === 0) return '{"tool": "cover_outlook", "args": {"days": 10}}';
      const res = JSON.parse(msgs.at(-1).content.replace(/^Result of cover_outlook: /, ''));
      const c = res.short[0];
      return JSON.stringify({ final: { answer: `${c.drug} runs short by ${c.shortBy} doses.`, confidence: 'high' } });
    });
    const before = (await audits('AGENT_TOOL')).length;
    const r = await ask('asha', 'Which drugs will run short in the next 10 days?');
    expect(r.data.result).toMatchObject({ mode: 'llm', steps: 2, sources: [{ tool: 'cover_outlook', args: { days: 10 } }] });
    expect(r.data.message).toMatch(/^Carboplatin 450 mg runs short by \d+ doses\.$/);
    expect((await audits('AGENT_TOOL')).length).toBe(before + 1);
    expect(seen.join('')).not.toMatch(HEX64); // no patient reference ever reaches the prompt
  });

  test('an invented number is thrown away: the rules answer is shown instead', async () => {
    let n = 0;
    llm.setClient(async () => (n++ === 0 ? '{"tool": "cover_outlook", "args": {}}' : '{"final": {"answer": "Carboplatin runs short by 987654 doses."}}'));
    const r = await ask('asha', 'Which drugs will run short?');
    expect(r.data.result.mode).toBe('rules');
    expect(r.data.message).not.toMatch(/987654/);
  });

  test('unknown tools are refused and the step cap holds', async () => {
    llm.setClient(async () => '{"tool": "delete_everything", "args": {}}');
    const r = await ask('asha', 'Which lots expire this month?');
    expect(r.data.result.mode).toBe('rules'); // ran out of steps -> rules path
    const bad = (await audits('AGENT_TOOL')).filter(a => JSON.parse(a.payload).tool === 'delete_everything');
    expect(bad.length).toBe(config.agentMaxSteps);
    expect(bad.every(a => JSON.parse(a.payload).ok === false)).toBe(true);
  });
});

describe('intake helper (pasted stock list)', () => {
  const text = [
    'Stock as on today (ward 3)',
    `Carboplatin 450mg batch PX-91001 qty 12 exp ${mmyyyy(400)}`,
    `Paclitaxel 260 mg Lot PX91002 - 7 vials - Exp ${mmyyyy(300)}`,
    `Carboplatin batch PX91003 qty 4 exp ${mmyyyy(200)}`,
    `Cisplatin 50mg batch PX91004 qty 3 exp 01/2020`,
  ].join('\n');

  test('rules path: valid rows mapped to the master, one clarifying question, nothing saved until confirmed', async () => {
    const before = await cds.tx(() => SELECT.from('medilink.Lots').where({ hospital_ID: 'H4', batchNo: { like: 'PX%' } }));
    const r = await act('hari', 'intake-text', { stockText: text });
    expect(r.status).toBe(200);
    expect(r.data.result.mode).toBe('rules');
    expect(r.data.result.rows.map(x => [x.drugId, x.batchNo, x.quantity])).toEqual([['D-CARB450', 'PX-91001', 12], ['D-PACL260', 'PX91002', 7]]);
    expect(r.data.result.rejected.map(x => x.reason)).toEqual(['strength unclear', 'already expired on 2020-01-31']);
    expect(r.data.result.question).toBe('Which strength is batch PX91003 of Carboplatin: 450 mg/45 mL or 150 mg/15 mL?');
    expect(r.data.next.action).toMatchObject({ id: 'confirm-photo', body: { previewId: r.data.result.previewId } });
    expect(before.length).toBe(0);
    const c = await act('hari', 'confirm-photo', r.data.next.action.body);
    expect(c.data.result.saved).toBe(2);
    const after = await cds.tx(() => SELECT.from('medilink.Lots').where({ hospital_ID: 'H4', batchNo: { like: 'PX%' } }));
    expect(after.map(l => l.batchNo).sort()).toEqual(['PX-91001', 'PX91002']);
  });

  test('LLM path: a batch or quantity that is not in the pasted text is dropped', async () => {
    llm.setClient(async () => JSON.stringify({ rows: [
      { generic: 'Gemcitabine', strength: '1 g', batchNo: 'GEMQ7781', quantity: 5, expiry: mmyyyy(500) },
      { generic: 'Gemcitabine', strength: '1 g', batchNo: 'INVENTED1', quantity: 50, expiry: mmyyyy(500) },
    ] }));
    const r = await act('hari', 'intake-text', { stockText: `gemcitabine 1g, GEMQ7781, five vials (5), expires ${mmyyyy(500)}` });
    expect(r.data.result.mode).toBe('llm');
    expect(r.data.result.rows.map(x => x.batchNo)).toEqual(['GEMQ7781']);
    expect(r.data.result.rejected).toEqual([{ batchNo: 'INVENTED1', line: null, reason: 'batch not found in what you pasted' }]);
  });
});

describe('plan review (planner + compliance + critic)', () => {
  let requestId;
  beforeAll(async () => {
    const h = await home('asha');
    const card = h.tasks.find(t => t.kind === 'send_request' && t.primaryAction.body.drugId === 'D-CARB450');
    const sent = await act('asha', 'send-request', card.primaryAction.body);
    expect(sent.status).toBe(200);
    requestId = sent.data.journey.id;
  });

  test('the choose-supplier task offers "Check plans with AI"; existing buttons unchanged', async () => {
    const card = (await home('asha')).tasks.find(t => t.kind === 'choose_plan');
    expect(card.agentAction).toMatchObject({ id: 'review-plans', body: { requestId } });
    expect(card.secondaryAction.id).toBe('cancel-request');
  });

  test('rules path: every plan re-checked against the 8 rules, critic notes, why-this-plan, ends in the usual Ask button', async () => {
    const r = await act('asha', 'review-plans', { requestId });
    expect(r.status).toBe(200);
    const rev = r.data.result;
    expect(rev.mode).toBe('rules');
    expect(rev.plans.length).toBeGreaterThan(0);
    expect(rev.plans.every(p => p.verified)).toBe(true);
    expect(rev.recommended).toBe(1);
    expect(rev.explanation).toMatch(/^Plan 1 is recommended: \d+ from Banashankari Care Hospital/);
    expect(rev.explanation).toMatch(/passed all 8 safety rules again/);
    expect(r.data.next).toMatchObject({ type: 'review', action: { id: 'choose-plan', body: { requestId, plan: 1 } } });
    const tools = (await audits('AGENT_TOOL')).map(a => JSON.parse(a.payload)).filter(p => p.request === requestId).map(p => p.tool);
    expect(tools).toEqual(['compliance.hard_rules', 'critic.checks']);
  });

  test('LLM on: a pick that is not a verified plan is overridden; the pharmacist still chooses', async () => {
    llm.setClient(async () => '{"recommend": 7, "why": "Plan 7 is best."}');
    const r = await act('asha', 'review-plans', { requestId });
    expect(r.data.result.recommended).toBe(1);
    expect(r.data.result.explanation).toMatch(/The AI suggested plan 7, which did not pass the safety checks; MediLink picked plan 1 instead\./);
    const req = await cds.tx(() => SELECT.one.from('medilink.Requests').where({ ID: requestId }));
    expect(req.status).toBe('MATCHED'); // the review never asks a supplier by itself
  });

  test('LLM on: a grounded explanation for a verified plan is used', async () => {
    llm.setClient(async msgs => {
      const f = JSON.parse(msgs[1].content);
      const p = f.plans[0];
      return JSON.stringify({ recommend: p.rank, why: `Plan ${p.rank} brings ${p.totalQty} vials from ${p.legs[0].hospital}.` });
    });
    const r = await act('asha', 'review-plans', { requestId });
    expect(r.data.result).toMatchObject({ mode: 'llm', recommended: 1 });
    expect(r.data.result.explanation).toMatch(/^Plan 1 brings \d+ vials from Banashankari Care Hospital\.$/);
  });

  test('only the requesting hospital can review its plans', async () => {
    expect((await act('ravi', 'review-plans', { requestId })).data.code).toBe('REQUEST_NOT_FOUND');
  });
});

describe('logistics watchtower', () => {
  const telemetry = temperatureC => cds.tx({ user: cds.User.privileged }, () => require('../srv/lib/delivery').telemetry({ transfer: IN_TRANSIT, lat: 12.95, long: 77.62, temperatureC }, 'test:logger'));

  test('temperature excursion -> hold-for-QA proposal with a drafted incident report; approval files it and tells both sides', async () => {
    const r = await telemetry(14.5);
    expect(r.excursion).toBe(true);
    await telemetry(15); // a second bad reading does not raise a second proposal
    const h = await home('lata');
    const cards = h.tasks.filter(t => t.kind === 'agent_proposal');
    expect(cards).toHaveLength(1);
    const card = cards[0];
    expect(card).toMatchObject({ agent: 'watchtower', proposalKind: 'HOLD_FOR_QA', urgency: 'high', colour: 'red', primaryAction: { id: 'approve-proposal' }, secondaryAction: { id: 'reject-proposal' } });
    expect(card.subtitle).toMatch(/14\.5 °C \(allowed 2-8 °C\)/);
    expect(card.report).toMatch(/^Incident report \(draft\)\. Shipment of Trastuzumab 440 mg, 2 vials, from Sanjeevani Hospital to Lakeside Oncology Centre/);
    expect((await home('ravi')).tasks.some(t => t.kind === 'agent_proposal')).toBe(false); // another hospital sees nothing

    expect((await act('ravi', 'approve-proposal', card.primaryAction.body)).data.code).toBe('PROPOSAL_NOT_FOUND');
    const ok = await act('lata', 'approve-proposal', card.primaryAction.body);
    expect(ok.status).toBe(200);
    expect(ok.data.message).toMatch(/Incident report filed/);
    expect((await act('lata', 'approve-proposal', card.primaryAction.body)).data.code).toBe('PROPOSAL_DECIDED');
    const filed = (await audits('INCIDENT_REPORT')).map(a => JSON.parse(a.payload));
    expect(filed).toEqual([expect.objectContaining({ transfer: IN_TRANSIT, report: card.report })]);
    const notes = await cds.tx(() => SELECT.from('medilink.Notifications').where({ kind: 'INCIDENT' }));
    expect(notes.map(n => n.hospital_ID).sort()).toEqual(['H2', 'H3']);
    expect((await audit()).ok).toBe(true);
  });

  test('no open road -> re-check proposal; approving runs the existing re-plan as the pharmacist', async () => {
    const wt = require('../srv/lib/agents/watchtower');
    const p = await cds.tx(() => wt.onReplan(IN_TRANSIT, { open: false, etaMin: 0, note: 'No open route' }));
    expect(p).toMatchObject({ kind: 'REROUTE_CHECK', actionId: 'agent-recheck-route', hospital_ID: 'H3' });
    const card = (await home('lata')).tasks.find(t => t.proposalKind === 'REROUTE_CHECK');
    const before = (await audits('ROUTE_REPLANNED')).length;
    const ok = await act('lata', 'approve-proposal', card.primaryAction.body);
    expect(ok.status).toBe(200);
    expect(ok.data.message).toMatch(/A road is open again|Still no open road/);
    expect((await audits('ROUTE_REPLANNED')).length).toBe(before + 1);
    const decided = (await audits('AGENT_PROPOSAL_APPROVED')).map(a => JSON.parse(a.payload));
    expect(decided.at(-1)).toMatchObject({ kind: 'REROUTE_CHECK', actionId: 'agent-recheck-route' });
  });

  test('dismissing changes nothing; AGENTS_ENABLED=false turns every agent off and the old flow stays', async () => {
    const wt = require('../srv/lib/agents/watchtower');
    const p = await cds.tx(() => wt.onReplan(IN_TRANSIT, { open: true, etaMin: 999, note: 'Route open; new ETA misses the needed-by date' }));
    const rej = await act('lata', 'reject-proposal', { proposalId: p.ID });
    expect(rej.data.message).toBe('Dismissed. Nothing was changed.');
    process.env.AGENTS_ENABLED = 'false'; config.reload();
    try {
      expect(await cds.tx(() => wt.onReplan(IN_TRANSIT, { open: false, etaMin: 0, note: 'x' }))).toBeNull();
      const card = (await home('asha')).tasks.find(t => t.kind === 'choose_plan');
      expect(card.agentAction).toBeUndefined();
    } finally { delete process.env.AGENTS_ENABLED; config.reload(); }
  });

  test('agent activity lists runs and proposals for my hospital only', async () => {
    const a = (await T.axios.get('/me/agents', as('lata'))).data;
    expect(a).toMatchObject({ llm: false, agentsEnabled: true });
    expect(a.proposals.map(p => p.status).sort()).toEqual(['APPROVED', 'APPROVED', 'REJECTED']);
    expect(a.runs.every(r => ['watchtower', 'copilot', 'planner', 'intake'].includes(r.agent))).toBe(true);
    const other = (await T.axios.get('/me/agents', as('ravi'))).data;
    expect(other.proposals).toEqual([]);
  });
});

const audit = () => cds.tx(() => require('../srv/lib/audit').verify());
