'use strict';
/*
 * Pharmacist copilot (Agentic AI step 7): plain-language questions over the hospital's own data, read-only.
 *   "Which drugs will run short in the next 10 days?"   -> cover_outlook
 *   "Which lots expire this month?"                       -> expiring_lots
 *   "Who can lend carboplatin within 15 km?"              -> find_lenders (the 8 hard rules run, as for a real request)
 * LLM on: the model plans which tools to call (runner.loop) and writes the answer; the answer is kept only if every
 *         number in it comes from a tool result, otherwise the rules answer is shown instead.
 * LLM off: a small intent router calls the same tools and writes the answer from a template. Same data, same tools.
 * Every answer says where it came from (sources) and how sure it is; nothing is ever written to stock.
 */
const runner = require('./runner');
const { TOOLS, pick, findDrugs, MAX_DAYS } = require('./tools');
const coverdb = require('../coverdb');

const err = (status, code, message) => Object.assign(new Error(`${code}: ${message}`), { status, code });
const COPILOT_TOOLS = pick('cover_outlook', 'expiring_lots', 'find_lenders', 'stock_of', 'open_deliveries');
const ROLE = 'You are the MediLink pharmacy copilot for one hospital pharmacy in India. You answer questions about its cancer-medicine stock, expiry, cover and deliveries, using the tools. Answer in two to four short sentences of plain English. You cannot change anything.';
const EXAMPLES = ['Which drugs will run short in the next 10 days?', 'Which lots expire this month?', 'Who can lend carboplatin within 15 km?', 'How much paclitaxel do we have?', 'Where are my deliveries?'];

// ---------------------------------------------------------------- rules-only path
function daysIn(q, dflt) {
  const m = q.match(/(\d+)\s*(day|days|week|weeks|month|months)\b/);
  if (m) return Math.min(MAX_DAYS, Number(m[1]) * (m[2].startsWith('week') ? 7 : m[2].startsWith('month') ? 30 : 1));
  if (/this month/.test(q)) { const t = new Date(); return Math.max(1, new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth() + 1, 0)).getUTCDate() - t.getUTCDate()); }
  if (/next month/.test(q)) return 60;
  if (/this week|next week|7 days/.test(q)) return 7;
  if (/today|tomorrow/.test(q)) return 1;
  return dflt;
}

function intentOf(q) {
  if (/expir|expiring|go(es)? bad|use first/.test(q)) return 'expiring_lots';
  if (/lend|borrow|who (has|can|could)|nearby|near by|within \d+\s*km|nearest|other hospital/.test(q)) return 'find_lenders';
  if (/short|run out|running out|run low|shortfall|cover|enough/.test(q)) return 'cover_outlook';
  if (/deliver|shipment|courier|on the way|transit|arriv|eta\b/.test(q)) return 'open_deliveries';
  if (/stock|how many|how much|do we have|left of|on hand/.test(q)) return 'stock_of';
  return null;
}

const list = xs => (xs.length > 1 ? `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}` : xs[0] || '');
const fmtDate = d => new Date(String(d).slice(0, 10) + 'T00:00:00Z').toLocaleDateString('en-IN', { day: 'numeric', month: 'short', timeZone: 'UTC' });

function write(intent, r) {
  switch (intent) {
    case 'cover_outlook':
      if (!r.short.length) return `Nothing runs short in the next ${r.days} days.${r.belowSafetyMargin.length ? ` ${list(r.belowSafetyMargin.map(x => x.drug))} ${r.belowSafetyMargin.length === 1 ? 'is' : 'are'} covered but below the safety margin.` : ''}`;
      return `${r.short.length} medicine${r.short.length === 1 ? '' : 's'} run${r.short.length === 1 ? 's' : ''} short in the next ${r.days} days: `
        + r.short.map(x => `${x.drug} (${x.shortBy} of ${x.booked} booked doses short from ${fmtDate(x.firstShortOn)})`).join('; ') + '. Open the shortfall on your home screen to request it.';
    case 'expiring_lots':
      if (!r.lots.length) return `No batch expires in the next ${r.days} days.`;
      return `${r.lots.length} batch${r.lots.length === 1 ? '' : 'es'} expire${r.lots.length === 1 ? 's' : ''} in the next ${r.days} days: `
        + r.lots.slice(0, 6).map(l => `${l.drug} batch ${l.batchNo}, ${l.quantity} left, expires ${fmtDate(l.expiryDate)}${l.canOfferAsSurplus ? ` (${l.canOfferAsSurplus} could be offered as surplus)` : ''}`).join('; ') + '.';
    case 'find_lenders':
      if (r.error) return r.error + '.';
      if (!r.lenders.length) return `No hospital within ${r.maxKm} km can lend ${r.drug} right now after the safety checks.`;
      return `${r.lenders.length} hospital${r.lenders.length === 1 ? '' : 's'} within ${r.maxKm} km can lend ${r.drug} after the safety checks: `
        + r.lenders.map(l => `${l.hospital} (${l.canLend} vials, ${l.distanceKm} km, about ${l.etaMin} min)`).join('; ') + '. Send a request to ask them.';
    case 'stock_of':
      if (r.error) return r.error + '.';
      return `You have ${r.totalUsable} usable ${r.drug} in ${r.batches.length} batch${r.batches.length === 1 ? '' : 'es'}${r.batches.length ? ': ' + r.batches.slice(0, 5).map(b => `${b.batchNo} x ${b.quantity}${b.quarantined ? ' (quarantined)' : ''}`).join(', ') : ''}.`;
    case 'open_deliveries':
      if (!r.deliveries.length) return 'No delivery to or from your hospital is open right now.';
      return r.deliveries.map(d => `${d.drug} x ${d.qty} ${d.direction === 'incoming' ? 'from' : 'to'} ${d.other}: ${d.status}${d.temperatureProblem ? ', temperature problem' : ''}${d.roadClosed ? ', road closed on the way' : ''}`).join('; ') + '.';
    default: return '';
  }
}

