'use strict';
/* Live delivery map on Leaflet 1.9 (vendor/leaflet): pickup and drop pins, the route, a trail of recent fixes and a
   rider marker that glides from fix to fix over the time gap between them (no jumps). Used by the journey screen and
   the courier page. OSM tiles: attribution always shown; each tile request sends only our origin as Referer (the tile
   usage policy requires one, while the page itself is Referrer-Policy: no-referrer). */
const TILE_URL = 'https://tile.openstreetmap.org/{z}/{x}/{y}.png'; // shortcut: OSM's free tiles are for light use; use a tile provider before real traffic
const TRAIL_MAX = 40;

/** opts: { origin:{name,lat,long}, destination:{...}, route:[[lat,long]], trail:[[lat,long]], position:{lat,long,at}|null, riderLabel } */
function liveMap(el, opts) {
  const map = L.map(el, { scrollWheelZoom: false, keyboard: true });
  L.tileLayer(TILE_URL, { maxZoom: 19, referrerPolicy: 'strict-origin', attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors' }).addTo(map);
  const ll = p => (p && p.lat != null ? [Number(p.lat), Number(p.long)] : null);
  const pin = (cls, letter) => L.divIcon({ className: `ml-pin ${cls}`, html: `<span>${letter}</span>`, iconSize: [30, 38], iconAnchor: [15, 38] });
  const from = ll(opts.origin), to = ll(opts.destination);
  if (from) L.marker(from, { icon: pin('from', 'A'), title: `Pickup: ${opts.origin.name || ''}`, alt: 'Pickup', keyboard: false }).addTo(map);
  if (to) L.marker(to, { icon: pin('to', 'B'), title: `Drop: ${opts.destination.name || ''}`, alt: 'Drop', keyboard: false }).addTo(map);
  const routeOf = r => (r?.length ? r : [from, to].filter(Boolean));
  const routeLine = L.polyline(routeOf(opts.route), { color: '#3B2218', weight: 5, opacity: 0.75, interactive: false }).addTo(map);
  const trailLine = L.polyline((opts.trail || []).slice(-TRAIL_MAX), { color: '#9B6446', weight: 4, opacity: 0.6, dashArray: '2 8', lineCap: 'round', interactive: false }).addTo(map);
  const riderIcon = L.divIcon({ className: 'ml-rider', html: '<span class="ring"></span><span class="dot"></span>', iconSize: [26, 26], iconAnchor: [13, 13] });
  let rider = null, lastFix = null, lastAt = 0, raf = 0;

  function fit() {
    const b = routeLine.getBounds();
    if (rider) b.extend(rider.getLatLng());
    if (b.isValid()) map.fitBounds(b, { padding: [32, 32], maxZoom: 16 }); else map.setView([12.97, 77.59], 12); // Bengaluru
  }
  /** New GPS fix: glide there over the time since the previous fix (clamped), leaving the previous fix on the trail. */
  function move(p) {
    const target = ll(p);
    if (!target) return;
    const now = performance.now();
    if (!rider) { rider = L.marker(target, { icon: riderIcon, title: opts.riderLabel || 'Courier', keyboard: false, zIndexOffset: 1000 }).addTo(map); lastFix = target; lastAt = now; return; }
    if (lastFix[0] === target[0] && lastFix[1] === target[1]) return;
    trailLine.addLatLng(lastFix);
    const pts = trailLine.getLatLngs(); if (pts.length > TRAIL_MAX) trailLine.setLatLngs(pts.slice(-TRAIL_MAX));
    const start = rider.getLatLng(), dur = reduced ? 0 : Math.min(15000, Math.max(800, now - lastAt));
    lastFix = target; lastAt = now;
    cancelAnimationFrame(raf);
    const step = t => {
      const k = dur ? Math.min(1, (t - now) / dur) : 1;
      rider.setLatLng([start.lat + (target[0] - start.lat) * k, start.lng + (target[1] - start.lng) * k]);
      if (k < 1) raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
  }
  if (opts.position) move(opts.position);
  fit();
  return {
    move,
    setRoute(r) { routeLine.setLatLngs(routeOf(r)); },
    refresh() { map.invalidateSize(); },
    destroy() { cancelAnimationFrame(raf); map.remove(); },
  };
}
