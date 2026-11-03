'use strict';
const cds = require('@sap/cds');
const coverdb = require('../lib/coverdb');
const matching = require('../lib/matching');
const workflow = require('../lib/workflow');
const audit = require('../lib/audit');
const { hospitalOf, isAdmin } = require('../lib/users');
const { wrap } = require('./_util');

async function ownRequest(req, id) {
  const r = await SELECT.one.from('medilink.Requests').where({ ID: id });
  if (!r) return req.reject(404, 'REQUEST_NOT_FOUND');
  if (!isAdmin(req) && r.hospital_ID !== hospitalOf(req)) return req.reject(403, 'FORBIDDEN_HOSPITAL');
  return r;
}

module.exports = cds.service.impl(function () {
  this.on('prefill', wrap(async req => {
    const card = await coverdb.shortfallCard(hospitalOf(req), req.data.drug, req.data.window);
    if (!card) return req.reject(404, 'UNKNOWN_DRUG');
    return card.prefill;
  }));

  this.on('createRequest', wrap(async req => {
    const hId = hospitalOf(req);
    const d = req.data;
    const card = await coverdb.shortfallCard(hId, d.drug, d.window);
    if (!card) return req.reject(404, 'UNKNOWN_DRUG');
    const qty = d.qty ?? card.prefill.qty;
    const neededBy = d.neededBy ?? card.prefill.neededBy;
    const today = new Date().toISOString().slice(0, 10);
    if (!(qty > 0)) return req.reject({ status: 400, code: 'NO_SHORTFALL', message: 'No shortfall to request (quantity must be > 0)' });
    if (!neededBy || String(neededBy) < today) return req.reject({ status: 400, code: 'INVALID_NEEDED_BY', message: 'Needed-by date must be today or later' });
    const r = { ID: cds.utils.uuid(), hospital_ID: hId, drug_ID: d.drug, qty, neededBy, allowBrandSwitch: !!d.allowBrandSwitch, preferredBrand: card.prefill.preferredBrand, note: d.note || null, status: 'OPEN' };
    await INSERT.into('medilink.Requests').entries(r);
    await audit.log(req.user.id, 'REQUEST_CREATED', { request: r.ID, hospital: hId, drug: d.drug, qty, neededBy, allowBrandSwitch: r.allowBrandSwitch, prefilled: d.qty === undefined || d.qty === null });
    const ranking = await matching.rankRequest(r.ID, { actor: req.user.id });
    const fresh = await SELECT.one.from('medilink.Requests').where({ ID: r.ID });
    return { request: r.ID, status: fresh.status, qty, neededBy, allowBrandSwitch: r.allowBrandSwitch, preferredBrand: r.preferredBrand, ranking };
  }));

  this.on('rank', wrap(async req => {
    await ownRequest(req, req.data.request);
    const refused = req.data.excludeRefused ? await SELECT.from('medilink.Transfers').columns('supplier_ID').where({ request_ID: req.data.request, status: { in: ['DECLINED', 'TIMED_OUT', 'REJECTED'] } }) : [];
    return matching.rankRequest(req.data.request, { actor: req.user.id, excludeHospitals: [...new Set(refused.map(t => t.supplier_ID))] });
  }));

  this.on('choosePlan', wrap(async req => {
    await ownRequest(req, req.data.request);
    return workflow.choosePlan(req.data.request, req.data.rank || 1, req.user.id);
  }));

  this.on('chooseSuppliers', wrap(async req => {
    await ownRequest(req, req.data.request);
    return workflow.chooseSuppliers(req.data.request, req.data.hospitals, req.user.id);
  }));

  this.on('cancelRequest', wrap(async req => {
    const r = await ownRequest(req, req.data.request);
    return workflow.cancelRequest(r.ID, req.user.id);
  }));
});
