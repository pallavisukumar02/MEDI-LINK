'use strict';
// Distance / ETA with OpenRouteService (free key) and a Haversine fallback, plus road-closure handling.
const config = require('./config');
const http = require('./http');

const R = 6371;
const rad = d => (Number(d) * Math.PI) / 180;
function haversineKm(a, b) {
  const dLat = rad(b.lat - a.lat), dLon = rad(b.long - a.long);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

// Local equirectangular projection (km) around a reference point – fine at city scale.
function project(p, ref) {
  return { x: rad(p.long - ref.long) * R * Math.cos(rad(ref.lat)), y: rad(p.lat - ref.lat) * R };
}
function unproject(xy, ref) {
  return { lat: ref.lat + (xy.y / R) * (180 / Math.PI), long: ref.long + (xy.x / (R * Math.cos(rad(ref.lat)))) * (180 / Math.PI) };
}
/** Closest distance (km) from closure centre to segment a-b, and the projection parameter. */
function segmentDistance(a, b, c) {
  const A = project(a, c), B = project(b, c);
  const dx = B.x - A.x, dy = B.y - A.y;
  const len2 = dx * dx + dy * dy || 1e-12;
  const t = Math.max(0, Math.min(1, -(A.x * dx + A.y * dy) / len2));
  const px = A.x + t * dx, py = A.y + t * dy;
  return { dist: Math.hypot(px, py), t, A, B };
}
/** DB Decimals arrive as strings: coerce every point/closure to numbers before any arithmetic. */
const pt = p => ({ ...p, lat: Number(p.lat), long: Number(p.long) });
const cl = c => ({ ...c, lat: Number(c.lat), long: Number(c.long), radiusKm: Number(c.radiusKm) });

const inside = (p, c) => haversineKm(p, c) <= Number(c.radiusKm);
const intersects = (a, b, c) => segmentDistance(a, b, c).dist <= Number(c.radiusKm);

/** Waypoint that skirts a closure on the perpendicular side, 1.6x its radius from the centre. */
function detourWaypoint(a, b, c) {
  a = pt(a); b = pt(b); c = cl(c);
  const { A, B } = segmentDistance(a, b, c);
  const dx = B.x - A.x, dy = B.y - A.y, len = Math.hypot(dx, dy) || 1;
  let nx = -dy / len, ny = dx / len;
  // pick the side the path is already leaning to
  const { t } = segmentDistance(a, b, c);
  const px = A.x + t * dx, py = A.y + t * dy;
  if (px * nx + py * ny < 0) { nx = -nx; ny = -ny; }
  const r = Number(c.radiusKm) * 1.6;
  return unproject({ x: nx * r, y: ny * r }, c);
}

function etaMinutes(km) { return Math.round(config.handlingMin + (km / config.citySpeedKmh) * 60); }

/** Pure fallback routing used when no ORS key (or ORS fails). straightKm: precomputed straight line (geo.js, HANA ST_Distance). */
function fallbackRoute(from, to, closures = [], straightKm) {
  from = pt(from); to = pt(to);
  const active = closures.filter(c => c.active !== false).map(cl);
  for (const c of active) if (inside(from, c) || inside(to, c)) return { open: false, distanceKm: null, etaMin: null, provider: 'haversine', note: `Endpoint inside closure "${c.name}"` };
  const hits = active.filter(c => intersects(from, to, c));
  if (!hits.length) {
    const km = (straightKm ?? haversineKm(from, to)) * config.roadFactor;
    return { open: true, detour: false, distanceKm: round(km), etaMin: etaMinutes(km), provider: 'haversine' };
  }
  // one detour per blocking closure, in order along the path
  const path = [from];
  hits.sort((x, y) => segmentDistance(from, to, x).t - segmentDistance(from, to, y).t);
  for (const c of hits) path.push(detourWaypoint(path[path.length - 1], to, c));
  path.push(to);
  for (let i = 0; i < path.length - 1; i++) {
    for (const c of active) if (intersects(path[i], path[i + 1], c)) return { open: false, distanceKm: null, etaMin: null, provider: 'haversine', note: `No detour around "${c.name}"` };
  }
  let km = 0; for (let i = 0; i < path.length - 1; i++) km += haversineKm(path[i], path[i + 1]);
  km *= config.roadFactor;
  return { open: true, detour: true, distanceKm: round(km), etaMin: etaMinutes(km), provider: 'haversine', via: path.slice(1, -1), note: `Detour around ${hits.map(h => h.name).join(', ')}` };
}

function circlePolygon(c, n = 16) {
  const ring = [];
  for (let i = 0; i <= n; i++) {
    const a = (2 * Math.PI * i) / n;
    const p = unproject({ x: Math.cos(a) * c.radiusKm, y: Math.sin(a) * c.radiusKm }, c);
    ring.push([p.long, p.lat]);
  }
  return ring;
}

async function orsRoute(from, to, closures) {
  from = pt(from); to = pt(to);
  const active = closures.filter(c => c.active !== false).map(cl);
  for (const c of active) if (inside(from, c) || inside(to, c)) return { open: false, provider: 'ors', note: `Endpoint inside closure "${c.name}"` };
  const body = { coordinates: [[Number(from.long), Number(from.lat)], [Number(to.long), Number(to.lat)]] };
  const hits = active.filter(c => intersects(from, to, c));
  if (hits.length) body.options = { avoid_polygons: { type: 'MultiPolygon', coordinates: hits.map(c => [circlePolygon(c)]) } };
  const res = await http.request(`${config.orsBaseUrl}/v2/directions/driving-car`, {
    method: 'POST', headers: { Authorization: config.orsKey, 'Content-Type': 'application/json' }, body: JSON.stringify(body), timeoutMs: 6000,
  });
  if (res.status === 404 || res.status === 400) return { open: false, provider: 'ors', note: 'No route avoiding closures' };
  if (res.status !== 200) throw new Error('ORS status ' + res.status);
  const s = res.json.routes?.[0]?.summary;
  if (!s) throw new Error('ORS: no summary');
  const km = s.distance / 1000;
  return { open: true, detour: hits.length > 0, distanceKm: round(km), etaMin: Math.round(config.handlingMin + s.duration / 60), provider: 'ors', note: hits.length ? `Detour around ${hits.map(h => h.name).join(', ')}` : undefined };
}

async function route(from, to, closures = [], straightKm) {
  if (config.orsKey) {
    try { return await orsRoute(from, to, closures); } catch (e) { /* fall through to haversine */ }
  }
  return fallbackRoute(from, to, closures, straightKm);
}

const round = n => Math.round(n * 100) / 100;
module.exports = { haversineKm, route, fallbackRoute, intersects, inside, detourWaypoint, etaMinutes };
