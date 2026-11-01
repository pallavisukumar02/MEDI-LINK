'use strict';
/*
 * Straight-line distances (Haversine), behind one function.
 * Road distance / ETA (OpenRouteService or road factor) is built on top of this in routing.js.
 */
const { haversineKm } = require('./routing');

/** { [point.ID]: km } from `from` to each point ({ ID, lat, long }). */
async function distancesKm(from, points) {
  return Object.fromEntries(points.map(p => [p.ID, haversineKm(from, p)]));
}

module.exports = { distancesKm };
