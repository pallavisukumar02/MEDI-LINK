'use strict';
// Minimal fetch wrapper with timeout and JSON parsing. Never logs headers (they may hold keys/tokens).
async function request(url, { method = 'GET', headers = {}, body, timeoutMs = 10000 } = {}) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { method, headers, body, signal: ctrl.signal, redirect: 'manual' });
    const text = await res.text();
    let json;
    try { json = text ? JSON.parse(text) : undefined; } catch { json = undefined; }
    return { status: res.status, headers: res.headers, text, json };
  } finally {
    clearTimeout(t);
  }
}
const form = obj => new URLSearchParams(Object.entries(obj).filter(([, v]) => v !== undefined && v !== null)).toString();
module.exports = { request, form };
