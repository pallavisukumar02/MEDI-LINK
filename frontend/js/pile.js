'use strict';
/* The tablet pile inside the sign-in / onboarding bottle: Three.js r128 (vendor/three) with an SVG fallback. Uses reduced/coarse from ui.js. */
// ================================================================= THE TABLET PILE (inside the bottle)
const PILL_COLOURS = ['#F4A7B9', '#F7B89A', '#F5D77E', '#A9DFC1', '#9CCBF0', '#A9B4F2', '#CDAAF0'];
function rng(seed) { return () => { seed |= 0; seed = (seed + 0x6D2B79F5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }

/** Deterministic pile layout in a 10-unit-wide box: base layer wall to wall, a deeper middle, 2-3 pieces leaning on each wall. */
function pileLayout() {
  const r = rng(7031), kinds = ['round', 'oval', 'capsule', 'half'];
  const pieces = [];
  // colours cycle so every tint shows up; shapes and rotations stay random
  const add = (x, layer, lean) => { const n = pieces.length; pieces.push({ x, layer, lean, kind: kinds[Math.floor(r() * kinds.length)], c1: PILL_COLOURS[(n * 3) % 7], c2: PILL_COLOURS[(n * 3 + 2) % 7], rot: r() * Math.PI * 2, tilt: 0.6 + r() * 0.8, seed: r() }); };
  for (let i = 0; i < 7; i++) add(-3.9 + i * 1.3 + (r() - 0.5) * 0.4, 0, 0);                     // base layer, wall to wall
  for (let i = 0; i < 5; i++) add(-2.9 + i * 1.45 + (r() - 0.5) * 0.4, 1, 0);                   // second layer
  add(-0.9 + r() * 0.4, 2, 0); add(0.6 + r() * 0.4, 2, 0);                                        // top of the mound (deeper middle)
  add(-4.45, 1, -1); add(-4.2, 2, -1); add(4.45, 1, 1); add(4.25, 2, 1);                          // leaning on the walls
  return pieces;
}

/** Flat SVG version of the same pile (shown while loading, and if WebGL is unavailable). */
function pileSvg(w, h) {
  const unit = w / 10, floorY = h - 6, L = pileLayout();
  const layerY = [0, 0.42, 0.8];
  const shape = (p, i) => {
    const cx = (p.x + 5) * unit, cy = floorY - (layerY[p.layer] + 0.28) * unit - (p.lean ? 0.15 * unit : 0);
    const rot = p.lean ? -p.lean * 62 : (p.rot * 57.3) % 40 - 20;
    const s = unit, stroke = 'rgba(38,20,13,0.18)';
    let g;
    if (p.kind === 'capsule') g = `<g><path d="M${-0.62 * s},0 a${0.24 * s},${0.24 * s} 0 0 1 ${0.24 * s},${-0.24 * s} h${0.38 * s} v${0.48 * s} h${-0.38 * s} a${0.24 * s},${0.24 * s} 0 0 1 ${-0.24 * s},${-0.24 * s}z" fill="${p.c1}" stroke="${stroke}"/><path d="M0,${-0.24 * s} h${0.38 * s} a${0.24 * s},${0.24 * s} 0 0 1 0,${0.48 * s} h${-0.38 * s}z" fill="${p.c2}" stroke="${stroke}"/></g>`;
    else if (p.kind === 'half') g = `<path d="M${-0.6 * s},${0.18 * s} a${0.6 * s},${0.6 * s} 0 0 1 ${1.2 * s},0z" fill="${p.c1}" stroke="${stroke}"/>`;
    else g = `<ellipse rx="${(p.kind === 'oval' ? 0.64 : 0.56) * s}" ry="${0.26 * s}" fill="${p.c1}" stroke="${stroke}"/><ellipse rx="${(p.kind === 'oval' ? 0.5 : 0.42) * s}" ry="${0.12 * s}" cy="${-0.05 * s}" fill="rgba(255,255,255,0.35)"/>`;
    return `<g transform="translate(${cx.toFixed(1)} ${cy.toFixed(1)}) rotate(${rot.toFixed(1)})">${g}</g>`;
  };
  return `<svg viewBox="0 0 ${w} ${h}" preserveAspectRatio="xMidYMax meet" aria-hidden="true">${L.map(shape).join('')}</svg>`;
}

function mountPile(clip, bottle, { interactive }) {
  const api = { wiggle() {}, hop() {}, jostle() {}, destroy() {} };
  const third = () => clip.style.setProperty('--third', `${Math.round(bottle.getBoundingClientRect().height / 3)}px`);
  third();
  const drawSvg = () => { const r = clip.getBoundingClientRect(); const old = clip.querySelector('svg'); const svg = pileSvg(Math.max(r.width, 10), Math.max(r.height, 10)); if (old) old.outerHTML = svg; else clip.insertAdjacentHTML('afterbegin', svg); };
  drawSvg();
  let resizeFn = null; // set once WebGL is up
  const ro = new ResizeObserver(() => { third(); drawSvg(); resizeFn?.(); });
  ro.observe(bottle);
  api.destroy = () => ro.disconnect();
  if (typeof THREE === 'undefined') return api;

  let renderer;
  try { renderer = new THREE.WebGLRenderer({ alpha: true, antialias: true }); } catch { return api; }
  if (!renderer.getContext()) return api;
  renderer.setPixelRatio(Math.min(devicePixelRatio || 1, 1.75));
  renderer.setClearColor(0x000000, 0);
  const canvas = renderer.domElement;
  canvas.setAttribute('aria-hidden', 'true');
  clip.appendChild(canvas);

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(35, 1, 0.1, 100);
  scene.add(new THREE.HemisphereLight(0xffffff, 0xcfc4bd, 0.8));
  const key = new THREE.DirectionalLight(0xffffff, 0.55); key.position.set(-4, 7, 6); scene.add(key);
  const heap = new THREE.Group(); scene.add(heap);

  const mat = c => new THREE.MeshStandardMaterial({ color: new THREE.Color(c), roughness: 0.5, metalness: 0 });
  const seamMat = new THREE.MeshStandardMaterial({ color: 0xe9e2dd, roughness: 0.6 });
  function roundTablet(c, sx = 1) {
    const r = 0.56, h = 0.26, e = 0.1, pts = [new THREE.Vector2(0, h / 2)];
    for (let i = 0; i <= 8; i++) { const a = Math.PI / 2 - (i / 8) * (Math.PI / 2); pts.push(new THREE.Vector2(r - e + e * Math.cos(a), h / 2 - e + e * Math.sin(a))); }
    for (let i = 0; i <= 8; i++) { const a = -(i / 8) * (Math.PI / 2); pts.push(new THREE.Vector2(r - e + e * Math.cos(a), -h / 2 + e + e * Math.sin(a))); }
    pts.push(new THREE.Vector2(0, -h / 2));
    const m = new THREE.Mesh(new THREE.LatheGeometry(pts, 36), mat(c));
    m.scale.set(sx, 1, sx > 1 ? 0.86 : 1);
    return m;
  }
  function capsule(c1, c2) {
    const g = new THREE.Group(), r = 0.25, L = 0.76;
    const half = (c, side) => {
      const body = new THREE.Mesh(new THREE.CylinderGeometry(r, r, L / 2, 28), mat(c)); body.rotation.z = Math.PI / 2; body.position.x = side * L / 4;
      const end = new THREE.Mesh(new THREE.SphereGeometry(r, 28, 14, 0, Math.PI * 2, 0, Math.PI / 2), mat(c)); end.rotation.z = -side * Math.PI / 2; end.position.x = side * L / 2;
      g.add(body, end);
    };
    half(c1, -1); half(c2, 1);
    const seam = new THREE.Mesh(new THREE.CylinderGeometry(r * 1.015, r * 1.015, 0.02, 28), seamMat); seam.rotation.z = Math.PI / 2; g.add(seam);
    return g;
  }
  function halfMoon(c) {
    const s = new THREE.Shape(); s.absarc(0, 0, 0.6, 0, Math.PI, false); s.lineTo(0.6, 0);
    const geo = new THREE.ExtrudeGeometry(s, { depth: 0.16, bevelEnabled: true, bevelThickness: 0.06, bevelSize: 0.06, bevelSegments: 4, curveSegments: 28 });
    geo.center();
    return new THREE.Mesh(geo, mat(c));
  }

  // pieces at rest, placed on a height map so the pile is deeper in the middle
  const W = 10, layout = pileLayout(), pieces = [];
  let floorY = -1, ceilY = 1;
  const meshes = [];
  for (const p of layout) {
    const obj = p.kind === 'capsule' ? capsule(p.c1, p.c2) : p.kind === 'half' ? halfMoon(p.c1) : roundTablet(p.c1, p.kind === 'oval' ? 1.18 : 1);
    if (p.lean) obj.rotation.set(0.2, (p.seed - 0.5) * 0.6, -p.lean * (p.kind === 'capsule' ? 1.05 : 0.95));
    else if (p.kind === 'capsule') obj.rotation.set(p.seed * 0.8, (p.seed - 0.5) * 1.2, (p.rot % 0.9) - 0.45);
    else if (p.kind === 'half') obj.rotation.set(-0.35 + p.seed * 0.5, (p.seed - 0.5) * 0.8, (p.rot % 0.8) - 0.4);
    else obj.rotation.set(p.tilt, 0, (p.rot % 0.9) - 0.45);
    obj.traverse(o => { o.userData.piece = pieces.length; });
    heap.add(obj); meshes.push(obj);
    pieces.push({ p, obj, rest: new THREE.Vector3(), restRot: obj.rotation.clone(), pos: new THREE.Vector3(), vel: new THREE.Vector3(), spin: 0, spinV: 0, lift: 0, half: new THREE.Vector3(), delay: 0, live: false });
  }
  function settle() {
    const bins = 40, height = new Array(bins).fill(0), idx = x => Math.max(0, Math.min(bins - 1, Math.floor((x + W / 2) / W * bins)));
    const box = new THREE.Box3(), size = new THREE.Vector3();
    const order = pieces.map((_, i) => i).sort((a, b) => pieces[a].p.layer - pieces[b].p.layer);
    for (const i of order) {
      const q = pieces[i]; q.obj.position.set(0, 0, 0); q.obj.updateMatrixWorld(true);
      box.setFromObject(q.obj).getSize(size); q.half.copy(size).multiplyScalar(0.5);
      const x = Math.max(-W / 2 + q.half.x + 0.02, Math.min(W / 2 - q.half.x - 0.02, q.p.x));
      let top = 0; for (let b = idx(x - q.half.x * 0.7); b <= idx(x + q.half.x * 0.7); b++) top = Math.max(top, height[b]);
      const y = floorY + top + q.half.y;
      for (let b = idx(x - q.half.x * 0.7); b <= idx(x + q.half.x * 0.7); b++) height[b] = top + size.y * 0.82;
      q.rest.set(x, y, (q.p.seed - 0.5) * 0.9);
    }
  }
  let w = 1, h = 1, visH = 2;
  function resize() {
    const r = clip.getBoundingClientRect();
    w = Math.max(r.width, 10); h = Math.max(r.height, 10);
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    visH = W / camera.aspect;
    const d = visH / 2 / Math.tan(THREE.MathUtils.degToRad(35 / 2)); // world width W spans the inner glass at z = 0
    camera.position.set(0, 0.35, d); camera.lookAt(0, 0, 0); camera.updateProjectionMatrix();
    floorY = -visH / 2 + 0.06; ceilY = visH / 2 - 0.1;
    settle();
    for (const q of pieces) if (!q.live || reduced) q.pos.copy(q.rest);
    heap.position.set(0, 0, 0);
    draw();
  }

  // pointer (on window; the canvas ignores pointer events)
  const ptr = { nx: 0, ny: 0, inside: false, world: new THREE.Vector3(), active: false };
  const ray = new THREE.Raycaster(), ndc = new THREE.Vector2(), plane = new THREE.Plane(new THREE.Vector3(0, 0, 1), 0);
  let hovered = -1;
  function onMove(e) {
    ptr.nx = (e.clientX / innerWidth) * 2 - 1; ptr.ny = (e.clientY / innerHeight) * 2 - 1; ptr.active = true;
    const r = canvas.getBoundingClientRect();
    ptr.inside = e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top - 40 && e.clientY <= r.bottom;
    ndc.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
    ray.setFromCamera(ndc, camera);
    ray.ray.intersectPlane(plane, ptr.world);
    hovered = -1;
    if (ptr.inside) { const hit = ray.intersectObjects(meshes, true)[0]; if (hit) hovered = hit.object.userData.piece; }
  }
  const onLeave = () => { ptr.inside = false; hovered = -1; };

  // simple physics: spring to rest (k 0.08, damping 0.85), repel near the pointer, clamp to the glass
  const K = 0.08, D = 0.85, R = 1.5;
  let running = false, raf = 0, t0 = performance.now(), visible = true;
  function step(now) {
    const t = (now - t0) / 1000;
    const tx = coarse ? Math.sin(t * 0.5) * 0.08 : ptr.active ? ptr.nx * THREE.MathUtils.degToRad(10) : 0;
    const ty = coarse ? Math.sin(t * 0.37) * 0.04 : ptr.active ? ptr.ny * THREE.MathUtils.degToRad(6) : 0;
    heap.rotation.y += (tx - heap.rotation.y) * 0.06;
    heap.rotation.x += (ty - heap.rotation.x) * 0.06;
    pieces.forEach((q, i) => {
      if (!q.live) { if (t * 1000 >= q.delay) { q.live = true; q.obj.visible = true; } else { q.obj.visible = false; return; } }
      q.vel.x = (q.vel.x + (q.rest.x - q.pos.x) * K) * D;
      q.vel.y = (q.vel.y + (q.rest.y - q.pos.y) * K) * D;
      q.vel.z = (q.vel.z + (q.rest.z - q.pos.z) * K) * D;
      if (ptr.inside && !coarse) {
        const dx = q.pos.x - ptr.world.x, dy = q.pos.y - ptr.world.y, dist = Math.hypot(dx, dy) || 0.001;
        if (dist < R) { const f = (1 - dist / R) * 0.05; q.vel.x += (dx / dist) * f; q.vel.y += Math.abs(dy / dist) * f * 0.6 + f * 0.25; q.spinV += f * 0.4 * (dx > 0 ? 1 : -1); }
      }
      q.pos.add(q.vel);
      const hx = Math.min(q.half.x, 0.7), hy = Math.min(q.half.y, 0.6);
      q.pos.x = Math.max(-W / 2 + hx, Math.min(W / 2 - hx, q.pos.x));
      if (q.pos.y < floorY + hy) { q.pos.y = floorY + hy; q.vel.y = Math.abs(q.vel.y) * 0.35; }
      q.pos.y = Math.min(ceilY - hy, q.pos.y);
      q.spinV *= 0.9; q.spin = (q.spin + q.spinV) * 0.94;
      q.lift += ((hovered === i && !coarse ? 1 : 0) - q.lift) * 0.15;
      q.obj.position.set(q.pos.x, q.pos.y + q.lift * 0.3, q.pos.z);
      q.obj.rotation.set(q.restRot.x, q.restRot.y, q.restRot.z + q.spin + q.lift * 0.26);
      q.obj.scale.setScalar(1 + q.lift * 0.06);
    });
    renderer.render(scene, camera);
    if (running) raf = requestAnimationFrame(step);
  }
  function draw() { if (!running) { pieces.forEach(q => { q.obj.visible = q.live || reduced; q.obj.position.copy(q.pos); }); renderer.render(scene, camera); } }
  function start() { if (running || reduced || !visible || document.hidden) return; running = true; raf = requestAnimationFrame(step); }
  function stop() { running = false; cancelAnimationFrame(raf); }

  resizeFn = resize;
  resize();
  // entry: pieces drop in with a small bounce, staggered (about 900 ms)
  pieces.forEach((q, i) => { q.delay = reduced ? 0 : 40 + i * 28; q.pos.copy(q.rest); if (!reduced) { q.pos.y += 3.2 + (i % 4) * 0.3; q.live = false; } else q.live = true; });
  clip.classList.add('webgl');
  if (reduced) { draw(); } else start();

  const io = new IntersectionObserver(es => { visible = es[0].isIntersecting; visible ? start() : stop(); });
  io.observe(clip);
  const onVis = () => (document.hidden ? stop() : start());
  document.addEventListener('visibilitychange', onVis);
  if (interactive && !reduced) { addEventListener('pointermove', onMove, { passive: true }); document.addEventListener('pointerleave', onLeave); }

  const kick = (fx, fy, fs) => pieces.forEach(q => { q.vel.x += (Math.random() - 0.5) * fx; q.vel.y += fy * (0.6 + Math.random() * 0.6); q.spinV += (Math.random() - 0.5) * fs; });
  api.wiggle = () => { if (!reduced) kick(0.08, 0.04, 0.12); };
  api.hop = () => { if (!reduced) kick(0.04, 0.28, 0.2); };
  api.jostle = () => { if (!reduced) kick(0.22, 0.2, 0.4); };
  api.destroy = () => {
    stop(); io.disconnect(); ro.disconnect();
    document.removeEventListener('visibilitychange', onVis);
    removeEventListener('pointermove', onMove); document.removeEventListener('pointerleave', onLeave);
    renderer.dispose(); scene.traverse(o => { o.geometry?.dispose?.(); o.material?.dispose?.(); });
  };
  return api;
}
