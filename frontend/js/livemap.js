'use strict';
/* Live delivery map on Leaflet 1.9 (vendor/leaflet): teardrop A/B pins, the route split at the rider into done (solid
   ink) and to go (marching dots), a trail of recent fixes and a rider marker (pulsing ring + heading) that glides from
   fix to fix over the time gap between them (no jumps). Used by the journey screen and the courier page; the toned
   tiles, ants and pulse live in css/viz.css (app only), the courier page gets the same marks without the extras.
   OSM tiles: attribution always shown; each tile request sends only our origin as Referer (the tile usage policy
   requires one, while the page itself is Referrer-Policy: no-referrer). */
const TILE_URL = 'https://tile.openstreetmap.org/{z}/{x}/{y}.png'; // shortcut: OSM's free tiles are for light use; use a tile provider before real traffic
const TRAIL_MAX = 40;
const PIN_PATH = 'M18 2C9.2 2 2 9 2 17.6 2 29 18 44 18 44s16-15 16-26.4C34 9 26.8 2 18 2Z'; // the landing's teardrop

/** opts: { origin:{name,lat,long}, destination:{...}, route:[[lat,long]], trail:[[lat,long]], position:{lat,long,at}|null, riderLabel } */
function liveMap(el, opts) {
  el.classList.add('ml-map');
  const map = L.map(el, { scrollWheelZoom: false, keyboard: true });
  L.tileLayer(TILE_URL, { maxZoom: 19, referrerPolicy: 'strict-origin', attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors' }).addTo(map);
  const ll = p => (p && p.lat != null ? [Number(p.lat), Number(p.long)] : null);
  const pin = (letter, fill) => L.divIcon({
    className: 'ml-pin', iconSize: [32, 41], iconAnchor: [16, 40],
    html: `<svg viewBox="0 0 36 46" width="32" height="41" aria-hidden="true"><path d="${PIN_PATH}" fill="${fill}" stroke="#fff" stroke-width="2"/><circle cx="18" cy="17.5" r="9.5" fill="#F2F3F5"/><text x="18" y="22" text-anchor="middle" font-family="DM Mono, monospace" font-weight="500" font-size="13" fill="${fill}">${letter}</text></svg>`,
  });
  const from = ll(opts.origin), to = ll(opts.destination);
  if (from) L.marker(from, { icon: pin('A', '#9B6446'), title: `Pickup: ${opts.origin.name || ''}`, alt: 'Pickup', keyboard: false }).addTo(map);
  if (to) L.marker(to, { icon: pin('B', '#3B2218'), title: `Drop: ${opts.destination.name || ''}`, alt: 'Drop', keyboard: false }).addTo(map);
  const routeOf = r => (r?.length ? r : [from, to].filter(Boolean));
  let route = routeOf(opts.route);
  const routeBase = L.polyline(route, { color: '#fff', weight: 9, opacity: 0.9, interactive: false }).addTo(map); // white casing under both halves
  const doneLine = L.polyline([], { color: '#3B2218', weight: 5, opacity: 0.9, lineCap: 'round', interactive: false }).addTo(map);
  const togoLine = L.polyline(route, { color: '#3B2218', weight: 4.5, opacity: 0.8, dashArray: '1 9', lineCap: 'round', className: 'ml-ants', interactive: false }).addTo(map);
  const trailLine = L.polyline((opts.trail || []).slice(-TRAIL_MAX), { color: '#9B6446', weight: 3, opacity: 0.45, dashArray: '2 8', lineCap: 'round', interactive: false }).addTo(map);
  const riderIcon = L.divIcon({ className: 'ml-rider', html: '<span class="ring"></span><span class="pulse"></span><span class="hd none"></span><span class="dot"></span>', iconSize: [26, 26], iconAnchor: [13, 13] });
  let rider = null, lastFix = null, lastAt = 0, raf = 0;

  /** Split the route at the rider: nearest segment, done up to the rider, to go after; the arrow follows that segment. */
  function split(pos) {
    if (!pos || route.length < 2) { doneLine.setLatLngs([]); togoLine.setLatLngs(route); return; }
    let best = Infinity, bi = 0;
    for (let i = 0; i < route.length - 1; i++) {
      const [ax, ay] = route[i], dx = route[i + 1][0] - ax, dy = route[i + 1][1] - ay, L2 = dx * dx + dy * dy;
      const t = L2 ? Math.max(0, Math.min(1, ((pos[0] - ax) * dx + (pos[1] - ay) * dy) / L2)) : 0;
      const d = (ax + t * dx - pos[0]) ** 2 + (ay + t * dy - pos[1]) ** 2;
      if (d < best) { best = d; bi = i; }
    }
    doneLine.setLatLngs([...route.slice(0, bi + 1), pos]);
    togoLine.setLatLngs([pos, ...route.slice(bi + 1)]);
    const [a, b] = [route[bi], route[bi + 1]];
    const deg = (Math.atan2((b[1] - a[1]) * Math.cos((a[0] * Math.PI) / 180), b[0] - a[0]) * 180) / Math.PI;
    const hd = rider?.getElement()?.querySelector('.hd');
    if (hd) { hd.classList.remove('none'); hd.style.setProperty('--hd', `${deg.toFixed(1)}deg`); }
  }
  function fit() {
    const b = routeBase.getBounds();
    if (rider) b.extend(rider.getLatLng());
    if (b.isValid()) map.fitBounds(b, { padding: [32, 32], maxZoom: 16 }); else map.setView([12.97, 77.59], 12); // Bengaluru
  }
  /** New GPS fix: glide there over the time since the previous fix (clamped), leaving the previous fix on the trail. */
  function move(p) {
    const target = ll(p);
    if (!target) return;
    const now = performance.now();
    if (!rider) { rider = L.marker(target, { icon: riderIcon, title: opts.riderLabel || 'Courier', keyboard: false, zIndexOffset: 1000 }).addTo(map); lastFix = target; lastAt = now; split(target); return; }
    if (lastFix[0] === target[0] && lastFix[1] === target[1]) return;
    trailLine.addLatLng(lastFix);
    const pts = trailLine.getLatLngs(); if (pts.length > TRAIL_MAX) trailLine.setLatLngs(pts.slice(-TRAIL_MAX));
    const start = rider.getLatLng(), dur = reduced ? 0 : Math.min(15000, Math.max(800, now - lastAt));
    lastFix = target; lastAt = now;
    cancelAnimationFrame(raf);
    const step = t => {
      const k = dur ? Math.min(1, (t - now) / dur) : 1;
      const at = [start.lat + (target[0] - start.lat) * k, start.lng + (target[1] - start.lng) * k];
      rider.setLatLng(at); split(at);
      if (k < 1) raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
  }
  // pause the marching ants and the pulse while the map is offscreen
  const io = 'IntersectionObserver' in window ? new IntersectionObserver(([e]) => el.classList.toggle('ml-paused', !e.isIntersecting)) : null;
  io?.observe(el);
  if (opts.position) move(opts.position);
  fit();
  if (lastFix) split(lastFix); // the marker's DOM only exists once the map has a view
  return {
    move,
    setRoute(r) { route = routeOf(r); routeBase.setLatLngs(route); split(rider ? [rider.getLatLng().lat, rider.getLatLng().lng] : null); },
    refresh() { map.invalidateSize(); },
    destroy() { cancelAnimationFrame(raf); io?.disconnect(); map.remove(); },
  };
}
