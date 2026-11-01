'use strict';
const cds = require('@sap/cds');
const delivery = require('../lib/delivery');
const workflow = require('../lib/workflow');
const { partnerOf, isAdmin } = require('../lib/users');
const { wrap } = require('./_util');

module.exports = cds.service.impl(function () {
  this.on('pickupScan', wrap(async req => {
    const t = await delivery.pickupScan(req.data.transfer, req.data, req.user.id, isAdmin(req) ? null : partnerOf(req));
    return workflow.toOut(t, 'Custody recorded; in transit');
  }));
  // Partner ownership is enforced inside delivery.telemetry for both transfer-ID and logger-ID addressing.
  this.on('telemetry', wrap(async req => delivery.telemetry(req.data, req.user.id, isAdmin(req) ? null : partnerOf(req) || '__none__')));
  this.on('activeShipments', wrap(async req => delivery.activeShipments(isAdmin(req) ? null : partnerOf(req))));
});
