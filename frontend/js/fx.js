'use strict';
/* MediLink interaction effects for the signed-in app: pane spotlight, hero tilt, count-up numbers, staggered entrances,
   view transitions between routes, squishy buttons with a ripple, capsule confetti on milestones, and pausing loops
   that are off-screen or in a hidden tab. Everything is skipped under prefers-reduced-motion (`reduced`, ui.js). */

const fxFine = matchMedia('(hover: hover) and (pointer: fine)').matches;
const fxNF = new Intl.NumberFormat('en-IN');

// ---------------------------------------------------------------- spotlight: one delegated listener, the pane under the pointer gets --mx/--my
if (fxFine && !reduced) {
  addEventListener('pointermove', e => {
    const p = e.target.closest?.('.pane');
    if (!p) return;
    const r = p.getBoundingClientRect();
    p.style.setProperty('--mx', `${e.clientX - r.left}px`);
    p.style.setProperty('--my', `${e.clientY - r.top}px`);
  }, { passive: true });
}

/** Tilt (at most 3°) that follows the pointer; hero pane only. Returns a cleanup. */
function tilt(el) {
  if (!el || !fxFine || reduced) return () => {};
  const move = e => {
    const r = el.getBoundingClientRect(), x = (e.clientX - r.left) / r.width - 0.5, y = (e.clientY - r.top) / r.height - 0.5;
    el.style.transform = `perspective(1400px) rotateX(${(-y * 6).toFixed(2)}deg) rotateY(${(x * 6).toFixed(2)}deg)`;
  };
  const leave = () => { el.style.transform = ''; };
  el.addEventListener('pointermove', move);
  el.addEventListener('pointerleave', leave);
  return () => { el.removeEventListener('pointermove', move); el.removeEventListener('pointerleave', leave); };
}

// ---------------------------------------------------------------- numbers
/** Markup for a number that counts up once in view: the animated digits are aria-hidden, the final value is in .sr-only. */
const countHtml = n => {
  const v = Number(n) || 0, f = fxNF.format(v);
  return `<span class="cu" data-count="${v}" aria-hidden="true">${reduced ? f : '0'}</span><span class="sr-only">${f}</span>`;
};
function countUp(el, to) {
  if (reduced || !to) { el.textContent = fxNF.format(to); return; }
  const t0 = performance.now();
  const step = t => {
    const k = Math.min(1, (t - t0) / 900);
    el.textContent = fxNF.format(Math.round(to * (k === 1 ? 1 : 1 - 2 ** (-10 * k))));
    if (k < 1) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

// ---------------------------------------------------------------- per-render wiring: stagger, count-ups, live fills, loop pausing
/** Call after a signed-in view renders into root. quiet = a background refresh (no entrance, numbers final). */
function fxMount(root, quiet) {
  root.querySelectorAll('.rise').forEach((el, i) => el.style.setProperty('--i', Math.min(i, 12)));
  root.querySelectorAll('.drop').forEach(el => el.style.setProperty('--j', [...el.parentNode.children].indexOf(el)));
  root.querySelectorAll('[data-fill]').forEach(el => el.style.setProperty('--fill', Math.max(0.06, Math.min(1, Number(el.dataset.fill) || 0))));
  const io = 'IntersectionObserver' in window ? new IntersectionObserver(entries => {
    for (const e of entries) {
      const el = e.target;
      if (el.dataset.count !== undefined) { if (e.isIntersecting) { io.unobserve(el); countUp(el, Number(el.dataset.count)); } }
      else el.classList.toggle('paused', !e.isIntersecting);
    }
  }) : null;
  root.querySelectorAll('[data-count]').forEach(el => (quiet || !io ? (el.textContent = fxNF.format(Number(el.dataset.count))) : io.observe(el)));
  root.querySelectorAll('[data-loop]').forEach(el => io?.observe(el));
  return () => io?.disconnect();
}
document.addEventListener('visibilitychange', () => document.documentElement.classList.toggle('tab-hidden', document.hidden));

// ---------------------------------------------------------------- view transitions between signed-in routes
async function withTransition(fn) {
  if (!document.startViewTransition || reduced) return fn();
  const vt = document.startViewTransition(fn);
  vt.ready.catch(() => {}); vt.finished.catch(() => {});
  return vt.updateCallbackDone;
}

// ---------------------------------------------------------------- buttons: squish on press, ripple on the brown pills
addEventListener('pointerdown', e => {
  const b = e.target.closest?.('.route-app .btn');
  if (!b || b.disabled || reduced) return;
  b.classList.add('press');
  if (!b.classList.contains('ghost')) {
    const r = b.getBoundingClientRect(), s = document.createElement('span');
    s.className = 'ripple'; s.setAttribute('aria-hidden', 'true');
    s.style.left = `${e.clientX - r.left}px`; s.style.top = `${e.clientY - r.top}px`;
    b.append(s);
    s.addEventListener('animationend', () => s.remove());
  }
  const up = () => { b.classList.remove('press'); removeEventListener('pointerup', up); removeEventListener('pointercancel', up); };
  addEventListener('pointerup', up); addEventListener('pointercancel', up);
});

// ---------------------------------------------------------------- confetti: ~50 two-tone capsules with gravity, from a rect
function confetti(rect) {
  if (reduced) return;
  const r = rect && rect.width ? rect : { left: innerWidth / 2, top: innerHeight / 3, width: 0, height: 0 };
  const c = document.createElement('canvas'), dpr = Math.min(2, devicePixelRatio || 1);
  c.className = 'confetti'; c.setAttribute('aria-hidden', 'true');
  c.width = innerWidth * dpr; c.height = innerHeight * dpr;
  document.body.append(c);
  const g = c.getContext('2d'); g.scale(dpr, dpr);
  const cols = typeof PILL_COLOURS !== 'undefined' ? PILL_COLOURS : ['#F4A7B9', '#F5D77E', '#A9DFC1', '#9CCBF0', '#CDAAF0'];
  const pick = () => cols[Math.floor(Math.random() * cols.length)];
  const ps = Array.from({ length: 50 }, () => ({
    x: r.left + r.width / 2 + (Math.random() - 0.5) * r.width * 0.6, y: r.top + r.height / 2,
    vx: (Math.random() - 0.5) * 10, vy: -4 - Math.random() * 10, a: Math.random() * 6.28, va: (Math.random() - 0.5) * 0.3,
    w: 12 + Math.random() * 6, c1: pick(), c2: pick(),
  }));
  let last = performance.now();
  const tick = t => {
    const dt = Math.min(2.5, (t - last) / 16.7); last = t;
    g.clearRect(0, 0, innerWidth, innerHeight);
    let alive = 0;
    for (const p of ps) {
      p.vy += 0.38 * dt; p.vx *= 0.992; p.x += p.vx * dt; p.y += p.vy * dt; p.a += p.va * dt;
      if (p.y > innerHeight + 30) continue;
      alive++;
      const h = p.w * 0.42;
      g.save(); g.translate(p.x, p.y); g.rotate(p.a);
      g.fillStyle = p.c1; g.beginPath(); g.roundRect(-p.w / 2, -h / 2, p.w / 2, h, [h / 2, 0, 0, h / 2]); g.fill();
      g.fillStyle = p.c2; g.beginPath(); g.roundRect(0, -h / 2, p.w / 2, h, [0, h / 2, h / 2, 0]); g.fill();
      g.restore();
    }
    if (alive) requestAnimationFrame(tick); else c.remove();
  };
  requestAnimationFrame(tick);
}
