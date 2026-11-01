'use strict';
// Translate library errors ({status, code}) into CAP errors with a machine-readable code.
function wrap(fn) {
  return async req => {
    try { return await fn(req); } catch (e) {
      if (e.status && e.status < 600) {
        const code = e.code || String(e.message).split(':')[0];
        return req.reject({ status: e.status, code, message: e.message, ...(e.retryAfter && { retryAfter: e.retryAfter }) });
      }
      throw e;
    }
  };
}
module.exports = { wrap };
