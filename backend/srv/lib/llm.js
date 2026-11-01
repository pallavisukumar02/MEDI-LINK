'use strict';
/*
 * Optional LLM (SAP AI Core generative AI hub). Everything in MediLink works with LLM_PROVIDER=none.
 * The LLM never decides a match or overrides a hard rule; it only parses documents and writes text.
 */
const cds = require('@sap/cds');
const fs = require('fs');
const path = require('path');
const config = require('./config');
const http = require('./http');
const LOG = cds.log('llm');

let override; // tests can inject a fake: llm.setClient(async (messages) => '...')
function setClient(fn) { override = fn; }

function aicoreKey() {
  const bound = cds.env.requires?.aicore?.credentials;
  if (bound) return bound;
  const p = path.resolve(__dirname, '../..', config.aicoreKeyPath);
  if (fs.existsSync(p)) { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; } }
  return null;
}
function enabled() {
  if (override) return true;
  return config.llmProvider === 'aicore' && !!aicoreKey() && !!config.aicoreModel;
}

let tok, deploymentUrl;
async function aicoreToken(k) {
  if (tok && tok.exp > Date.now() + 30000) return tok.v;
  const res = await http.request(`${k.url}/oauth/token`, {
    method: 'POST', headers: { Authorization: 'Basic ' + Buffer.from(`${k.clientid}:${k.clientsecret}`).toString('base64'), 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'grant_type=client_credentials',
  });
  if (res.status !== 200) throw new Error('AI Core token failed: ' + res.status);
  tok = { v: res.json.access_token, exp: Date.now() + (res.json.expires_in || 3600) * 1000 };
  return tok.v;
}
async function findDeployment(k, t) {
  if (deploymentUrl) return deploymentUrl;
  const base = k.serviceurls?.AI_API_URL;
  const res = await http.request(`${base}/v2/lm/deployments?status=RUNNING`, { headers: { Authorization: 'Bearer ' + t, 'AI-Resource-Group': config.aicoreResourceGroup } });
  if (res.status !== 200) throw new Error('AI Core deployments failed: ' + res.status);
  const d = (res.json.resources || []).find(r => JSON.stringify(r.details || {}).includes(config.aicoreModel));
  if (!d) throw new Error(`No RUNNING deployment for model ${config.aicoreModel} in resource group ${config.aicoreResourceGroup}`);
  deploymentUrl = d.deploymentUrl;
  return deploymentUrl;
}

/** messages: [{role, content}] -> string */
async function chat(messages, { maxTokens = 800, temperature = 0 } = {}) {
  if (override) return override(messages);
  if (!enabled()) return null;
  const k = aicoreKey();
  const t = await aicoreToken(k);
  const url = await findDeployment(k, t);
  const res = await http.request(`${url}/chat/completions?api-version=2024-02-01`, {
    method: 'POST', headers: { Authorization: 'Bearer ' + t, 'AI-Resource-Group': config.aicoreResourceGroup, 'Content-Type': 'application/json' },
    body: JSON.stringify({ messages, max_tokens: maxTokens, temperature }), timeoutMs: 30000,
  });
  if (res.status !== 200) throw new Error('AI Core chat failed: ' + res.status);
  return res.json.choices?.[0]?.message?.content ?? null;
}

/** Extract the first JSON value from an LLM reply. */
function extractJson(s) {
  if (!s) return null;
  const m = s.match(/```(?:json)?\s*([\s\S]*?)```/);
  const body = m ? m[1] : s;
  const start = body.search(/[[{]/);
  if (start < 0) return null;
  try { return JSON.parse(body.slice(start)); } catch {
    const end = Math.max(body.lastIndexOf(']'), body.lastIndexOf('}'));
    try { return JSON.parse(body.slice(start, end + 1)); } catch { return null; }
  }
}

async function safeChat(messages, opts) {
  try { return await chat(messages, opts); } catch (e) { LOG.warn('LLM call failed, continuing without it:', e.message); return null; }
}

module.exports = { enabled, chat, safeChat, extractJson, setClient };
