'use strict';
// CAP custom authentication (cds.requires.auth.impl) for every profile: MediLink accounts, see lib/accounts.js.
module.exports = (req, res, next) => require('./lib/accounts').authenticate(req, res, next);
