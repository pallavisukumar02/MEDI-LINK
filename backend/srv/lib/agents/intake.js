'use strict';
/*
 * Intake helper (Agentic AI step 1): a pasted stock list in any shape ("Carboplatin 450mg batch PH24A001 qty 18
 * exp 03/2027", a WhatsApp message, rows copied from a spreadsheet) -> clean rows mapped to MediLink's medicine master.
 *   LLM on:  the model extracts rows; a row is kept only if its batch and quantity appear in the pasted text
 *   LLM off: a line parser reads the same formats
 * Then code, not the model, validates every row: the medicine must be in the master (name + strength), the expiry
 * must be a real future date, the quantity a whole number, the batch present. When one thing is unclear (e.g. which
 * strength) it asks one clarifying question instead of guessing.
 * Nothing is saved: valid rows wait in PhotoPreviews and the pharmacist saves them with "Save these rows"
 * (confirm-photo), through the normal ingest path.
 */
const cds = require('@sap/cds');
const llm = require('../llm');
const audit = require('../audit');
const coverdb = require('../coverdb');
const runner = require('./runner');
const { parseDate } = require('../ingest');
const { drugLabel } = require('./tools');

const err = (status, code, message) => Object.assign(new Error(`${code}: ${message}`), { status, code });
const norm = s => String(s ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');
const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
const MAX_LINES = 200;

/** Any of 03/2027, 3-27, Mar 2027, March-27, 2027-03, 2027-03-31, 31/03/2027 -> YYYY-MM-DD, or null. */
function expiryOf(v) {
  const s = String(v || '').trim().toLowerCase();
  if (!s) return null;
  let m;
  if ((m = s.match(/^(\d{4})-(\d{1,2})$/))) return parseDate(`${m[2]}/${m[1]}`);
  if ((m = s.match(/^(\d{1,2})[/.-](\d{2})$/))) return parseDate(`${m[1]}/20${m[2]}`);
  if ((m = s.match(/^([a-z]{3})[a-z]*[\s.\-/']*(\d{2}|\d{4})$/)) && MONTHS[m[1]]) return parseDate(`${MONTHS[m[1]]}/${m[2].length === 2 ? '20' + m[2] : m[2]}`);
  const d = parseDate(s);
  return d && !isNaN(Date.parse(d)) ? d : null;
}

const EXP_RE = /(?:exp(?:iry|iring|\.)?|use before|best before|ed)\s*[:\-]?\s*([0-9]{1,2}[/.\-][0-9]{2,4}(?:[/.\-][0-9]{2,4})?|[0-9]{4}-[0-9]{1,2}(?:-[0-9]{1,2})?|[a-z]{3,9}[\s.\-/']*[0-9]{2,4})/i;
const BATCH_RE = /(?:batch|lot|b\.?\s?no\.?|bn)\s*[:#\-]?\s*([A-Z0-9][A-Z0-9\-]{3,})/i;
const QTY_RE = /\b(?:qty|quantity|units?|nos?\.?|count|x)\s*[:\-]?\s*(\d+)\b|\b(\d+)\s*(?:vials?|units?|nos|amps?|ampoules?|pcs)\b/i;

/** Rules-only reading: one stock line per text line. */
function parseLines(text, drugs) {
  const rows = [];
  for (const line of String(text).split(/\r?\n/).slice(0, MAX_LINES)) {
    const l = line.trim();
    if (!l) continue;
    const low = l.toLowerCase();
    const names = [...new Set(drugs.filter(d => low.includes(d.genericName.toLowerCase())).map(d => d.genericName))];
    const batch = l.match(BATCH_RE)?.[1];
    if (!names.length && !batch) continue; // a heading or chatter
    const rest = l.replace(BATCH_RE, ' ').replace(EXP_RE, ' '); // quantity is read from what is left
    const qm = rest.match(QTY_RE);
    const strength = low.match(/(\d+(?:\.\d+)?)\s*(mg|g|mcg|ml)\b/)?.[0] || '';
    rows.push({ line: l, generic: names[0] || '', strength, batchNo: batch || '', quantity: qm ? Number(qm[1] || qm[2]) : null, expiry: l.match(EXP_RE)?.[1] || '', brandName: '' });
  }
  return rows;
}

async function llmRows(text) {
  const reply = await llm.safeChat([
    { role: 'system', content: 'You read stock lists written by hospital pharmacists. Reply with JSON only. Never invent values.' },
    { role: 'user', content: `List every stock line as {"generic","strength","brandName","batchNo","quantity","expiry"}. Leave a field empty when it is not written. Reply {"rows": [...]}.\n\n${text}` },
  ], { maxTokens: 1500 });
  const j = llm.extractJson(reply);
  return Array.isArray(j?.rows) ? j.rows : null;
}

/** Validate in code and map to the master. Returns { rows, rejected, question }. */
function validate(raw, text, drugs, today) {
  const seen = norm(text);
  const rows = [], rejected = [];
  let question = null;
  for (const r of raw) {
    const batch = String(r.batchNo || '').trim().toUpperCase();
    const reject = why => rejected.push({ batchNo: batch || null, line: r.line || null, reason: why });
    if (!batch) { reject('no batch number'); continue; }
    if (!seen.includes(norm(batch))) { reject('batch not found in what you pasted'); continue; } // anti-hallucination guard
    const same = drugs.filter(d => norm(d.genericName) === norm(r.generic) || (r.generic && norm(d.genericName).startsWith(norm(r.generic)) && norm(r.generic).length >= 4));
    const s = norm(r.strength);
    const exact = s ? same.filter(d => norm(d.strength).startsWith(s) || norm(String(d.strength).split('/')[0]) === s) : same;
    if (!same.length) { reject(`"${r.generic || '?'}" is not in the medicine list`); continue; }
    if (exact.length !== 1) {
      const opts = (exact.length ? exact : same).map(d => d.strength);
      reject('strength unclear');
      question ||= `Which strength is batch ${batch} of ${same[0].genericName}: ${opts.join(' or ')}?`;
      continue;
    }
    const drug = exact[0];
    const qty = Number(r.quantity);
    if (!Number.isInteger(qty) || qty <= 0) { reject('quantity missing or not a whole number'); question ||= `How many vials are in batch ${batch}?`; continue; }
    if (r.line === undefined && !seen.includes(String(qty))) { reject('quantity not found in what you pasted'); continue; }
    const expiry = expiryOf(r.expiry ?? r.expiryDate);
    if (!expiry) { reject('expiry date missing or unreadable'); question ||= `When does batch ${batch} expire? (for example 03/2027)`; continue; }
    if (expiry <= today) { reject(`already expired on ${expiry}`); continue; }
    rows.push({ drugId: drug.ID, generic: drug.genericName, strength: drug.strength, form: drug.dosageForm, medicine: drugLabel(drug), brandName: r.brandName || null, batchNo: batch, quantity: qty, expiryDate: expiry, sealed: 'Y' });
  }
  return { rows, rejected, question };
}

async function preview(hospitalId, text, actor) {
  const src = String(text || '').trim();
  if (!src) throw err(400, 'INTAKE_EMPTY', 'Nothing pasted');
  const drugs = Object.values(await coverdb.drugsById());
  let raw = null, mode = 'rules';
  if (runner.enabled() && llm.enabled()) { raw = await llmRows(src.slice(0, 8000)); if (raw) mode = 'llm'; }
  if (!raw) raw = parseLines(src, drugs);
  const { rows, rejected, question } = validate(raw, src, drugs, coverdb.today());
  let previewId = null;
  if (rows.length) {
    previewId = cds.utils.uuid();
    await INSERT.into('medilink.PhotoPreviews').entries({ ID: previewId, hospital_ID: hospitalId, rows: JSON.stringify(rows), createdAt: new Date().toISOString() });
  }
  await audit.log(actor, 'INTAKE_READ', { hospital: hospitalId, preview: previewId, rows: rows.length, rejected: rejected.length, mode });
  await runner.record({ agent: 'intake', hospitalId, actor, mode, input: `${src.split(/\r?\n/).length} pasted lines`, output: { rows: rows.length, rejected: rejected.length, question }, steps: 1 });
  return { previewId, rows, rejected, question, mode };
}

module.exports = { preview, parseLines, validate, expiryOf };
