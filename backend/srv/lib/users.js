'use strict';
// Resolve which hospital a user acts for. Admins may act for any hospital via a parameter.
const isAdmin = req => req.user?.is?.('admin');

function hospitalOf(req, explicit) {
  const own = req.user?.attr?.hospital;
  const ownId = Array.isArray(own) ? own[0] : own;
  if (explicit && (isAdmin(req) || explicit === ownId)) return explicit;
  if (explicit && !isAdmin(req)) return req.reject(403, `FORBIDDEN_HOSPITAL: you act for ${ownId || 'no hospital'}, not ${explicit}`);
  if (!ownId && !isAdmin(req)) return req.reject(403, 'NO_HOSPITAL: your user has no hospital attribute');
  return ownId || explicit;
}
module.exports = { hospitalOf, isAdmin };
