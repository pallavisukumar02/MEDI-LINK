'use strict';
const cds = require('@sap/cds');
const workflow = require('../lib/workflow');
const { hospitalOf, isAdmin } = require('../lib/users');
const { wrap } = require('./_util');

async function mustBeSupplier(req) {
  const t = await workflow.load(req.data.transfer);
  if (!isAdmin(req) && t.supplier_ID !== hospitalOf(req)) return req.reject(403, 'NOT_SUPPLIER: only the supplying hospital can act on this transfer');
  return t;
}
module.exports = cds.service.impl(function () {
  this.on('review', wrap(async req => { await mustBeSupplier(req); return workflow.supplierReview(req.data.transfer); }));
  this.on('accept', wrap(async req => { await mustBeSupplier(req); return workflow.supplierAccept(req.data.transfer, req.data, req.user.id); }));
  this.on('decline', wrap(async req => { await mustBeSupplier(req); return workflow.supplierDecline(req.data.transfer, req.data, req.user.id); }));
});
