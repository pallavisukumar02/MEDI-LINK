'use strict';
/*
 * Agent runner: the one loop every MediLink agent uses (docs/AGENTS.md).
 *   "Agents propose, rules verify, humans approve."
 * The model sees a short list of narrow tools and answers with JSON only:
 *   {"tool": "<name>", "args": {...}}   -> MediLink runs that tool and returns the result as the next message
 *   {"final": {...}}                    -> the agent is done
 * Guardrails enforced here, not in the prompt:
 *   - only tools on the agent's own whitelist can run; every tool is read-only (writes happen through proposals a
 *     person approves, or through the existing actions with their own role checks)
 *   - a hard cap on steps (AGENT_MAX_STEPS), and every tool call is written to the hash-chained audit log
 *   - tool results carry counts only: no patient reference ever goes into a prompt
 * With the LLM off (LLM_PROVIDER=none) callers use their rules-only path; nothing here is required for MediLink to work.
 */
const cds = require('@sap/cds');
const llm = require('../llm');
const audit = require('../audit');
const config = require('../config');
const LOG = cds.log('agents');

const MAX_OBS = 4000; // characters of tool output fed back per step

function toolList(tools) {
  return Object.entries(tools).map(([name, t]) => `- ${name}(${Object.entries(t.args || {}).map(([k, v]) => `${k}: ${v}`).join(', ')}): ${t.description}`).join('\n');
}

function systemPrompt(role, tools, finalShape) {
  return [
    role,
    'You can call these read-only tools:',
    toolList(tools),
    'Reply with JSON only, one object per reply:',
    '  {"tool": "<name>", "args": {...}} to call a tool, or',
    `  {"final": ${finalShape}} when you are done.`,
    'Use only facts returned by the tools. Never invent a number, batch, hospital or date. If the tools do not answer the question, say so and ask one short clarifying question.',
  ].join('\n');
}

/**
 * Run the tool loop. Returns { final, trace, steps, mode } or null when the LLM is off or failed (caller falls back).
 * ctx is passed to every tool (hospitalId, viewer, runId).
 */
async function loop({ agent, role, tools, finalShape = '{"answer": "..."}', task, ctx, maxSteps = config.agentMaxSteps }) {
  if (!llm.enabled()) return null;
  const runId = ctx.runId || cds.utils.uuid();
  const messages = [{ role: 'system', content: systemPrompt(role, tools, finalShape) }, { role: 'user', content: task }];
  const trace = [];
  for (let step = 1; step <= maxSteps; step++) {
    let reply;
    try { reply = await llm.chat(messages, { maxTokens: 700 }); } catch (e) { LOG.warn(`${agent}: LLM call failed, using the rules path:`, e.message); return null; }
    const j = llm.extractJson(reply);
    if (!j) { LOG.info(`${agent}: reply was not JSON, using the rules path`); return null; }
    if (j.final !== undefined) return { final: j.final, trace, steps: step, mode: 'llm', runId };
    const name = String(j.tool || '');
    const tool = Object.hasOwn(tools, name) ? tools[name] : null;
    let obs;
    if (!tool) obs = { error: `Unknown tool "${name}". Use one of: ${Object.keys(tools).join(', ')}` };
    else {
      try { obs = await tool.run(j.args || {}, ctx); } catch (e) { obs = { error: e.message }; }
    }
    trace.push({ tool: name, args: j.args || {}, ok: !!tool && !obs?.error, result: obs });
    await audit.log(`agent:${agent}`, 'AGENT_TOOL', { run: runId, step, tool: name, args: j.args || {}, ok: !!tool && !obs?.error });
    messages.push({ role: 'assistant', content: JSON.stringify({ tool: name, args: j.args || {} }) });
    messages.push({ role: 'user', content: `Result of ${name}: ${JSON.stringify(obs).slice(0, MAX_OBS)}` });
  }
  LOG.info(`${agent}: step limit reached, using the rules path`);
  return null;
}

/** Store one run (what was asked, which path answered, how many tool calls) and add it to the audit chain. */
async function record({ runId = cds.utils.uuid(), agent, hospitalId, actor, mode, input, output, steps }) {
  const row = { ID: runId, agent, hospital_ID: hospitalId || null, actor, mode, input: String(input || '').slice(0, 1000), output: JSON.stringify(output ?? null), steps: steps || 0, createdAt: new Date().toISOString() };
  await INSERT.into('medilink.AgentRuns').entries(row);
  await audit.log(actor, 'AGENT_RUN', { run: runId, agent, hospital: hospitalId || null, mode, steps: row.steps });
  return runId;
}

// ---------- shared guards ----------
const NUM = /\d+(?:\.\d+)?/g;
/** True when every number in `text` also appears somewhere in the facts the tools returned (no invented figures). */
function numbersGrounded(text, facts) {
  const known = new Set((JSON.stringify(facts).match(NUM) || []).map(n => String(Number(n))));
  return (String(text || '').match(NUM) || []).every(n => known.has(String(Number(n))));
}

const enabled = () => config.agentsEnabled;

module.exports = { loop, record, numbersGrounded, systemPrompt, enabled };
