'use strict';
/*
 * Stock-register photo for clinics with nothing digital (PRD section 16, FR-04).
 *   1. preview: the image goes to SAP AI Core (SAP Cloud SDK for AI) which returns a transcription + rows;
 *      a row is kept only if its batch number is visible in that transcription (same guard as the alert parser).
 *      Nothing is saved to stock: the rows wait in PhotoPreviews for the pharmacist.
 *   2. confirm: the pharmacist confirms the preview and the rows go through the normal ingest path (source SHEET).
 * LLM off -> LLM_DISABLED; the sheet upload keeps working.
 */
const cds = require('@sap/cds');
const llm = require('./llm');
const audit = require('./audit');
const { ingestSnapshot } = require('./ingest');

const err = (status, code, message) => Object.assign(new Error(`${code}: ${message}`), { status, code });
const norm = s => String(s ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');
const PREVIEW_HOURS = 24;
const PROMPT = [
  'This is a photo of one page of a hospital pharmacy stock register.',
  'First copy every word and number you can read on the page into "text", exactly as written.',
  'Then list each stock line as {"generic","strength","form","brandName","manufacturer","batchNo","quantity","expiryDate","storageClass","sealed"}.',
  'Leave a field empty when you cannot read it. Never guess a batch number or a quantity.',
  'Reply with JSON only: {"text": "...", "rows": [...]}',
].join('\n');

async function preview(hospitalId, imageBase64, mimeType, actor) {
  if (!llm.enabled()) throw err(409, 'LLM_DISABLED', 'Photo reading needs the LLM (LLM_PROVIDER=aicore); upload a stock sheet instead');
  const image = String(imageBase64 || '').replace(/^data:[^;]+;base64,/, '');
  if (!image) throw err(400, 'IMAGE_REQUIRED', 'No image');
  const reply = await llm.vision(PROMPT, image, mimeType || 'image/jpeg');
  const j = llm.extractJson(reply);
  if (!j || !Array.isArray(j.rows)) throw err(502, 'LLM_UNPARSEABLE', 'LLM reply was not {text, rows}');
  const seen = norm(j.text);
  const rows = [], dropped = [];
  for (const r of j.rows) {
    // hallucination guard: the batch must be visible in the model's own transcription of the page
    if (r?.batchNo && seen.includes(norm(r.batchNo))) rows.push(r); else dropped.push(r?.batchNo || '(no batch)');
  }
  if (!rows.length) throw err(422, 'PHOTO_NOTHING_READABLE', 'No row with a readable batch number');
  const previewId = cds.utils.uuid();
  await INSERT.into('medilink.PhotoPreviews').entries({ ID: previewId, hospital_ID: hospitalId, rows: JSON.stringify(rows), createdAt: new Date().toISOString() });
  await audit.log(actor, 'PHOTO_READ', { hospital: hospitalId, preview: previewId, rows: rows.length, dropped });
  return { previewId, rows, dropped };
}

async function confirm(hospitalId, previewId, actor) {
  const p = previewId && await SELECT.one.from('medilink.PhotoPreviews').where({ ID: previewId, hospital_ID: hospitalId });
  if (!p || p.usedAt || Date.now() - new Date(p.createdAt).getTime() > PREVIEW_HOURS * 3600000) throw err(404, 'PREVIEW_NOT_FOUND', 'Preview unknown, used or expired');
  const rows = JSON.parse(p.rows);
  const ingested = await ingestSnapshot(hospitalId, 'SHEET', { lots: rows }, { actor });
  await UPDATE('medilink.PhotoPreviews').set({ usedAt: new Date().toISOString() }).where({ ID: previewId });
  await audit.log(actor, 'PHOTO_CONFIRMED', { hospital: hospitalId, preview: previewId, lots: ingested.lots, skipped: ingested.skipped });
  return { rows: rows.length, ingested };
}

module.exports = { preview, confirm };
