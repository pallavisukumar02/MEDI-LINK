'use strict';
// Stock-sheet upload fallback (FR-04): CSV parsing, column mapping (synonyms, then optional LLM), preview.
const llm = require('./llm');

const FIELDS = {
  generic: ['generic', 'genericname', 'itemname', 'item', 'drug', 'drugname', 'medicine', 'name'],
  strength: ['strength', 'str', 'dose', 'potency'],
  form: ['form', 'dosageform', 'type'],
  brandName: ['brand', 'brandname', 'tradename'],
  manufacturer: ['manufacturer', 'mfr', 'mfg', 'maker', 'company'],
  batchNo: ['batch', 'batchno', 'batchnumber', 'lot', 'lotno'],
  quantity: ['qty', 'quantity', 'stock', 'onhand', 'qtyonhand', 'units', 'balance'],
  expiryDate: ['expiry', 'expirydate', 'expdt', 'exp', 'expdate', 'bestbefore'],
  storageClass: ['storage', 'store', 'storageclass', 'temp', 'storagecondition'],
  sealed: ['sealed', 'seal', 'unopened', 'sealok'],
};
const REQUIRED = ['generic', 'strength', 'batchNo', 'quantity', 'expiryDate'];
const key = s => String(s).toLowerCase().replace(/[^a-z0-9]/g, '');

function parseCsv(text) {
  const rows = []; let row = [], cell = '', q = false;
  const s = String(text).replace(/\r\n?/g, '\n');
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (q) {
      if (ch === '"' && s[i + 1] === '"') { cell += '"'; i++; } else if (ch === '"') q = false; else cell += ch;
    } else if (ch === '"') q = true;
    else if (ch === ',' || ch === ';' || ch === '\t') { row.push(cell); cell = ''; }
    else if (ch === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; }
    else cell += ch;
  }
  if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
  return rows.filter(r => r.some(c => String(c).trim() !== ''));
}

function synonymMapping(headers) {
  const mapping = {};
  for (const [field, syns] of Object.entries(FIELDS)) {
    const idx = headers.findIndex(h => syns.includes(key(h)));
    if (idx >= 0) mapping[field] = headers[idx];
  }
  return mapping;
}

async function llmMapping(headers, sample) {
  if (!llm.enabled()) return null;
  const reply = await llm.safeChat([
    { role: 'system', content: 'You map spreadsheet column headers to a fixed schema. Reply with JSON only.' },
    { role: 'user', content: `Schema fields: ${Object.keys(FIELDS).join(', ')}.\nHeaders: ${JSON.stringify(headers)}\nSample row: ${JSON.stringify(sample)}\nReturn {"field": "Header"} for each field you can map; omit unknown fields.` },
  ]);
  const j = llm.extractJson(reply);
  if (!j || typeof j !== 'object') return null;
  return Object.fromEntries(Object.entries(j).filter(([f, h]) => FIELDS[f] && headers.includes(h)));
}

async function analyse(text, explicitMapping) {
  const rows = parseCsv(text);
  if (rows.length < 2) return { mapping: {}, mappingSource: 'none', items: [], missing: REQUIRED };
  const headers = rows[0].map(h => h.trim());
  let mapping = explicitMapping || synonymMapping(headers);
  let mappingSource = explicitMapping ? 'confirmed' : 'synonyms';
  let missing = REQUIRED.filter(f => !mapping[f]);
  if (missing.length && !explicitMapping) {
    const m = await llmMapping(headers, rows[1]);
    if (m) { mapping = { ...m, ...mapping }; mappingSource = 'synonyms+llm'; missing = REQUIRED.filter(f => !mapping[f]); }
  }
  const idx = Object.fromEntries(Object.entries(mapping).map(([f, h]) => [f, headers.indexOf(h)]));
  const items = rows.slice(1).map(r => Object.fromEntries(Object.entries(idx).filter(([, i]) => i >= 0).map(([f, i]) => [f, String(r[i] ?? '').trim()])));
  return { mapping, mappingSource, items, missing, headers };
}

module.exports = { parseCsv, synonymMapping, analyse, REQUIRED };
