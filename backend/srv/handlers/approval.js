'use strict';
const cds = require('@sap/cds');
const workflow = require('../lib/workflow');
const { hospitalOf, isAdmin } = require('../lib/users');
const { wrap } = require('./_util');

async function mustBeApprover(req) {
  const t = await workflow.load(req.data.transfer);
  if (!isAdmin(req) && t.supplier_ID !== hospitalOf(req)) return req.reject(403, 'NOT_APPROVER: approvals come from the supplying hospital');
}
module.exports = cds.service.impl(function () {
  this.on('approveTransfer', wrap(async req => { await mustBeApprover(req); return workflow.approve(req.data.transfer, req.user.id); }));
  this.on('rejectTransfer', wrap(async req => { await mustBeApprover(req); return workflow.reject(req.data.transfer, req.data.reason, req.user.id); }));
});
