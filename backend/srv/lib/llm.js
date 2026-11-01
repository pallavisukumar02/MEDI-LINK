'use strict';
/*
 * Optional LLM, one adapter for every provider. Everything in MediLink works with LLM_PROVIDER=none.
 *   aicore            SAP AI Core generative AI hub (BTP profiles only)
 *   openai-compatible any OpenAI-style POST {LLM_BASE_URL}/chat/completions (LLM_API_KEY, LLM_MODEL); standalone-friendly
 * The guards live with the callers and apply to every provider (notes.js: a rewrite that changes a number or batch is
 * discarded; photo.js: parsed rows whose batch is not in the transcription are dropped).
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
  if (config.llmProvider === 'openai-compatible') return !!(config.llmBaseUrl && config.llmModel);
  return config.llmProvider === 'aicore' && !!aicoreKey() && !!config.aicoreModel;
}

/**
 * SAP AI Core generative AI hub through the SAP Cloud SDK for AI (@sap-ai-sdk/foundation-models).
 * The SDK reads credentials from the "aicore" service binding or AICORE_SERVICE_KEY; for local hybrid runs we
 * hand it the key file named by AICORE_SERVICE_KEY_PATH (in memory only, never logged).
 */
let client;
function sdkClient() {
  if (client) return client;
  if (!process.env.AICORE_SERVICE_KEY && !cds.env.requires?.aicore?.credentials) {
    const k = aicoreKey();
    if (k) process.env.AICORE_SERVICE_KEY = JSON.stringify(k);
  }
  const { AzureOpenAiChatClient } = require('@sap-ai-sdk/foundation-models');
  client = new AzureOpenAiChatClient({ modelName: config.aicoreModel, resourceGroup: config.aicoreResourceGroup });
  return client;
}

/** messages: [{role, content}] -> string. content may be an array of parts (text + image_url) for vision models. */
async function chat(messages, { maxTokens = 800, temperature = 0 } = {}) {
  if (override) return override(messages);
  if (!enabled()) return null;
  if (config.llmProvider === 'openai-compatible') return openAiCompatible(messages, { maxTokens, temperature });
  const res = await sdkClient().run({ messages, max_tokens: maxTokens, temperature });
  return res.getContent() ?? null;
}

async function openAiCompatible(messages, { maxTokens, temperature }) {
  const headers = { 'Content-Type': 'application/json' };
  if (config.llmApiKey) headers.Authorization = 'Bearer ' + config.llmApiKey;
  const res = await http.request(`${config.llmBaseUrl}/chat/completions`, {
    method: 'POST', headers, timeoutMs: 60000,
    body: JSON.stringify({ model: config.llmModel, messages, max_tokens: maxTokens, temperature }),
  });
  if (res.status !== 200) throw new Error(`LLM API returned ${res.status}`);
  return res.json?.choices?.[0]?.message?.content ?? null;
}

/** One image + an instruction -> string (stock-register photos). Same guard rules as chat(). */
function vision(prompt, imageBase64, mimeType = 'image/jpeg', opts) {
  return chat([
    { role: 'system', content: 'You read photos of pharmacy stock registers. Reply with JSON only. Never invent values.' },
    { role: 'user', content: [{ type: 'text', text: prompt }, { type: 'image_url', image_url: { url: `data:${mimeType};base64,${imageBase64}` } }] },
  ], { maxTokens: 2000, ...opts });
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

module.exports = { enabled, chat, vision, safeChat, extractJson, setClient };
