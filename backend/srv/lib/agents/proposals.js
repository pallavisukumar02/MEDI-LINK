'use strict';
/*
 * Human approval of agent proposals. An agent can only write an AgentProposals row; approving it runs at most one
 * existing MediLink action, as the approving person, through that action's own role check and input validation.
 * Every decision is written to the audit chain; an attached incident report is filed there too.
 */
const audit = require('../audit');
const notify = require('../notify');

const err = (status, code, message) => Object.assign(new Error(`${code}: ${message}`), { status, code });

async function pending(hospitalId) {
  if (!hospitalId) return [];
  return SELECT.from('medilink.AgentProposals').where({ hospital_ID: hospitalId, status: 'PENDING' }).orderBy('createdAt desc');
}

async function load(id, viewer) {
  const p = await SELECT.one.from('medilink.AgentProposals').where({ ID: id });
  if (!p || (viewer.role !== 'admin' && p.hospital_ID !== viewer.hospitalId)) throw err(404, 'PROPOSAL_NOT_FOUND', 'Proposal unknown');
  if (p.status !== 'PENDING') throw err(409, 'PROPOSAL_DECIDED', `Already ${p.status}`);
  return p;
}

async function approve(id, viewer, note) {
  const p = await load(id, viewer);
  const { REGISTRY, validate } = require('../actions');
  let message = 'Decision recorded.';
  if (p.actionId) {
    const def = Object.hasOwn(REGISTRY, p.actionId) ? REGISTRY[p.actionId] : null;
    if (!def) throw err(409, 'PROPOSAL_ACTION_UNKNOWN', p.actionId);
    if (!def.roles.includes(viewer.role)) throw err(403, 'NOT_ALLOWED', 'role');
    const out = await def.run(validate(def.input, JSON.parse(p.body || '{}')), viewer);
    message = out?.message || message;
  }
  const by = viewer.userId || 'unknown';
  await UPDATE('medilink.AgentProposals').set({ status: 'APPROVED', decidedBy: by, decidedAt: new Date().toISOString(), result: [message, note].filter(Boolean).join(' / ').slice(0, 1000) }).where({ ID: p.ID });
  await audit.log(by, 'AGENT_PROPOSAL_APPROVED', { proposal: p.ID, agent: p.agent, kind: p.kind, actionId: p.actionId || null, ref: p.ref, note: note || null });
  if (p.report) {
    await audit.log(by, 'INCIDENT_REPORT', { proposal: p.ID, transfer: p.ref, report: p.report });
    const t = p.ref && await SELECT.one.from('medilink.Transfers').columns('supplier_ID', 'receiver_ID').where({ ID: p.ref });
    for (const h of t ? [t.supplier_ID, t.receiver_ID] : [p.hospital_ID]) await notify.notify({ hospital: h, kind: 'INCIDENT', severity: 'HIGH', ref: p.ref, message: p.report.slice(0, 500) });
    message = 'Incident report filed and both pharmacies told. Hold the stock for a quality check when it arrives.';
  }
  return { message, proposal: { ...p, status: 'APPROVED' } };
}

async function reject(id, viewer, note) {
  const p = await load(id, viewer);
  const by = viewer.userId || 'unknown';
  await UPDATE('medilink.AgentProposals').set({ status: 'REJECTED', decidedBy: by, decidedAt: new Date().toISOString(), result: (note || '').slice(0, 1000) }).where({ ID: p.ID });
  await audit.log(by, 'AGENT_PROPOSAL_REJECTED', { proposal: p.ID, agent: p.agent, kind: p.kind, ref: p.ref, note: note || null });
  return { message: 'Dismissed. Nothing was changed.' };
}

module.exports = { pending, approve, reject };
