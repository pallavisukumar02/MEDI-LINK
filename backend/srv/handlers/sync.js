'use strict';
const cds = require('@sap/cds');
const sheet = require('../lib/sheet');
const sync = require('../lib/sync');
const { ingestSnapshot } = require('../lib/ingest');
const { hospitalOf } = require('../lib/users');
const { wrap } = require('./_util');
const coverdb = require('../lib/coverdb');
const { resolveDrug, parseDate } = require('../lib/ingest');
const photo = require('../lib/photo');
const ratelimit = require('../lib/ratelimit');

module.exports = cds.service.impl(function () {
  this.on('uploadSheet', wrap(async req => {
    const hId = hospitalOf(req, req.data.hospital);
    const explicit = req.data.mapping ? JSON.parse(req.data.mapping) : undefined;
    const a = await sheet.analyse(req.data.csv || '', explicit);
    const drugs = await coverdb.drugsById();
    const unresolved = a.items.filter(i => !resolveDrug(i, drugs) || !parseDate(i.expiryDate));
    const base = { hospitalId: hId, mapping: JSON.stringify(a.mapping), mappingSource: a.mappingSource, rows: a.items.length, unresolved: JSON.stringify(unresolved), preview: JSON.stringify(a.items.slice(0, 20)) };
    if (a.missing.length) return req.reject({ status: 422, code: 'SHEET_COLUMNS_UNMAPPED', message: `Could not map columns: ${a.missing.join(', ')}. Send a confirmed mapping.` });
    if (!req.data.confirm) return base; // admin reviews mapping + preview first
    const ingested = await ingestSnapshot(hId, 'SHEET', { lots: a.items }, { actor: req.user.id });
    return { ...base, ingested };
  }));
  this.on('uploadPhoto', wrap(async req => {
    const hId = hospitalOf(req, req.data.hospital);
    if (req.data.confirm) {
      const r = await photo.confirm(hId, req.data.previewId, req.user.id);
      return { hospitalId: hId, previewId: req.data.previewId, rows: r.rows, ingested: r.ingested };
    }
    ratelimit.check(req, 'photo', 10, 60 * ratelimit.MIN); // each preview is a paid LLM call
    const p = await photo.preview(hId, req.data.imageBase64, req.data.mimeType, req.user.id);
    return { hospitalId: hId, previewId: p.previewId, rows: p.rows.length, preview: JSON.stringify(p.rows), dropped: JSON.stringify(p.dropped) };
  }));
  this.on('syncNow', wrap(async req => {
    const hId = req.data.hospital ? hospitalOf(req, req.data.hospital) : (req.user.is('admin') ? null : hospitalOf(req));
    return hId ? [await sync.syncHospital(hId)] : sync.syncAll();
  }));
});
