'use strict';
const cds = require('@sap/cds');
const { hospitalOf } = require('../lib/users');
const { setMargin } = require('./admin');
const { wrap } = require('./_util');
module.exports = cds.service.impl(function () {
  this.on('setSafetyMargin', wrap(async req => setMargin(hospitalOf(req), req.data.pct, req.user.id)));
});
