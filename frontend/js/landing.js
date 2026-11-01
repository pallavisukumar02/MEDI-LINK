(function () {
  'use strict';
  var $ = function (s, r) { return (r || document).querySelector(s); };
  var $$ = function (s, r) { return Array.prototype.slice.call((r || document).querySelectorAll(s)); };
  var reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
  var coarse = matchMedia('(hover: none)').matches;
  var cssVar = function (n) { return getComputedStyle(document.documentElement).getPropertyValue(n).trim(); };

  /* ---------- wordmark: guarantee one line ---------- */
  var wm = $('.wordmark');
  function fitWordmark() {
    wm.style.fontSize = '';
    var fs = parseFloat(getComputedStyle(wm).fontSize), n = 0;
    while (wm.scrollWidth > wm.clientWidth + 1 && n++ < 40) { fs *= 0.96; wm.style.fontSize = fs + 'px'; }
  }
  fitWordmark();
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(fitWordmark);
  var rz = 0;
  addEventListener('resize', function () { cancelAnimationFrame(rz); rz = requestAnimationFrame(fitWordmark); });

  /* ---------- nav active link ---------- */
  var links = $$('.nav-links a');
  var navIO = new IntersectionObserver(function (entries) {
    entries.forEach(function (e) {
      if (!e.isIntersecting) return;
      links.forEach(function (a) {
        if (a.getAttribute('href') === '#' + e.target.id) a.setAttribute('aria-current', 'true');
        else a.removeAttribute('aria-current');
      });
    });
  }, { rootMargin: '-45% 0px -50% 0px' });
  ['how', 'features', 'who'].forEach(function (id) { navIO.observe(document.getElementById(id)); });
  var heroIOnav = new IntersectionObserver(function (e) {
    if (e[0].isIntersecting) links.forEach(function (a) { a.removeAttribute('aria-current'); });
  }, { rootMargin: '-45% 0px -50% 0px' });
  heroIOnav.observe($('.hero'));

  /* ---------- modal ---------- */
  var dlg = $('#start'), form = $('#start-form'), view = $('#start-view'), done = $('#start-done'), opener = null;
  var rules = {
    name: function (v) { return v.trim() ? '' : 'Enter your name.'; },
    hospital: function (v) { return v.trim() ? '' : 'Enter your hospital.'; },
    role: function (v) { return v ? '' : 'Choose your role.'; },
    email: function (v) {
      v = v.trim();
      if (!v) return 'Enter your email.';
      return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v) ? '' : 'Enter a valid email, like name@hospital.org.';
    }
  };
  function check(el) {
    var msg = rules[el.name](el.value), err = document.getElementById('e-' + el.name);
    el.setAttribute('aria-invalid', msg ? 'true' : 'false');
    err.querySelector('span').textContent = msg;
    err.hidden = !msg;
    return !msg;
  }
  function openModal(btn) {
    opener = btn;
    form.reset();
    ['name', 'hospital', 'role', 'email'].forEach(function (n) {
      var el = form.elements[n]; el.removeAttribute('aria-invalid'); document.getElementById('e-' + n).hidden = true;
    });
    view.hidden = false; done.hidden = true;
    if (typeof dlg.showModal === 'function') dlg.showModal(); else dlg.setAttribute('open', '');
    $('#f-name').focus();
  }
  $$('[data-open]').forEach(function (b) { b.addEventListener('click', function () { openModal(b); }); });
  $$('[data-close]').forEach(function (b) { b.addEventListener('click', function () { dlg.close(); }); });
  dlg.addEventListener('click', function (e) { if (e.target === dlg) dlg.close(); });
  dlg.addEventListener('close', function () { if (opener) opener.focus(); });
  form.addEventListener('focusout', function (e) { if (rules[e.target.name] && e.target.value) check(e.target); });
  form.addEventListener('input', function (e) { if (e.target.getAttribute('aria-invalid') === 'true') check(e.target); });
  form.addEventListener('change', function (e) { if (e.target.tagName === 'SELECT') check(e.target); });
  form.addEventListener('submit', function (e) {
    e.preventDefault();
    var bad = ['name', 'hospital', 'role', 'email'].map(function (n) { return form.elements[n]; }).filter(function (el) { return !check(el); });
    if (bad.length) { bad[0].focus(); return; }
    $('#done-name').textContent = form.elements.name.value.trim();
    view.hidden = true; done.hidden = false;
    $('#done-title').focus();
  });
  // focus trap fallback for browsers where showModal does not trap Tab inside the page
  dlg.addEventListener('keydown', function (e) {
    if (e.key !== 'Tab') return;
    var f = $$('button, a[href], input, select', dlg).filter(function (el) { return el.offsetParent !== null; });
    if (!f.length) return;
    var first = f[0], last = f[f.length - 1];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  });

  /* ---------- how it works: bottle ---------- */
  var how = $('#how'), steps = $('.steps');
  function drawFlow() {
    var pts = $$('.step', steps).map(function (card) {
      var b = $('.badge', card);
      var cx = card.offsetLeft + card.offsetWidth / 2, cy = card.offsetTop + card.offsetHeight / 2;
      var bx = card.offsetLeft + b.offsetLeft + b.offsetWidth / 2 - cx, by = card.offsetTop + b.offsetTop + b.offsetHeight / 2 - cy;
      var a = (parseFloat(getComputedStyle(card).getPropertyValue('--tilt')) || 0) * Math.PI / 180;
      return { x: cx + bx * Math.cos(a) - by * Math.sin(a), y: cy + bx * Math.sin(a) + by * Math.cos(a), left: card.offsetLeft, r: b.offsetWidth / 2 };
    });
    var d = '';
    for (var i = 0; i < pts.length - 1; i++) {
      var p = pts[i], q = pts[i + 1], gx = Math.max(4, p.left - 14);
      d += 'M' + (p.x - p.r) + ' ' + p.y + 'H' + (gx + 8) + 'Q' + gx + ' ' + p.y + ' ' + gx + ' ' + (p.y + 8) +
           'V' + (q.y - 8) + 'Q' + gx + ' ' + q.y + ' ' + (gx + 8) + ' ' + q.y + 'H' + (q.x - q.r);
    }
    var fp = $('#flowpath'), mp = $('#flowmaskpath');
    fp.setAttribute('d', d); mp.setAttribute('d', d);
    var len = fp.getTotalLength() + 20;
    mp.style.strokeDasharray = len;
    if (!how.classList.contains('in') && !reduce) { mp.style.transition = 'none'; mp.style.strokeDashoffset = len; mp.getBoundingClientRect(); mp.style.transition = ''; }
    else mp.style.strokeDashoffset = 0;
  }
  drawFlow();
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(drawFlow);
  new ResizeObserver(function () { drawFlow(); }).observe(steps);
  var howIO = new IntersectionObserver(function (e) {
    if (!e[0].isIntersecting) return;
    how.classList.add('in');
    $('#flowmaskpath').style.strokeDashoffset = 0;
    setTimeout(function () { how.classList.add('settled'); }, 1300);
    howIO.disconnect();
  }, { threshold: 0.3 });
  if (reduce) { how.classList.add('in', 'settled'); drawFlow(); } else howIO.observe($('.bottle'));

  /* ---------- live tracking preview ---------- */
  (function () {
    var route = $('#route'), doneP = $('#route-done'), van = $('#van');
    var dist = $('#t-dist'), eta = $('#t-eta'), temp = $('#t-temp'), line = $('#t-line');
    var L = route.getTotalLength(), TOTAL_KM = 12.4, ETA_MIN = 26, LOOP = 20000;
    doneP.style.strokeDasharray = L;
    var hist = [], v = 5.1;
    for (var i = 0; i < 30; i++) { v = step(v); hist.push(v); }
    function step(x) { x += (Math.random() - 0.5) * 0.16 + (5.1 - x) * 0.08; return Math.min(5.4, Math.max(4.8, x)); }
    function drawChart() {
      line.setAttribute('points', hist.map(function (t, i) {
        return (22 + i * (176 / (hist.length - 1))).toFixed(1) + ',' + (18 + (8 - t) / 6 * 48).toFixed(1);
      }).join(' '));
      temp.textContent = hist[hist.length - 1].toFixed(1) + ' °C';
    }
    function place(p) {
      var pt = route.getPointAtLength(p * L);
      van.setAttribute('transform', 'translate(' + pt.x.toFixed(1) + ' ' + pt.y.toFixed(1) + ')');
      doneP.style.strokeDashoffset = L * (1 - p);
      dist.textContent = (TOTAL_KM * (1 - p)).toFixed(1) + ' km';
      eta.textContent = Math.ceil(ETA_MIN * (1 - p)) + ' min';
    }
    drawChart();
    if (reduce) { place(0.42); return; }
    var on = false, raf = 0, t0 = null, offset = 0, lastTemp = 0;
    function loop(now) {
      if (!on) { raf = 0; return; }
      if (t0 === null) t0 = now - offset;
      var el = now - t0; offset = el;
      place((el % LOOP) / LOOP);
      if (now - lastTemp > 1200) { lastTemp = now; hist.push(step(hist[hist.length - 1])); hist.shift(); drawChart(); }
      raf = requestAnimationFrame(loop);
    }
    place(0);
    new IntersectionObserver(function (e) {
      on = e[0].isIntersecting;
      if (on && !raf) { t0 = null; raf = requestAnimationFrame(loop); }
    }).observe($('.track'));
  })();

  /* ---------- hero 3D ---------- */
  var host = $('#scene'), canvas = $('#pack-canvas');
  function fallback() { host.classList.remove('ready'); $('.scene-caption').textContent = 'Illustrative blister pack'; canvas.hidden = true; }
  (function load() {
    var ok = false;
    try {
      var c = document.createElement('canvas'), gl = c.getContext('webgl') || c.getContext('experimental-webgl');
      ok = !!gl;
      var lose = gl && gl.getExtension('WEBGL_lose_context'); if (lose) lose.loseContext();
    } catch (e) { ok = false; }
    if (!ok) return fallback();
    var s = document.createElement('script');
    s.src = 'vendor/three/three.min.js'; // self-hosted r128, hash in vendor/README.md
    s.integrity = 'sha384-CI3ELBVUz9XQO+97x6nwMDPosPR5XvsxW2ua7N1Xeygeh1IxtgqtCkGfQY9WWdHu';
    s.onload = function () { try { init3D(); } catch (e) { fallback(); } };
    s.onerror = fallback;
    document.head.appendChild(s);
  })();

  var DATA = [
    ['Rituximab 500 mg', 'BLR-4127', '03/2027'],
    ['Trastuzumab 440 mg', 'BLR-2290', '08/2027'],
    ['Insulin glargine 100 U/mL', 'BLR-5813', '01/2028'],
    ['Epoetin alfa 4000 IU', 'BLR-3375', '06/2027'],
    ['Filgrastim 300 mcg', 'BLR-1046', '12/2026', true],
    ['Bevacizumab 400 mg', 'BLR-6602', '10/2027'],
    ['Oxytocin 10 IU', 'BLR-7158', '04/2027'],
    ['Adalimumab 40 mg', 'BLR-8831', '02/2028']
  ];

  function init3D() {
    var T = window.THREE, D = function (d) { return d * Math.PI / 180; };
    var col = function (n) { return new T.Color(cssVar(n)); };
    var renderer = new T.WebGLRenderer({ canvas: canvas, alpha: true, antialias: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.75));
    renderer.setClearColor(0x000000, 0);
    var scene = new T.Scene();
    var camera = new T.PerspectiveCamera(35, 1, 0.1, 200);
    scene.add(new T.HemisphereLight(col('--hi'), col('--lo'), 0.7));
    var key = new T.DirectionalLight(col('--hi'), 0.36);
    key.position.set(-6, 8, 10); scene.add(key);

    var PL = 6.8, PW = 2.6, PR = 0.5, R = 0.22, CL = 0.56, HA = 0.30, HR = 0.31, TOP = 0.27;
    var COLS = [-1.54, -0.18, 1.18, 2.54], ROWS = [0.62, -0.62];
    var HALF_X = 3.44, HALF_Y = 3.19, BASE_RX = -0.3, BASE_RY = 0.2;

    function roundRect(w, h, r) {
      var s = new T.Shape(), x = -w / 2, y = -h / 2;
      s.moveTo(x + r, y); s.lineTo(x + w - r, y); s.absarc(x + w - r, y + r, r, -Math.PI / 2, 0, false);
      s.lineTo(x + w, y + h - r); s.absarc(x + w - r, y + h - r, r, 0, Math.PI / 2, false);
      s.lineTo(x + r, y + h); s.absarc(x + r, y + h - r, r, Math.PI / 2, Math.PI, false);
      s.lineTo(x, y + r); s.absarc(x + r, y + r, r, Math.PI, Math.PI * 1.5, false);
      return s;
    }
    function stadium(p, cx, cy, a, r) {
      p.moveTo(cx - a, cy - r); p.lineTo(cx + a, cy - r); p.absarc(cx + a, cy, r, -Math.PI / 2, Math.PI / 2, false);
      p.lineTo(cx - a, cy + r); p.absarc(cx - a, cy, r, Math.PI / 2, Math.PI * 1.5, false);
      return p;
    }

    var floatG = new T.Group(), tiltG = new T.Group(), packG = new T.Group();
    scene.add(floatG); floatG.add(tiltG); tiltG.add(packG);
    packG.rotation.z = D(40);

    var outline = roundRect(PL, PW, PR);
    COLS.forEach(function (x) { ROWS.forEach(function (y) { outline.holes.push(stadium(new T.Path(), x, y, HA, HR)); }); });
    var pack = new T.Mesh(
      new T.ExtrudeGeometry(outline, { depth: 0.22, bevelEnabled: true, bevelThickness: 0.05, bevelSize: 0.05, bevelSegments: 3, curveSegments: 20 }),
      new T.MeshStandardMaterial({ color: col('--pack'), roughness: 0.55 }));
    packG.add(pack);
    var edge = new T.Mesh(new T.ShapeGeometry(roundRect(PL + 0.17, PW + 0.17, PR + 0.08), 20), new T.MeshStandardMaterial({ color: col('--lo'), roughness: 0.6 }));
    edge.position.z = -0.07; packG.add(edge);
    // soft top-left inner highlight, mapped in shape units
    var tc = document.createElement('canvas'); tc.width = 512; tc.height = 256;
    var g2 = tc.getContext('2d'), grd = g2.createRadialGradient(70, 50, 0, 70, 50, 330);
    grd.addColorStop(0, 'rgba(250,251,252,0.8)'); grd.addColorStop(0.4, 'rgba(250,251,252,0.25)'); grd.addColorStop(1, 'rgba(250,251,252,0)');
    g2.fillStyle = grd; g2.fillRect(0, 0, 512, 256);
    var tex = new T.CanvasTexture(tc); tex.repeat.set(1 / PL, 1 / PW); tex.offset.set(0.5, 0.5);
    var hiMesh = new T.Mesh(new T.ShapeGeometry(outline, 20), new T.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false }));
    hiMesh.position.z = TOP + 0.003; packG.add(hiMesh);
    var pocketMat = new T.MeshStandardMaterial({ color: col('--pocket'), roughness: 0.6 });
    COLS.forEach(function (x) { ROWS.forEach(function (y) {
      var m = new T.Mesh(new T.ShapeGeometry(stadium(new T.Shape(), x, y, HA + 0.03, HR + 0.03), 16), pocketMat);
      m.position.z = 0.02; packG.add(m);
    }); });

    // capsule geometry: cylinder halves + hemisphere ends (r128 has no CapsuleGeometry)
    var RL = R * 1.04;
    var G = {
      cylL: new T.CylinderGeometry(RL, RL, CL / 2, 40, 1, true).rotateZ(Math.PI / 2).translate(-CL / 4, 0, 0),
      hemL: new T.SphereGeometry(RL, 40, 14, 0, Math.PI * 2, 0, Math.PI / 2).rotateZ(Math.PI / 2).translate(-CL / 2, 0, 0),
      cylR: new T.CylinderGeometry(R, R, CL / 2, 40, 1, true).rotateZ(Math.PI / 2).translate(CL / 4, 0, 0),
      hemR: new T.SphereGeometry(R, 40, 14, 0, Math.PI * 2, 0, Math.PI / 2).rotateZ(-Math.PI / 2).translate(CL / 2, 0, 0),
      rim: new T.TorusGeometry(RL, 0.013, 8, 56).rotateY(Math.PI / 2),
      hl: new T.SphereGeometry(0.045, 12, 8).scale(2.8, 0.8, 0.45)
    };
    var gA = col('--greige'), gB = col('--greige-deep');
    [G.cylR, G.hemR].forEach(function (g) {
      var p = g.attributes.position, a = new Float32Array(p.count * 3), c = new T.Color();
      for (var i = 0; i < p.count; i++) {
        c.copy(gA).lerp(gB, Math.min(1, Math.max(0, p.getX(i) / (CL / 2 + R))));
        a[i * 3] = c.r; a[i * 3 + 1] = c.g; a[i * 3 + 2] = c.b;
      }
      g.setAttribute('color', new T.BufferAttribute(a, 3));
    });
    function makeCapsule(left) {
      var mL = new T.MeshStandardMaterial({ color: left, roughness: 0.4 });
      var mR = new T.MeshStandardMaterial({ vertexColors: true, roughness: 0.55 });
      var mRim = new T.MeshStandardMaterial({ color: col('--rim'), roughness: 0.5 });
      var mHl = new T.MeshBasicMaterial({ color: col('--hi'), transparent: true, opacity: 0.6, depthWrite: false });
      var grp = new T.Group();
      var meshes = [new T.Mesh(G.cylL, mL), new T.Mesh(G.hemL, mL), new T.Mesh(G.cylR, mR), new T.Mesh(G.hemR, mR), new T.Mesh(G.rim, mRim), new T.Mesh(G.hl, mHl)];
      meshes[5].position.set(-0.17, 0.1, 0.212);
      meshes.forEach(function (m) { grp.add(m); });
      return { group: grp, meshes: meshes, mats: [mL, mR, mRim], hlMat: mHl };
    }

    var caps = [], k = 0;
    COLS.forEach(function (x) { ROWS.forEach(function (y) {
      var d = DATA[k++], c = makeCapsule(d[3] ? col('--rb-light') : col('--rb'));
      c.home = new T.Vector3(x, y, 0.02 + R); c.data = d; c.state = 'home'; c.lift = 0; c.fade = 1;
      c.group.position.copy(c.home); packG.add(c.group);
      c.meshes.forEach(function (m) { m.userData.cap = c; });
      caps.push(c);
    }); });
    var pickables = [];
    caps.forEach(function (c) { pickables.push.apply(pickables, c.meshes.slice(0, 5)); });

    var loose = [[-3.1, -3.25, 0.5], [-2.15, -3.68, -0.35], [-1.15, -3.5, 0.22]].map(function (p, i) {
      var c = makeCapsule(col('--rb'));
      c.group.rotation.set(-0.35, 0.1, p[2]);
      scene.add(c.group);
      return { c: c, rel: p, ox: 0, oy: 0, vx: 0, vy: 0, delay: 0.42 + i * 0.14 };
    });

    // overlays
    var sticker = $('#sticker'), tip = $('#tip'), pin = $('#pin'), fchip = $('#fchip'), trail = $('#trail'), trailPath = $('#trail-path');
    var status = $('#pack-status');
    var W = 1, H = 1, visW = 1, visH = 1, baseX = 0, baseY = 0.2, floatAmp = 0;
    var pinW = new T.Vector3(), tmp = new T.Vector3(), sA = new T.Vector3(), sB = new T.Vector3();
    function toScreen(v) { tmp.copy(v).project(camera); return { x: (tmp.x + 1) / 2 * W, y: (1 - tmp.y) / 2 * H }; }
    function layout() {
      W = canvas.clientWidth; H = canvas.clientHeight;
      if (!W || !H) return;
      renderer.setSize(W, H, false);
      camera.aspect = W / H;
      visH = Math.max(2 * HALF_Y + 1.7, (2 * HALF_X * 0.94 + 1.4) / camera.aspect);
      visW = visH * camera.aspect;
      camera.position.set(0, 0, visH / 2 / Math.tan(D(17.5)));
      camera.updateProjectionMatrix();
      baseX = visW / 2 + 0.06 * 2 * HALF_X - HALF_X; // ~6% of the pack bleeds past the right edge
      floatAmp = 12 * visH / H;
      pinW.set(baseX - 0.25, baseY + 3.3, 0.5);
      var p = toScreen(pinW);
      pin.style.left = p.x + 'px'; pin.style.top = p.y + 'px';
      trail.setAttribute('viewBox', '0 0 ' + W + ' ' + H);
    }

    // interaction state
    var hovered = null, selected = null, kbd = false, flight = null, ptrType = 'mouse', over = false, cursorW = null, trailToken = 0;
    var ndc = new T.Vector2(), ray = new T.Raycaster(), plane = new T.Plane(new T.Vector3(0, 0, 1), -0.3), ptr = { x: 0, y: 0 };
    function setNdc(e) {
      var r = canvas.getBoundingClientRect();
      ndc.set((e.clientX - r.left) / r.width * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
      ray.setFromCamera(ndc, camera);
      cursorW = ray.ray.intersectPlane(plane, new T.Vector3());
    }
    function pick() {
      ray.setFromCamera(ndc, camera);
      var hits = ray.intersectObjects(pickables, false);
      for (var i = 0; i < hits.length; i++) { var c = hits[i].object.userData.cap; if (c && c.state === 'home') return c; }
      return null;
    }
    function setHover(c) {
      if (hovered === c) return;
      hovered = c;
      canvas.style.cursor = c && !kbd ? 'pointer' : '';
      if (!c) { tip.classList.remove('on'); return; }
      $('#tip-drug').textContent = c.data[0];
      $('#tip-batch').textContent = 'Batch ' + c.data[1];
      $('#tip-exp').textContent = 'Exp ' + c.data[2] + ' / 2-8 °C';
      $('#tip-flag').hidden = !c.data[3];
      tip.classList.add('on');
      if (kbd) status.textContent = (c.data[3] ? 'Expires soon. ' : '') + c.data[0] + ', batch ' + c.data[1] + ', expiry ' + c.data[2] + ', store at 2 to 8 °C. Illustrative data.' + (reduce ? '' : ' Press Enter to send.');
    }
    function placeTip() {
      if (!hovered) return;
      hovered.group.getWorldPosition(sA);
      var a = toScreen(sA), tw = tip.offsetWidth, th = tip.offsetHeight;
      var maxX = Math.min(host.clientWidth, innerWidth - host.getBoundingClientRect().left) - 12;
      var x = a.x + 30, y = a.y - th - 22;
      if (x + tw > maxX) x = a.x - tw - 30;
      x = Math.max(8, x); y = Math.max(8, y);
      tip.style.transform = 'translate(' + x.toFixed(1) + 'px,' + y.toFixed(1) + 'px)';
    }
    function placeSticker() {
      sA.set(-2.75, 0.45, TOP); sB.set(-1.75, 0.45, TOP);
      packG.localToWorld(sA); packG.localToWorld(sB);
      var a = toScreen(sA), b = toScreen(sB), ang = Math.atan2(b.y - a.y, b.x - a.x) * 180 / Math.PI;
      sticker.style.transform = 'translate(' + a.x.toFixed(1) + 'px,' + a.y.toFixed(1) + 'px) translate(-50%,-50%) rotate(' + (ang - 8).toFixed(1) + 'deg)';
    }
    function setOpacity(c, o, end) {
      c.mats.forEach(function (m) { m.opacity = o; if (end) { m.transparent = false; m.needsUpdate = true; } });
      c.hlMat.opacity = 0.6 * o;
    }
    function bez(f, t, out) {
      var u = 1 - t;
      return out.set(
        u * u * f.a.x + 2 * u * t * f.c.x + t * t * f.b.x,
        u * u * f.a.y + 2 * u * t * f.c.y + t * t * f.b.y,
        u * u * f.a.z + 2 * u * t * f.c.z + t * t * f.b.z);
    }
    function send(c) {
      if (reduce || flight || !c || c.state !== 'home') return;
      setHover(null); selected = null;
      c.state = 'flying'; c.lift = 0;
      scene.attach(c.group);
      var a = c.group.position.clone(), b = pinW.clone().add(new T.Vector3(0, 0.25, 0));
      var ctrl = a.clone().lerp(b, 0.5).add(new T.Vector3(-0.9, 1.6, 2.4));
      flight = { cap: c, a: a, b: b, c: ctrl, t: 0, pts: [] };
      for (var i = 0; i <= 48; i++) flight.pts.push(bez(flight, i / 48, new T.Vector3()));
      trailToken++; trail.classList.remove('fade');
      fchip.classList.add('on');
      if (kbd) status.textContent = 'Sending ' + c.data[0] + ' to the receiving hospital.';
    }
    function arrive() {
      var c = flight.cap, tok = trailToken;
      flight = null;
      c.state = 'gone'; c.group.visible = false;
      fchip.classList.remove('on');
      pin.classList.remove('pulse', 'delivered'); void pin.offsetWidth; pin.classList.add('pulse', 'delivered');
      setTimeout(function () { pin.classList.remove('delivered'); }, 2800);
      setTimeout(function () { if (tok === trailToken) trail.classList.add('fade'); }, 700);
      setTimeout(function () { if (tok === trailToken) trailPath.setAttribute('d', ''); }, 1600);
      if (kbd) status.textContent = 'Delivered in condition.';
      setTimeout(function () {
        packG.add(c.group);
        c.group.position.copy(c.home); c.group.rotation.set(0, 0, 0); c.group.scale.setScalar(1);
        c.lift = 0; c.fade = 0;
        c.mats.forEach(function (m) { m.transparent = true; m.opacity = 0; m.needsUpdate = true; });
        c.hlMat.opacity = 0; c.group.visible = true; c.state = 'fading';
      }, 6000);
    }

    canvas.tabIndex = 0;
    canvas.addEventListener('pointerdown', function (e) { ptrType = e.pointerType; });
    canvas.addEventListener('pointermove', function (e) { ptrType = e.pointerType; over = true; if (kbd) { kbd = false; } setNdc(e); });
    canvas.addEventListener('pointerleave', function () { over = false; cursorW = null; if (ptrType !== 'touch') setHover(null); });
    canvas.addEventListener('click', function (e) {
      setNdc(e); kbd = false;
      var c = pick();
      if (ptrType === 'touch') {
        if (c && c === selected) send(c);
        else { selected = c; setHover(c); }
      } else if (c) send(c);
    });
    canvas.addEventListener('keydown', function (e) {
      var avail = caps.filter(function (c) { return c.state === 'home'; });
      if (!avail.length) return;
      var i = avail.indexOf(hovered);
      if (e.key === 'ArrowRight' || e.key === 'ArrowDown') i = (i + 1) % avail.length;
      else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') i = (i - 1 + avail.length) % avail.length;
      else if ((e.key === 'Enter' || e.key === ' ') && hovered) { e.preventDefault(); send(hovered); return; }
      else if (e.key === 'Escape') { setHover(null); return; }
      else return;
      e.preventDefault(); kbd = true; setHover(null); setHover(avail[i]);
    });
    canvas.addEventListener('blur', function () { if (kbd) { setHover(null); kbd = false; } });
    addEventListener('pointermove', function (e) {
      if (e.pointerType !== 'mouse') return;
      ptr.x = e.clientX / innerWidth * 2 - 1; ptr.y = e.clientY / innerHeight * 2 - 1;
    }, { passive: true });

    function easeOutBack(x) { var c1 = 1.25, c3 = c1 + 1; return 1 + c3 * Math.pow(x - 1, 3) + c1 * Math.pow(x - 1, 2); }
    function easeOutBounce(x) {
      var n = 7.5625, d = 2.75;
      if (x < 1 / d) return n * x * x;
      if (x < 2 / d) return n * (x -= 1.5 / d) * x + 0.75;
      if (x < 2.5 / d) return n * (x -= 2.25 / d) * x + 0.9375;
      return n * (x -= 2.625 / d) * x + 0.984375;
    }
    function easeInOut(x) { return x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2; }

    var running = false, visible = true, raf = 0, last = 0, t0 = -1, rotX = 0, rotY = 0, readyDone = false;
    function frame(now) {
      raf = 0;
      if (!running) return;
      raf = requestAnimationFrame(frame);
      if (t0 < 0) { t0 = now; last = now; }
      var dt = Math.min(0.05, (now - last) / 1000), t = (now - t0) / 1000;
      last = now;

      var drop = reduce ? 0 : (1 - easeOutBack(Math.min(1, t / 0.6))) * 5;
      var fl = reduce ? 0 : Math.sin(t * Math.PI / 3) * floatAmp;
      floatG.position.set(baseX, baseY + fl + drop, 0);
      var tx = 0, ty = 0;
      if (!reduce) {
        if (coarse) { ty = D(6) * Math.sin(t * 0.45); tx = D(3) * Math.sin(t * 0.31); }
        else { ty = D(12) * ptr.x; tx = D(8) * ptr.y; }
      }
      var kk = 1 - Math.exp(-dt * 3.5);
      rotX += (tx - rotX) * kk; rotY += (ty - rotY) * kk;
      tiltG.rotation.set(BASE_RX + rotX, BASE_RY + rotY, 0);

      if (over && ptrType !== 'touch' && !kbd && !flight) setHover(pick());

      var kl = 1 - Math.exp(-dt * 14);
      caps.forEach(function (c) {
        if (c.state !== 'home' && c.state !== 'fading') return;
        c.lift += (((c === hovered && !reduce) ? 1 : 0) - c.lift) * kl;
        c.group.position.set(c.home.x, c.home.y, c.home.z + 0.6 * c.lift);
        c.group.rotation.set(0, 0, D(15) * c.lift);
        c.group.scale.setScalar(1 + 0.08 * c.lift);
        if (c.state === 'fading') {
          c.fade = Math.min(1, c.fade + dt / 0.7);
          setOpacity(c, c.fade, c.fade >= 1);
          if (c.fade >= 1) c.state = 'home';
        }
      });

      loose.forEach(function (l) {
        var grp = l.c.group, yOff = 0, spin = 0;
        if (!reduce) {
          var p = Math.min(1, Math.max(0, (t - l.delay) / 0.45));
          grp.visible = t >= l.delay;
          yOff = (1 - easeOutBounce(p)) * 4.5; spin = (1 - p) * Math.PI * 1.5;
          if (p >= 1) {
            var fx = -38 * l.ox - 6 * l.vx, fy = -38 * l.oy - 6 * l.vy;
            if (cursorW && over && ptrType !== 'touch') {
              var dx = grp.position.x - cursorW.x, dy = grp.position.y - cursorW.y, dd = Math.hypot(dx, dy);
              if (dd < 1.4 && dd > 1e-3) { var s = (1 - dd / 1.4) * 70; fx += dx / dd * s; fy += dy / dd * s; }
            }
            l.vx += fx * dt; l.vy += fy * dt; l.ox += l.vx * dt; l.oy += l.vy * dt;
          }
        }
        grp.position.set(baseX + l.rel[0] + l.ox, baseY + l.rel[1] + l.oy + yOff, 0.3);
        grp.rotation.z = l.rel[2] + spin + l.ox * 0.35;
      });

      if (flight) {
        var f = flight;
        f.t = Math.min(1, f.t + dt / 1.5);
        var e = easeInOut(f.t);
        bez(f, e, f.cap.group.position);
        f.cap.group.rotation.x += dt * 5;
        f.cap.group.scale.setScalar(1.08 - 0.5 * e);
      }

      renderer.render(scene, camera);

      placeSticker();
      placeTip();
      if (flight) {
        var n = Math.max(1, Math.round(easeInOut(flight.t) * 48)), d = '';
        for (var i = 0; i <= n; i++) { var q = toScreen(flight.pts[i]); d += (i ? 'L' : 'M') + q.x.toFixed(1) + ' ' + q.y.toFixed(1); }
        trailPath.setAttribute('d', d);
        var cp = toScreen(flight.cap.group.position);
        fchip.style.transform = 'translate(' + (cp.x + 18).toFixed(1) + 'px,' + (cp.y - 40).toFixed(1) + 'px)';
        if (flight.t >= 1) arrive();
      }
      if (!readyDone) { readyDone = true; host.classList.add('ready'); }
    }
    function sync() {
      running = visible && !document.hidden;
      if (running && !raf) { last = performance.now(); raf = requestAnimationFrame(frame); }
    }
    layout();
    new ResizeObserver(layout).observe(host);
    new IntersectionObserver(function (e) { visible = e[0].isIntersecting; sync(); }).observe(host);
    document.addEventListener('visibilitychange', sync);
    sync();
  }
})();
