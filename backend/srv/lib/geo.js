'use strict';
/*
 * Straight-line distances, behind one function:
 *   - SAP HANA Cloud (hybrid / production): ST_Distance on round-earth points (SRID 4326), one query per call
 *   - SQLite (development) or any HANA error: Haversine in JS
 * Road distance / ETA (OpenRouteService or road factor) is built on top of this in routing.js.
 */
const cds = require('@sap/cds');
const { haversineKm } = require('./routing');
const LOG = cds.log('geo');

const isHana = () => (cds.db?.kind || cds.env.requires.db?.kind) === 'hana';

/** One UNION ALL query over DUMMY: ST_Point(x = longitude, y = latitude), metres -> km. */
function hanaQuery(from, points) {
  const sql = points.map(() => 'SELECT ? AS "ID", NEW ST_Point(?, ?).ST_SRID(4326).ST_Distance(NEW ST_Point(?, ?).ST_SRID(4326)) / 1000 AS "KM" FROM DUMMY').join(' UNION ALL ');
  const values = points.flatMap(p => [p.ID, Number(p.long), Number(p.lat), Number(from.long), Number(from.lat)]);
  return { sql, values };
}

/** { [point.ID]: km } from `from` to each point ({ ID, lat, long }). */
async function distancesKm(from, points) {
  if (!points.length) return {};
  if (isHana()) {
    try {
      const { sql, values } = hanaQuery(from, points);
      const rows = await cds.db.run(sql, values);
      return Object.fromEntries(rows.map(r => [r.ID, Number(r.KM)]));
    } catch (e) { LOG.warn('ST_Distance failed, using Haversine:', e.message); }
  }
  return Object.fromEntries(points.map(p => [p.ID, haversineKm(from, p)]));
}

module.exports = { distancesKm, hanaQuery, isHana };
