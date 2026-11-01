'use strict';
const cds = require('@sap/cds');
const ledger = require('../lib/ledger');
const { hospitalOf, isAdmin } = require('../lib/users');
const { wrap } = require('./_util');
module.exports = cds.service.impl(function () {
  this.on('settleLoan', wrap(async req => ledger.settleLoan(req.data.loan, req.data, req.user.id, isAdmin(req) ? null : hospitalOf(req))));
});
