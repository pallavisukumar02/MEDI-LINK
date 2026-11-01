'use strict';
/*
 * Courier simulator: pure logic (positions, temperatures, the one deliberate excursion).
 * index.js wires it to the courier links (/courier/*). ALL readings are SYNTHETIC.
 */

/** Point at fraction f (0..1) along a polyline of {lat,long} points, by segment length. */
function interpolate(path, f) {
  const pts = path.map(p => ({ lat: Number(p.lat), long: Number(p.long) }));
  if (pts.length === 1) return pts[0];
  const seg = [];
  let total = 0;
  for (let i = 0; i < pts.length - 1; i++) {
    const d = Math.hypot(pts[i + 1].lat - pts[i].lat, pts[i + 1].long - pts[i].long);
    seg.push(d); total += d;
  }
  let target = Math.max(0, Math.min(1, f)) * total;
  for (let i = 0; i < seg.length; i++) {
    if (target <= seg[i] || i === seg.length - 1) {
      const t = seg[i] ? Math.min(1, target / seg[i]) : 1;
      return { lat: round6(pts[i].lat + (pts[i + 1].lat - pts[i].lat) * t), long: round6(pts[i].long + (pts[i + 1].long - pts[i].long) * t) };
    }
    target -= seg[i];
  }
  return pts[pts.length - 1];
}
const round6 = n => Math.round(n * 1e6) / 1e6;

/** Fraction (0..1) along the polyline of the point nearest pos: where a restarted simulator picks the rider up again. */
function fractionAt(path, pos) {
  const pts = path.map(p => ({ lat: Number(p.lat), long: Number(p.long) }));
  let total = 0, best = Infinity, at = 0;
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i], b = pts[i + 1], len = Math.hypot(b.lat - a.lat, b.long - a.long);
    const t = len ? Math.max(0, Math.min(1, ((pos.lat - a.lat) * (b.lat - a.lat) + (pos.long - a.long) * (b.long - a.long)) / len ** 2)) : 0;
    const d = Math.hypot(a.lat + t * (b.lat - a.lat) - pos.lat, a.long + t * (b.long - a.long) - pos.long);
    if (d < best) { best = d; at = total + t * len; }
    total += len;
  }
  return total ? at / total : 0;
}

function pathOf(s) {
  let via = [];
  try { via = typeof s.via === 'string' ? JSON.parse(s.via || '[]') : (s.via || []); } catch { via = []; }
  return [{ lat: s.fromLat, long: s.fromLong }, ...via, { lat: s.toLat, long: s.toLong }];
}

/** In-range temperature: centre of the band with small deterministic noise. */
function normalTemp(s, rnd = Math.random) {
  const min = Number(s.minC), max = Number(s.maxC);
  const mid = s.storageClass === 'AMBIENT' ? Math.min(max - 4, 24) : (min + max) / 2;
  const span = Math.min(1.2, (max - min) / 4);
  return Math.round((mid + (rnd() * 2 - 1) * span) * 10) / 10;
}

/** Out-of-range reading for the excursion. */
const excursionTemp = s => Math.round((Number(s.maxC) + 3.4) * 10) / 10;

/** Pick the shipment for the single deliberate excursion: first cold-chain one, else the first. */
function pickExcursionTarget(shipments) {
  return (shipments.find(s => s.storageClass !== 'AMBIENT') || shipments[0] || {}).ID || null;
}

/**
 * Stateful planner: one call per tick returns the readings to send.
 * opts: { excursion: bool, excursionAfterTicks, excursionTicks, speedup, intervalSec, now(), rnd() }
 */
function createPlanner(opts = {}) {
  const o = { excursion: true, excursionAfterTicks: 3, excursionTicks: 2, speedup: 10, intervalSec: 5, now: () => Date.now(), rnd: Math.random, ...opts };
  const progress = new Map();
  const state = { tick: 0, excursionId: null, excursionDone: false, excursionLeft: o.excursionTicks };
  return {
    state,
    next(shipments) {
      state.tick++;
      if (o.excursion && !state.excursionId && !state.excursionDone) state.excursionId = pickExcursionTarget(shipments);
      const out = [];
      for (const s of shipments) {
        const eta = Math.max(5, Number(s.etaMin) || 30) * 60000;
        if (!progress.has(s.ID)) {
          const started = s.pickedUpAt ? Date.parse(s.pickedUpAt) : o.now();
          // carry on from the last reported position (a restart must not send the rider back); a new delivery starts early on
          const resume = s.lastLat != null ? Math.min(1, fractionAt(pathOf(s), { lat: s.lastLat, long: s.lastLong })) : null;
          progress.set(s.ID, resume ?? Math.min(0.5, Math.max(0.02, (o.now() - started) / eta)));
        } else {
          progress.set(s.ID, Math.min(1, progress.get(s.ID) + // the rider parks at the drop and waits for the receiving pharmacy's scan
             (o.speedup * o.intervalSec * 1000) / eta));
        }
        const pos = interpolate(pathOf(s), progress.get(s.ID));
        let temperatureC = normalTemp(s, o.rnd);
        let excursion = false;
        if (s.ID === state.excursionId && !state.excursionDone && state.tick > o.excursionAfterTicks) {
          temperatureC = excursionTemp(s); excursion = true;
          if (--state.excursionLeft <= 0) state.excursionDone = true;
        }
        out.push({ transfer: s.ID, loggerId: s.loggerId, lat: pos.lat, long: pos.long, temperatureC, sealStatus: 'INTACT', progress: Math.round(progress.get(s.ID) * 100) / 100, excursion });
      }
      return out;
    },
  };
}

module.exports = { interpolate, fractionAt, pathOf, normalTemp, excursionTemp, pickExcursionTarget, createPlanner };
