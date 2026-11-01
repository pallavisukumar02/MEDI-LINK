'use strict';
const cds = require('@sap/cds');
const trust = require('../lib/trust');
const audit = require('../lib/audit');
const { wrap } = require('./_util');
module.exports = cds.service.impl(function () {
  this.on('parseAlert', wrap(async req => trust.parseAlert(req.data, req.user.id)));
  this.on('recall', wrap(async req => trust.recall(req.data, req.user.id)));
  this.after(['CREATE', 'UPDATE'], 'Flags', async (f, req) => {
    await audit.log(req.user.id, req.event === 'CREATE' ? 'FLAG_ADDED' : 'FLAG_UPDATED', { flag: f.ID, batchNo: f.batchNo, manufacturer: f.manufacturer, reason: f.reason, active: f.active });
    if (req.event === 'CREATE' && f.active !== false) await trust.quarantineMatching(f, req.user.id);
  });
  this.before('DELETE', 'Flags', req => req.reject(405, 'FLAGS_NOT_DELETABLE: set active=false instead'));
});
