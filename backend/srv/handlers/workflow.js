'use strict';
// BPA-compatible API: SAP Build Process Automation calls these actions (technical user with the "system" scope).
const cds = require('@sap/cds');
const workflow = require('../lib/workflow');
const { wrap } = require('./_util');
const actorOf = req => (req.data.actor ? `${req.data.actor} (via BPA)` : req.user.id);

module.exports = cds.service.impl(function () {
  this.on('context', wrap(async req => JSON.stringify(await workflow.bpaContext(req.data.transfer))));
  this.on('supplierDecision', wrap(async req => {
    const d = String(req.data.decision || '').toUpperCase();
    if (d === 'ACCEPT') return workflow.supplierAccept(req.data.transfer, req.data, actorOf(req));
    if (d === 'DECLINE') return workflow.supplierDecline(req.data.transfer, { reason: req.data.reason }, actorOf(req));
    return req.reject(400, 'INVALID_DECISION: ACCEPT or DECLINE');
  }));
  this.on('approvalDecision', wrap(async req => {
    const d = String(req.data.decision || '').toUpperCase();
    if (d === 'APPROVE') return workflow.approve(req.data.transfer, actorOf(req));
    if (d === 'REJECT') return workflow.reject(req.data.transfer, req.data.reason, actorOf(req));
    return req.reject(400, 'INVALID_DECISION: APPROVE or REJECT');
  }));
  this.on('timeout', wrap(async req => workflow.supplierDecline(req.data.transfer, {}, 'system:bpa-timer', 'TIMED_OUT')));
});
