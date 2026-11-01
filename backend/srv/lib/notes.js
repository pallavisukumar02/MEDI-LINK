'use strict';
/*
 * Transfer note for the courier and the receiving pharmacist, written when a transfer is approved (PRD section 16).
 * The template is always correct; with the LLM on it only rewords it, and the rewrite is thrown away unless it keeps
 * exactly the same numbers and batch codes (same guard as matcher/explain.py numbers_preserved).
 */
const cds = require('@sap/cds');
const llm = require('./llm');
const { rangeFor } = require('./delivery');
const LOG = cds.log('notes');

const NUM = /\d+(?:\.\d+)?/g;
const BATCH = /\b[A-Z0-9]*\d[A-Z0-9]*[A-Z][A-Z0-9]*\b|\b[A-Z]+\d+[A-Z0-9]*\b/g;
const sorted = xs => [...xs].sort();
/** True when the rewrite keeps exactly the same numbers and batch codes as the original. */
function factsPreserved(original, rewritten) {
  const same = (re) => JSON.stringify(sorted(original.match(re) || [])) === JSON.stringify(sorted((rewritten || '').match(re) || []));
  return same(NUM) && same(BATCH);
}

function template({ drug, qty, lots, storageClass, from, to }) {
  const [min, max] = rangeFor(storageClass);
  const batches = lots.map(l => `${l.batchNo} x ${l.qty}`).join(', ');
  const keep = storageClass === 'COLD' ? `Keep cold at ${min} to ${max} °C; do not freeze; keep the logger with the box.`
    : storageClass === 'FROZEN' ? `Keep frozen at ${min} to ${max} °C; keep the logger with the box.`
      : `Keep between ${min} and ${max} °C, out of direct sun.`;
  return `${drug.genericName} ${drug.strength} ${String(drug.dosageForm).toLowerCase()}: ${qty} vials (batch ${batches}). ${keep} `
    + `Cancer medicine: keep sealed and upright, do not open, hand over to the pharmacist only. From ${from} to ${to}.`;
}

async function facts(id) {
  const t = await SELECT.one.from('medilink.Transfers').where({ ID: id });
  const [drug, lots, from, to] = await Promise.all([
    SELECT.one.from('medilink.Drugs').where({ ID: t.drug_ID }), SELECT.from('medilink.TransferLots').where({ transfer_ID: id }),
    SELECT.one.from('medilink.Hospitals').columns('name').where({ ID: t.supplier_ID }), SELECT.one.from('medilink.Hospitals').columns('name').where({ ID: t.receiver_ID }),
  ]);
  return { drug, qty: t.qty, lots, storageClass: drug.storageClass, from: from.name.split(',')[0], to: to.name.split(',')[0] };
}

/** Write (and return) the note for an approved transfer. Never throws: a note must not block a delivery. */
async function writeTransferNote(id) {
  try {
    const base = template(await facts(id));
    let note = base;
    if (llm.enabled()) {
      const reply = await llm.safeChat([
        { role: 'system', content: 'You rewrite delivery notes in short, friendly, plain English for a courier and a pharmacist. Keep every number and batch code exactly as given. Do not add facts. Reply with the note only.' },
        { role: 'user', content: base },
      ], { maxTokens: 200 });
      if (reply && factsPreserved(base, reply.trim())) note = reply.trim();
      else if (reply) LOG.info('LLM note changed a number or batch; using the template');
    }
    note = note.slice(0, 1000);
    await UPDATE('medilink.Transfers').set({ transferNote: note }).where({ ID: id });
    return note;
  } catch (e) { LOG.warn('transfer note skipped:', e.message); return null; }
}

module.exports = { writeTransferNote, template, factsPreserved };
