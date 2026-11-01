'use strict';
const cds = require('@sap/cds');
const audit = require('../lib/audit');
module.exports = cds.service.impl(function () {
  this.on('verify', async () => audit.verify());
  this.before(['CREATE', 'UPDATE', 'DELETE'], 'Entries', req => req.reject(405, 'AUDIT_APPEND_ONLY'));
});
