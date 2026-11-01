'use strict';
// WebSocket contexts: a socket only ever sits in the contexts of its own hospital / partner / role (see lib/ws.js).
const cds = require('@sap/cds');
const { contextsFor } = require('../lib/ws');

async function joinOwn(req) {
  const ws = req.context?.ws?.service;
  if (!ws) return;
  await ws.reset(); // drops anything a client tried to enter on its own
  for (const c of contextsFor(req.user)) await ws.enter(c);
}
module.exports = cds.service.impl(function () {
  this.on('wsConnect', joinOwn);
  this.on('wsContext', joinOwn);
});
