'use strict';
// Admin-only delivery operations (support / ops). Couriers use their per-delivery link instead (lib/courier.js).
const cds = require('@sap/cds');
const delivery = require('../lib/delivery');
const workflow = require('../lib/workflow');
const { wrap } = require('./_util');

module.exports = cds.service.impl(function () {
  this.on('pickupScan', wrap(async req => {
    const t = await delivery.pickupScan(req.data.transfer, req.data, req.user.id, null);
    return workflow.toOut(t, 'Custody recorded; in transit');
  }));
  this.on('telemetry', wrap(async req => delivery.telemetry(req.data, req.user.id)));
  this.on('activeShipments', wrap(async () => delivery.activeShipments()));
});
