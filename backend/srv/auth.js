'use strict';
// CAP custom authentication for the standalone profiles (cds.requires.auth.impl): MediLink accounts, see lib/accounts.js.
module.exports = (req, res, next) => require('./lib/accounts').authenticate(req, res, next);