async function rulesAnswer(question, ctx) {
  const q = question.toLowerCase();
  const intent = intentOf(q);
  if (!intent) return { answer: `I can answer questions about your stock, expiry, cover and deliveries. Try: "${EXAMPLES.slice(0, 3).join('", "')}".`, sources: [], confidence: 'low', question: 'Which of these would you like to know?' };
  const args = {};
  if (intent === 'cover_outlook') args.days = daysIn(q, 14);
  if (intent === 'expiring_lots') args.days = daysIn(q, 30);
  if (intent === 'find_lenders' || intent === 'stock_of') {
    const drugs = await findDrugs(q);
    if (!drugs.length) return { answer: 'Which medicine do you mean?', sources: [], confidence: 'low', question: 'Which medicine do you mean? For example "carboplatin 450".' };
    args.drug = q.match(/(\d+(?:\.\d+)?)\s*(mg|g|ml)\b/) ? `${drugs[0].genericName} ${q.match(/(\d+(?:\.\d+)?)\s*(mg|g|ml)\b/)[0]}` : drugs[0].genericName;
    const km = q.match(/(\d+(?:\.\d+)?)\s*km/); if (km) args.maxKm = Number(km[1]);
  }
  const result = await TOOLS[intent].run(args, ctx);
  return { answer: write(intent, result), sources: [{ tool: intent, args }], data: result, confidence: 'high' };
}

// ---------------------------------------------------------------- entry point
async function ask(viewer, question, actor) {
  const q = String(question || '').trim().slice(0, 500);
  if (!q) throw err(400, 'COPILOT_EMPTY', 'Type a question');
  if (!viewer.hospitalId) throw err(409, 'COPILOT_NO_HOSPITAL', 'The copilot answers for one hospital');
  const ctx = { hospitalId: viewer.hospitalId, viewer };
  let out = null;
  if (runner.enabled()) {
    const r = await runner.loop({ agent: 'copilot', role: ROLE, tools: COPILOT_TOOLS, finalShape: '{"answer": "...", "confidence": "high|low"}', task: `Today is ${coverdb.today()}. Question: ${q}`, ctx });
    if (r) {
      const answer = String(r.final?.answer || '').trim();
      const facts = r.trace.map(s => s.result);
      // the answer must be built from what the tools returned: an invented figure sends us back to the rules answer
      if (answer && r.trace.length && runner.numbersGrounded(answer, [facts, q])) {
        out = { answer, sources: r.trace.filter(s => s.ok).map(s => ({ tool: s.tool, args: s.args })), confidence: r.final?.confidence === 'low' ? 'low' : 'high', mode: 'llm', steps: r.steps, runId: r.runId };
      } else if (answer && !r.trace.length && /\?\s*$/.test(answer)) {
        out = { answer, sources: [], confidence: 'low', question: answer, mode: 'llm', steps: r.steps, runId: r.runId }; // a clarifying question
      }
    }
  }
  if (!out) out = { ...(await rulesAnswer(q, ctx)), mode: 'rules', steps: 1 };
  const { data, ...stored } = out;
  out.runId = await runner.record({ runId: out.runId, agent: 'copilot', hospitalId: viewer.hospitalId, actor, mode: out.mode, input: q, output: stored, steps: out.steps });
  out.examples = EXAMPLES;
  return out;
}

module.exports = { ask, rulesAnswer, intentOf, daysIn, EXAMPLES };
