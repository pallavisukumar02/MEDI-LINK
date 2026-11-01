'use strict';
const cds = require('@sap/cds');
const audit = require('../lib/audit');
const jobs = require('../lib/jobs');
const { wrap } = require('./_util');

async function setMargin(hospitalId, pct, actor) {
  if (!(pct >= 0 && pct <= 100)) { const e = new Error('INVALID_MARGIN: 0..100'); e.status = 400; throw e; }
  await UPDATE('medilink.Hospitals').set({ safetyMarginPct: pct }).where({ ID: hospitalId });
  await audit.log(actor, 'SETTINGS_CHANGED', { hospital: hospitalId, safetyMarginPct: pct });
  return { hospitalId, safetyMarginPct: pct };
}
module.exports = cds.service.impl(function () {
  this.on('setSafetyMargin', wrap(async req => setMargin(req.data.hospital, req.data.pct, req.user.id)));
  this.on('runJobs', wrap(async () => JSON.stringify(await jobs.runOnce())));
});
module.exports.setMargin = setMargin;
