'use strict';
const cds = require('@sap/cds');
const receipt = require('../lib/receipt');
const { hospitalOf, isAdmin } = require('../lib/users');
const { wrap } = require('./_util');
module.exports = cds.service.impl(function () {
  this.on('arrivalScan', wrap(async req => receipt.arrivalScan(req.data.transfer, req.data, req.user.id, isAdmin(req) ? null : hospitalOf(req))));
});
