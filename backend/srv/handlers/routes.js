'use strict';
const cds = require('@sap/cds');
const delivery = require('../lib/delivery');
const { isAdmin } = require('../lib/users');
const { wrap } = require('./_util');
const ratelimit = require('../lib/ratelimit');

/** Only admins or a pharmacist of the supplying / receiving hospital may toggle a route (the courier uses its link). */
async function mayControl(req, transferId) {
  if (isAdmin(req)) return true;
  const t = await SELECT.one.from('medilink.Transfers').columns('supplier_ID', 'receiver_ID').where({ ID: transferId });
  if (!t) return true; // let delivery.setRouteClosed answer 404
  const h = req.user.attr?.hospital; const own = Array.isArray(h) ? h[0] : h;
  return req.user.is('pharmacist') && !!own && [t.supplier_ID, t.receiver_ID].includes(own);
}

module.exports = cds.service.impl(function () {
  this.on('setRouteClosed', wrap(async req => {
    if (!(await mayControl(req, req.data.transfer))) return req.reject(403, 'NOT_A_PARTY: only the supplier, receiver or assigned courier can change this route');
    return delivery.setRouteClosed(req.data.transfer, req.data.closed !== false, req.data.note, req.user.id);
  }));
  this.on('checkWeather', wrap(async req => { ratelimit.check(req, 'weather', 5, 10 * ratelimit.MIN); return delivery.checkWeather(req.user.id); })); // outbound call per shipment
});
