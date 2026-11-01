'use strict';
const cds = require('@sap/cds');
const coverdb = require('../lib/coverdb');
const sync = require('../lib/sync');
const { hospitalOf } = require('../lib/users');
const { wrap } = require('./_util');

module.exports = cds.service.impl(function () {
  this.on('board', wrap(async req => coverdb.board(hospitalOf(req, req.data.hospital), req.data.window)));
  this.on('shortfall', wrap(async req => {
    const h = hospitalOf(req, req.data.hospital);
    const r = await sync.syncHospital(h); // FR-06: re-sync on opening a shortfall
    const card = await coverdb.shortfallCard(h, req.data.drug, req.data.window);
    if (!card) return req.reject(404, 'UNKNOWN_DRUG_OR_HOSPITAL');
    return { ...card, synced: r?.mode || 'n/a' };
  }));
  this.on('nearExpiry', wrap(async req => coverdb.nearExpiry(hospitalOf(req, req.data.hospital), req.data.days)));
  this.on('cityView', wrap(async req => coverdb.cityView(req.data.window)));
});
