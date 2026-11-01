'use strict';
/* MediLink data visuals in a pharmacy vocabulary: glass vials, blister packs, capsules, a pill organiser, a cold-chain
   trace. No library. Every API string is escaped (esc) or set with textContent. Under the CSP markup never carries
   style attributes: sizes go through el.style / setProperty or SVG attributes. Status is always colour AND a word or
   number (visible or in the aria-label). Entrances live in css/viz.css behind prefers-reduced-motion; the map's
   loops pause in a hidden tab. Uses esc, dateIN, timeIN from ui.js. */

const fmtN = v => Number(v ?? 0).toLocaleString('en-IN');
let vzSeq = 0;
const vzId = p => `vz${p}${++vzSeq}`;
const TONES = new Set(['mint', 'sun', 'rose', 'sky', 'violet', 'ink', 'hatch', 'grey']);
const LEGACY_TONE = { crit: 'rose', warn: 'sun', good: 'mint', red: 'rose', amber: 'sun', green: 'mint' };
const tn = t => (TONES.has(t) ? t : LEGACY_TONE[t] || 'ink');
const FILL = { mint: '#A9DFC1', sun: '#F5D77E', rose: '#F4A7B9', sky: '#9CCBF0', violet: '#CDAAF0', ink: '#3B2218', hatch: 'url(#vz-hatch)', grey: '#E1E4E8' };
const TINT = { mint: '#D6F1E2', sun: '#FBEDC2', rose: '#FBD6DF', sky: '#D2E7F8', violet: '#E9DBF8', ink: '#9B6446', hatch: '#FBD6DF', grey: '#F1F2F4' };
const DARK = { mint: '#2f9a68', sun: '#9A6700', rose: '#c9475f', sky: '#2E6FA8', violet: '#6B4FA8', ink: '#26140D', hatch: '#c9475f', grey: '#8F867E' };
const n0 = v => (Number.isFinite(Number(v)) ? Number(v) : 0);

// ---------------------------------------------------------------- shared SVG defs (once; zero-size, not display:none so paints resolve)
document.body.insertAdjacentHTML('afterbegin', `<svg class="vz-defs" width="0" height="0" aria-hidden="true" focusable="false"><defs>
  <pattern id="vz-hatch" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><rect width="6" height="6" fill="#F8C3CF"/><rect width="2.4" height="6" fill="#c9475f" opacity=".5"/></pattern>
  <pattern id="vz-ridge" width="3" height="20" patternUnits="userSpaceOnUse"><rect width="3" height="20" fill="#CDD2D9"/><rect x="2" width="1" height="20" fill="#AEB4BE"/></pattern>
  <linearGradient id="vz-wall" x1="0" x2="1"><stop offset="0" stop-color="#fff" stop-opacity=".95"/><stop offset=".22" stop-color="#fff" stop-opacity=".15"/><stop offset=".78" stop-color="#C9CED6" stop-opacity=".08"/><stop offset="1" stop-color="#B4BAC4" stop-opacity=".55"/></linearGradient>
  <linearGradient id="vz-capsh" x1="0" x2="1"><stop offset="0" stop-color="#fff" stop-opacity=".6"/><stop offset=".3" stop-color="#fff" stop-opacity="0"/><stop offset=".75" stop-color="#8F867E" stop-opacity="0"/><stop offset="1" stop-color="#8F867E" stop-opacity=".45"/></linearGradient>
</defs></svg>`);
document.addEventListener('visibilitychange', () => document.documentElement.classList.toggle('vz-hidden', document.hidden));

// ---------------------------------------------------------------- tooltip (value first, label second)
let tipEl = null;
function tipShow(target, title, rows = [], e) {
  if (!tipEl) { tipEl = document.createElement('div'); tipEl.className = 'vz-tip'; tipEl.setAttribute('role', 'tooltip'); document.body.append(tipEl); }
  tipEl.replaceChildren();
  if (title) { const h = document.createElement('p'); h.className = 'vz-tip-h'; h.textContent = title; tipEl.append(h); }
  for (const r of rows) {
    const p = document.createElement('p');
    if (r.tone) { const k = document.createElement('i'); k.className = 'k-' + tn(r.tone); p.append(k); }
    if (r.value !== '' && r.value != null) { const b = document.createElement('b'); b.textContent = r.value; p.append(b); }
    if (r.label) p.append(' ' + r.label);
    tipEl.append(p);
  }
  tipEl.hidden = false;
  const box = target.getBoundingClientRect(), w = tipEl.offsetWidth, h = tipEl.offsetHeight;
  const x = e?.clientX ?? box.left + box.width / 2, y = e?.clientY ?? box.top;
  tipEl.style.left = Math.max(8, Math.min(innerWidth - w - 8, x - w / 2)) + 'px';
  tipEl.style.top = (y - h - 14 < 8 ? (e ? y + 18 : box.bottom + 10) : y - h - 14) + 'px';
}
const tipHide = () => { if (tipEl) tipEl.hidden = true; };
addEventListener('scroll', tipHide, { passive: true });

/** Hover + focus tooltip on every [data-tip] inside root; content comes from tips[index]. */
function wireTips(root, tips) {
  root.querySelectorAll('[data-tip]').forEach(el => {
    const t = tips[+el.dataset.tip]; if (!t) return;
    el.addEventListener('pointermove', e => tipShow(el, t.title, t.rows, e));
    el.addEventListener('pointerleave', tipHide);
    el.addEventListener('focus', () => tipShow(el, t.title, t.rows));
    el.addEventListener('blur', tipHide);
  });
}
/** Widths / heights in percent from data-w / data-h (no inline styles under the CSP). */
function sizeMarks(root) {
  const clamp = v => Math.max(0, Math.min(100, Number(v) || 0));
  root.querySelectorAll('[data-w]').forEach(el => { el.style.width = clamp(el.dataset.w) + '%'; });
  root.querySelectorAll('[data-h]').forEach(el => { el.style.height = clamp(el.dataset.h) + '%'; });
}
const stagger = (root, sel) => root.querySelectorAll(sel).forEach((x, i) => x.style.setProperty('--i', i));
const legendHtml = items => `<ul class="vz-legend">${items.map(x => `<li><i class="vt-${tn(x.tone)}" aria-hidden="true"></i>${esc(x.label)}</li>`).join('')}</ul>`;
const ago = iso => {
  const t = Date.parse(iso); if (!t) return 'never synced';
  const s = Math.max(0, (Date.now() - t) / 1000);
  return s < 60 ? 'synced just now' : s < 3600 ? `synced ${Math.round(s / 60)} min ago` : s < 86400 ? `synced ${Math.round(s / 3600)} h ago` : `synced ${Math.round(s / 86400)} d ago`;
};

// ---------------------------------------------------------------- capsule geometry (horizontal, centred on 0,0)
const capD = (len, w) => { const r = w / 2, a = len / 2 - r; return `M${-a},${-r}H${a}A${r},${r} 0 0 1 ${a},${r}H${-a}A${r},${r} 0 0 1 ${-a},${-r}Z`; };
const capL = (len, w) => { const r = w / 2, a = len / 2 - r; return `M0,${-r}H${-a}A${r},${r} 0 0 0 ${-a},${r}H0Z`; };
const capR = (len, w) => { const r = w / 2, a = len / 2 - r; return `M0,${-r}H${a}A${r},${r} 0 0 1 ${a},${r}H0Z`; };
/** One capsule. kind: full (two-tone), half (tone + empty glass), empty (dashed outline), hatch (expired). */
function capsule(len, w, kind, tone = 'mint') {
  const out = `<path d="${capD(len, w)}" fill="none" stroke="rgba(38,20,13,.22)" stroke-width="1"/>`;
  const shine = `<path d="${capD(len - w * 0.7, w * 0.26)}" transform="translate(${-w * 0.1} ${-w * 0.2})" fill="#fff" opacity=".6"/>`;
  if (kind === 'empty') return `<path d="${capD(len, w)}" fill="rgba(255,255,255,.7)" stroke="${DARK[tone]}" stroke-width="1.3" stroke-dasharray="3 2.4"/>`;
  if (kind === 'half') return `<path d="${capD(len, w)}" fill="rgba(255,255,255,.8)"/><path d="${capL(len, w)}" fill="${FILL[tone]}"/><path d="M0,${-w / 2}V${w / 2}" stroke="rgba(38,20,13,.22)"/>${shine}${out}`;
  if (kind === 'hatch') return `<path d="${capD(len, w)}" fill="url(#vz-hatch)"/>${shine}${out}`;
  return `<path d="${capL(len, w)}" fill="${FILL[tone]}"/><path d="${capR(len, w)}" fill="${TINT[tone]}"/><path d="M0,${-w / 2}V${w / 2}" stroke="rgba(38,20,13,.18)"/>${shine}${out}`;
}
/** Ridged cap (the landing bottle cap) at x,y, size w x h. */
const ridgedCap = (x, y, w, h) => `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${Math.min(3, h / 3)}" fill="url(#vz-ridge)"/><rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${Math.min(3, h / 3)}" fill="url(#vz-capsh)" stroke="#9AA1AB" stroke-width=".8"/><rect x="${x - 1}" y="${y + h - 2}" width="${w + 2}" height="2.6" rx="1.3" fill="#C9CED6" stroke="#9AA1AB" stroke-width=".6"/>`;

// ---------------------------------------------------------------- vialGauge: stock against the reorder level
const VIAL_TONE = { out: 'rose', low: 'sun', ok: 'mint', untracked: 'grey' };
const VIAL_WORD = { out: 'Out of stock', low: 'Low', ok: 'OK', untracked: 'Not tracked' };
function vialGauge(el, { onHand = 0, threshold = null, status = 'ok', max = 1 } = {}) {
  const id = vzId('v'), n = n0(onHand), th = threshold == null ? null : n0(threshold);
  const st = VIAL_TONE[status] ? status : 'ok', tone = VIAL_TONE[st];
  const f = st === 'out' || n <= 0 ? 0 : th ? Math.min(1, n / (2.5 * th)) : Math.min(1, n / Math.max(1, n0(max)));
  const top = 18, bot = 61, H = bot - top, ly = (bot - f * H).toFixed(1), ry = (bot - 0.4 * H).toFixed(1);
  let wave = `M-24,${ly}q3,-1.8 6,0`; for (let i = 0; i < 12; i++) wave += 't6,0'; wave += `V64H-24Z`;
  el.classList.add('vz-vial');
  el.innerHTML = `<svg viewBox="0 0 28 64" role="img" tabindex="0" data-tip="0" aria-label="${esc(fmtN(n))} in stock${th != null ? `, reorder at ${esc(fmtN(th))}` : ''}: ${esc(VIAL_WORD[st])}">
    <defs><clipPath id="${id}"><rect x="4" y="${top}" width="20" height="${H}" rx="5"/></clipPath></defs>
    <rect x="4" y="${top}" width="20" height="${H}" rx="5" fill="rgba(255,255,255,.72)"/>
    ${f > 0 ? `<g clip-path="url(#${id})"><g class="vz-liq"><path class="vz-wave" d="${wave}" fill="${FILL[tone]}"/></g></g>` : ''}
    ${th != null ? `<path d="M2,${ry}H26" stroke="#3B2218" stroke-width="1" stroke-dasharray="2 1.6" opacity=".75"/>` : ''}
    <rect x="4" y="${top}" width="20" height="${H}" rx="5" fill="url(#vz-wall)"/>
    <rect x="4" y="${top}" width="20" height="${H}" rx="5" fill="none" stroke="${st === 'out' ? DARK.rose : 'rgba(38,20,13,.28)'}" stroke-width="1.1" ${st === 'out' ? 'stroke-dasharray="3 2.4"' : ''}/>
    <rect x="9" y="13" width="10" height="6" fill="rgba(255,255,255,.8)" stroke="rgba(38,20,13,.22)" stroke-width=".8"/>
    ${ridgedCap(6, 2, 16, 11)}
    ${th && n > 2.5 * th ? '<path d="M14,4.6V10.4M11.1,7.5H16.9" stroke="#3B2218" stroke-width="1.6" stroke-linecap="round"/>' : ''}
  </svg>`;
  wireTips(el, [{ title: `${fmtN(n)} in stock`, rows: [{ value: VIAL_WORD[st], tone }, ...(th != null ? [{ value: fmtN(th), label: 'reorder level (dashed line)' }] : [])] }]);
}

// ---------------------------------------------------------------- blisterStrip: one foil pocket per batch, soonest first
function blisterStrip(el, lots = [], { max = 6 } = {}) {
  const ls = [...(lots || [])].sort((a, b) => n0(a.daysLeft) - n0(b.daysLeft));
  const shown = ls.slice(0, max), more = ls.length - shown.length;
  el.classList.add('vz-blister');
  if (!ls.length) { el.innerHTML = '<span class="vz-none">No batches near expiry</span>'; return; }
  const info = shown.map(l => {
    const d = n0(l.daysLeft), exp = l.status === 'expired' || d < 0;
    const tone = exp ? 'hatch' : d <= 30 ? 'rose' : d <= 90 ? 'sun' : 'mint';
    return { l, d, exp, tone, lab: exp ? 'exp' : `${d}d`, word: exp ? 'Expired' : `Expires in ${d} days` };
  });
  el.innerHTML = `<span class="vz-foil" role="list" aria-label="Batches by expiry">${info.map((x, i) => `<span class="vz-pocket" role="listitem" tabindex="0" data-tip="${i}" aria-label="Batch ${esc(x.l.batchNo)}: ${esc(fmtN(x.l.qty))} units, ${esc(x.word)}"><span class="vz-dome"><svg viewBox="-12 -6 24 12" aria-hidden="true">${capsule(22, 10, x.exp ? 'hatch' : 'full', x.tone)}</svg></span><small class="${x.exp || x.d <= 30 ? 'hot' : ''}">${esc(x.lab)}</small></span>`).join('')}${more > 0 ? `<span class="vz-more" aria-label="${more} more batches">+${more}</span>` : ''}</span>`;
  stagger(el, '.vz-pocket');
  wireTips(el, info.map(x => ({
    title: `${x.l.brandName || 'Batch'} · ${x.l.batchNo || ''}`,
    rows: [{ value: x.word, tone: x.tone === 'hatch' ? 'rose' : x.tone }, { value: fmtN(x.l.qty), label: 'units' }, ...(x.l.expiryDate ? [{ value: dateIN(x.l.expiryDate, true), label: 'expiry date' }] : []), ...(x.l.text ? [{ value: '', label: x.l.text }] : [])],
  })));
}

// ---------------------------------------------------------------- capsuleRing: cover for the next N days, worst at 12 o'clock
const COVER_ORDER = { short: 0, low: 1, covered: 2, none: 3 };
const coverLook = d => ({
  short: { kind: 'empty', tone: 'rose', word: `Short ${fmtN(d.shortfall)}` },
  low: { kind: 'half', tone: 'sun', word: 'Low' },
  covered: { kind: 'full', tone: 'mint', word: 'Covered' },
}[d.status] || { kind: 'full', tone: 'grey', word: 'No bookings' });
function capsuleRing(el, drugs = [], { windowDays = 14, onSelect } = {}) {
  const ds = [...(drugs || [])].sort((a, b) => (COVER_ORDER[a.status] ?? 4) - (COVER_ORDER[b.status] ?? 4));
  const booked = ds.filter(d => d.status !== 'none'), ok = booked.filter(d => d.status === 'covered').length;
  const tips = ds.map(d => { const k = coverLook(d); return { title: d.name, rows: [{ value: k.word, tone: k.tone }, { value: fmtN(d.booked), label: 'doses booked' }, { value: fmtN(d.stock), label: 'in stock' }, ...(d.firstAffectedDate ? [{ value: dateIN(d.firstAffectedDate), label: 'first affected' }] : [])] }; });
  const label = d => `${d.name}: ${coverLook(d).word}, ${fmtN(d.booked)} booked, ${fmtN(d.stock)} in stock`;
  el.classList.add('vz-ringwrap');
  const rows = ds.length > 16 || (el.clientWidth > 0 && el.clientWidth < 250);
  if (rows) {
    el.innerHTML = `<ul class="vz-crows">${ds.map((d, i) => { const k = coverLook(d); return `<li tabindex="0" data-i="${i}" data-tip="${i}" aria-label="${esc(label(d))}"><svg viewBox="-15 -7 30 14" aria-hidden="true">${capsule(28, 12, k.kind, k.tone)}</svg><b>${esc(d.name)}</b><span class="vz-word vw-${k.tone}">${esc(k.word)}</span></li>`; }).join('')}</ul>`;
  } else {
    const N = Math.max(1, ds.length), w = Math.min(17, ((2 * Math.PI * 92) / N) * 0.55);
    el.innerHTML = `<div class="vz-ring"><svg viewBox="0 0 240 240" role="listbox" aria-label="Cover for the next ${esc(windowDays)} days: ${ok} of ${booked.length} covered">
      <circle cx="120" cy="120" r="92" fill="none" stroke="rgba(255,255,255,.8)" stroke-width="46"/>
      <circle cx="120" cy="120" r="115" fill="none" stroke="rgba(38,20,13,.08)"/><circle cx="120" cy="120" r="69" fill="none" stroke="rgba(38,20,13,.08)"/>
      ${ds.map((d, i) => { const k = coverLook(d), a = -90 + (i * 360) / N; return `<g class="vz-rc" role="option" aria-selected="false" tabindex="${i ? -1 : 0}" data-i="${i}" data-tip="${i}" aria-label="${esc(label(d))}" transform="translate(120 120) rotate(${a.toFixed(2)}) translate(92 0)"><g class="vz-rc-in">${capsule(38, w, k.kind, k.tone)}</g></g>`; }).join('')}
    </svg><div class="vz-ring-c" aria-hidden="true"><b>${booked.length ? `${ok}/${booked.length}` : '—'}</b><em>${booked.length ? `covered for ${esc(windowDays)} days` : 'nothing booked'}</em></div></div>`;
  }
  const items = [...el.querySelectorAll('[data-i]')];
  items.forEach((x, i) => x.style.setProperty('--i', i));
  wireTips(el, tips);
  const pick = x => onSelect?.(ds[+x.dataset.i]);
  items.forEach(x => {
    x.addEventListener('click', () => pick(x));
    x.addEventListener('keydown', e => {
      const i = +x.dataset.i, k = e.key;
      if (k === 'Enter' || k === ' ') { e.preventDefault(); pick(x); return; }
      const j = k === 'ArrowRight' || k === 'ArrowDown' ? (i + 1) % items.length : k === 'ArrowLeft' || k === 'ArrowUp' ? (i - 1 + items.length) % items.length : k === 'Home' ? 0 : k === 'End' ? items.length - 1 : -1;
      if (j < 0 || rows) return;
      e.preventDefault(); x.tabIndex = -1; items[j].tabIndex = 0; items[j].focus();
    });
  });
  el.classList.toggle('vz-pickable', !!onSelect);
}

// ---------------------------------------------------------------- capsuleBars: glossy capsule bars, stacked or diverging
const sumV = ps => (ps || []).reduce((s, p) => s + n0(p.value), 0);
function capsuleBars(el, rows = [], { legend, max, diverging } = {}) {
  const top = max || Math.max(1, ...rows.map(r => Math.max(sumV(r.parts), diverging ? sumV(r.left) : 0)));
  const fill = (ps, side) => { const t = sumV(ps); return t > 0 ? `<span class="vz-cb-fill ${side}" data-w="${(t / top) * 100}">${ps.filter(p => n0(p.value) > 0).map(p => `<i class="vt-${tn(p.tone)}" data-g="${n0(p.value)}"></i>`).join('')}</span>` : ''; };
  el.classList.add('vz-cbwrap');
  el.innerHTML = `${legend ? legendHtml(legend) : ''}<div class="vz-cb${diverging ? ' div' : ''}" role="list">${rows.map((r, i) => {
    const tot = sumV(r.parts), lt = sumV(r.left);
    return `<div class="vz-cb-row" role="listitem" tabindex="0" data-tip="${i}" aria-label="${esc(r.label)}: ${esc(r.aria || fmtN(tot))}">
      <span class="vz-cb-l"><b>${esc(r.label)}</b>${r.sub ? `<small>${esc(r.sub)}</small>` : ''}</span>
      ${diverging ? `<span class="vz-cb-lv">${lt ? esc(fmtN(lt)) : ''}</span><span class="vz-cb-t left">${fill(r.left || [], 'l')}</span><span class="vz-cb-spine" aria-hidden="true"></span>` : ''}
      <span class="vz-cb-t">${fill(r.parts || [], 'r')}</span>
      <span class="vz-cb-v">${esc(r.total ?? fmtN(tot))}</span>${r.extra ? `<span class="vz-cb-x">${r.extra}</span>` : ''}</div>`;
  }).join('')}</div>`;
  sizeMarks(el);
  el.querySelectorAll('[data-g]').forEach(x => { x.style.flexGrow = x.dataset.g; });
  stagger(el, '.vz-cb-row');
  wireTips(el, rows.map(r => r.tip));
}
/** Up to 5 capsule dots, the first `filled` drawn rose (short). */
const unitDots = (n, filled) => { const t = Math.min(5, n0(n)), f = Math.min(t, n0(filled)); return `<span class="vz-dots" role="img" aria-label="${f} of ${t} hospitals short">${Array.from({ length: t }, (_, i) => `<i class="${i < f ? 'on' : ''}"></i>`).join('')}</span>`; };

// ---------------------------------------------------------------- expiryShelf: six straight-walled vials on a glass shelf
function expiryShelf(el, buckets = []) {
  const top = Math.max(1, ...buckets.map(b => n0(b.units))), BH = 104;
  const toneOf = i => (i === 0 ? 'hatch' : i === 1 ? 'rose' : i <= 3 ? 'sun' : 'mint');
  const wordOf = i => (i === 0 ? 'expired' : i === 1 ? 'expire within 30 days' : i <= 3 ? 'expire within 90 days' : 'safe for now');
  el.classList.add('vz-shelfwrap');
  el.innerHTML = `<div class="vz-shelf" role="list">${buckets.map((b, i) => {
    const id = vzId('s'), u = n0(b.units), h = u ? Math.max(3, (u / top) * (BH - 4)) : 0, t = toneOf(i), y = 22 + BH + 4 - h;
    return `<div class="vz-sv" role="listitem" tabindex="0" data-tip="${i}" aria-label="${esc(b.label)}: ${esc(fmtN(u))} units ${wordOf(i)}"><b>${esc(fmtN(u))}</b>
      <svg viewBox="0 0 40 132" aria-hidden="true"><defs><clipPath id="${id}"><rect x="5" y="22" width="30" height="${BH + 4}" rx="4"/></clipPath></defs>
        <rect x="5" y="22" width="30" height="${BH + 4}" rx="4" fill="rgba(255,255,255,.7)"/>
        ${h ? `<g clip-path="url(#${id})"><g class="vz-liq"><rect x="0" y="${y.toFixed(1)}" width="40" height="${(h + 6).toFixed(1)}" fill="${FILL[t]}"/><rect x="0" y="${y.toFixed(1)}" width="40" height="1.4" fill="${DARK[t]}" opacity=".5"/></g></g>` : ''}
        <rect x="5" y="22" width="30" height="${BH + 4}" rx="4" fill="url(#vz-wall)" stroke="rgba(38,20,13,.24)"/>
        <rect x="11" y="16" width="18" height="7" fill="rgba(255,255,255,.85)" stroke="rgba(38,20,13,.2)" stroke-width=".8"/>${ridgedCap(8, 3, 24, 13)}
      </svg><span>${esc(b.label)}</span></div>`;
  }).join('')}</div><div class="vz-plank" aria-hidden="true"></div>`;
  stagger(el, '.vz-sv');
  wireTips(el, buckets.map((b, i) => ({ title: b.label, rows: [{ value: fmtN(b.units), label: `units ${wordOf(i)}`, tone: toneOf(i) }] })));
}

// ---------------------------------------------------------------- pillbox: drugs x hospitals organiser
const shortName = s => String(s || '').replace(/\s+(Hospital|Centre|Center)$/i, '');
function pillbox(el, cover) {
  const { drugs = [], hospitals = [], cells = [], windowDays = 14 } = cover || {};
  const at = new Map(cells.map(c => [c.hospitalId + '|' + c.drugId, c]));
  const tips = [];
  el.classList.add('vz-pbwrap');
  el.innerHTML = `<table class="vz-pb" role="grid" aria-label="Cover for the next ${esc(windowDays)} days by hospital">
    <thead><tr><th scope="col"><span class="sr-only">Medicine</span></th>${hospitals.map((h, c) => `<th scope="col" data-c="${c}"><span class="vz-lid">${esc(shortName(h.name))}</span></th>`).join('')}</tr></thead>
    <tbody>${drugs.map((d, r) => `<tr><th scope="row">${esc(d.name)}</th>${hospitals.map((h, c) => {
      const x = at.get(h.id + '|' + d.id), k = x ? coverLook(x) : null;
      const num = !x ? '·' : x.status === 'short' ? `−${fmtN(x.shortfall)}` : fmtN(x.stock);
      const aria = x ? `${d.name} at ${h.name}: ${k.word}, ${fmtN(x.stock)} in stock, ${fmtN(x.booked)} booked` : `${d.name} at ${h.name}: no data`;
      tips.push({ title: `${d.name} · ${shortName(h.name)}`, rows: x ? [{ value: k.word, tone: k.tone }, { value: fmtN(x.stock), label: 'in stock' }, { value: fmtN(x.booked), label: 'booked' }] : [{ value: 'No data' }] });
      return `<td class="vz-pc ${x ? 'c-' + k.tone : 'c-nil'}" role="gridcell" tabindex="${r || c ? -1 : 0}" data-r="${r}" data-c="${c}" data-tip="${tips.length - 1}" aria-label="${esc(aria)}"><span class="vz-pb-h" aria-hidden="true">${esc(shortName(h.name))}</span><span class="vz-pcin">${x ? `<svg viewBox="-9 -4.5 18 9" aria-hidden="true">${capsule(17, 8, k.kind, k.tone)}</svg>` : ''}<b>${esc(num)}</b></span></td>`;
    }).join('')}</tr>`).join('')}</tbody></table>`;
  wireTips(el, tips);
  const tbl = el.firstElementChild, cellAt = (r, c) => tbl.querySelector(`td[data-r="${r}"][data-c="${c}"]`);
  const hl = (r, c) => {
    tbl.querySelectorAll('.hl').forEach(x => x.classList.remove('hl'));
    if (r == null) return;
    tbl.querySelectorAll(`[data-c="${c}"]`).forEach(x => x.classList.add('hl'));
    tbl.tBodies[0].rows[r]?.classList.add('hl');
  };
  const at2 = e => e.target.closest?.('td[data-r]');
  tbl.addEventListener('pointerover', e => { const td = at2(e); if (td) hl(+td.dataset.r, +td.dataset.c); });
  tbl.addEventListener('pointerleave', () => hl(null));
  tbl.addEventListener('focusin', e => { const td = at2(e); if (td) hl(+td.dataset.r, +td.dataset.c); });
  tbl.addEventListener('focusout', () => hl(null));
  tbl.addEventListener('keydown', e => {
    const td = at2(e); if (!td) return;
    let r = +td.dataset.r, c = +td.dataset.c;
    const m = { ArrowRight: [0, 1], ArrowLeft: [0, -1], ArrowDown: [1, 0], ArrowUp: [-1, 0] }[e.key];
    if (m) { r += m[0]; c += m[1]; } else if (e.key === 'Home') c = 0; else if (e.key === 'End') c = hospitals.length - 1; else return;
    const nx = cellAt(r, c); e.preventDefault(); if (!nx) return;
    td.tabIndex = -1; nx.tabIndex = 0; nx.focus();
  });
}

// ---------------------------------------------------------------- tempTrace: cold-chain trace against the safe band
/** s = {points:[{at,c,out}], min, max} (or a tracking temperature {readings, range}). Height: CSS var --vz-h on el. */
function tempTrace(el, s = {}) {
  const lo0 = n0(s.range?.minC ?? s.min ?? 2), hi0 = n0(s.range?.maxC ?? s.max ?? 8);
  const pts = (s.points || s.readings || []).map(p => ({ at: p.at, c: Number(p.c), out: p.out ?? (p.c < lo0 || p.c > hi0) })).filter(p => Number.isFinite(p.c) && Date.parse(p.at));
  el.classList.add('vz-trace');
  if (pts.length < 2) { el.innerHTML = '<p class="vz-none">Not enough readings yet.</p>'; return () => {}; }
  // excursion runs (consecutive out-of-range readings), each summarised by its worst reading
  const dev = p => (p.c > hi0 ? p.c - hi0 : lo0 - p.c), runs = []; let cur = null;
  pts.forEach((p, i) => { if (!p.out) { cur = null; return; } if (!cur) runs.push(cur = { from: i, to: i, peak: i }); cur.to = i; if (dev(p) > dev(pts[cur.peak])) cur.peak = i; });
  let idx = pts.length - 1;
  const draw = () => {
    const W = Math.max(240, el.clientWidth), H = parseFloat(getComputedStyle(el).getPropertyValue('--vz-h')) || (W < 360 ? 120 : 170);
    const P = { l: 30, r: 30, t: 10, b: 20 }, gid = vzId('g'), ca = vzId('a'), cb = vzId('b');
    const t0 = Date.parse(pts[0].at), t1 = Math.max(t0 + 1, Date.parse(pts[pts.length - 1].at));
    const vals = pts.map(p => p.c), lo = Math.floor(Math.min(lo0, ...vals) - 1), hi = Math.ceil(Math.max(hi0, ...vals) + 1);
    const X = i => P.l + ((Date.parse(pts[i].at) - t0) / (t1 - t0)) * (W - P.l - P.r);
    const Y = v => P.t + (1 - (v - lo) / (hi - lo)) * (H - P.t - P.b);
    const line = pts.map((p, i) => `${i ? 'L' : 'M'}${X(i).toFixed(1)},${Y(p.c).toFixed(1)}`).join('');
    const xs = X(0).toFixed(1), xe = X(pts.length - 1).toFixed(1), yH = Y(hi0).toFixed(1), yL = Y(lo0).toFixed(1), last = pts[pts.length - 1];
    const step = Math.max(1, Math.ceil((hi - lo) / 4)), grid = []; for (let v = Math.ceil(lo / step) * step; v <= hi; v += step) if (v !== lo0 && v !== hi0) grid.push(v);
    el.innerHTML = `<svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" tabindex="0" role="img" aria-label="Temperature from ${esc(vals[0].toFixed(1))} to ${esc(vals[vals.length - 1].toFixed(1))} °C, safe ${esc(lo0)} to ${esc(hi0)} °C${runs.length ? `, ${runs.length} excursion${runs.length > 1 ? 's' : ''}` : ', all in range'}. Arrow keys read each point.">
      <defs><linearGradient id="${gid}" gradientUnits="userSpaceOnUse" x1="0" x2="0" y1="${yH}" y2="${yL}"><stop offset="0" stop-color="#c9475f"/><stop offset="0" stop-color="#3B2218"/><stop offset="1" stop-color="#3B2218"/><stop offset="1" stop-color="#2E6FA8"/></linearGradient>
        <clipPath id="${ca}"><rect x="0" y="0" width="${W}" height="${yH}"/></clipPath><clipPath id="${cb}"><rect x="0" y="${yL}" width="${W}" height="${H}"/></clipPath></defs>
      ${grid.map(v => `<path class="vz-gl" d="M${P.l},${Y(v).toFixed(1)}H${W - P.r}"/><text class="vz-ax" x="${P.l - 6}" y="${(Y(v) + 3.5).toFixed(1)}" text-anchor="end">${v}°</text>`).join('')}
      <rect class="vz-band" x="${P.l}" y="${yH}" width="${W - P.l - P.r}" height="${(yL - yH).toFixed(1)}" rx="4"/>
      <path class="vz-bandl" d="M${P.l},${yH}H${W - P.r}M${P.l},${yL}H${W - P.r}"/>
      <text class="vz-bandt" x="${W - P.r + 5}" y="${(+yH + 3.5).toFixed(1)}">${esc(hi0)}°</text><text class="vz-bandt" x="${W - P.r + 5}" y="${(+yL + 3.5).toFixed(1)}">${esc(lo0)}°</text>
      <path d="${line}L${xe},${yH}L${xs},${yH}Z" fill="#F4A7B9" opacity=".6" clip-path="url(#${ca})"/>
      <path d="${line}L${xe},${yL}L${xs},${yL}Z" fill="#9CCBF0" opacity=".6" clip-path="url(#${cb})"/>
      <path class="vz-tl" d="${line}" stroke="url(#${gid})" pathLength="1"/>
      <text class="vz-ax" x="${P.l}" y="${H - 4}">${esc(timeIN(pts[0].at))}</text><text class="vz-ax" x="${W - P.r}" y="${H - 4}" text-anchor="end">${esc(timeIN(last.at))}</text>
      <circle cx="${xe}" cy="${Y(last.c).toFixed(1)}" r="9" fill="${last.out ? '#F4A7B9' : '#A9DFC1'}" opacity=".55"/>
      <circle class="vz-end" cx="${xe}" cy="${Y(last.c).toFixed(1)}" r="4.2" fill="${last.out ? '#c9475f' : '#3B2218'}" stroke="#fff" stroke-width="1.5"/>
      <g class="vz-xh"><path d="M0,${P.t}V${H - P.b}"/><circle r="4.5" cy="0"/></g>
    </svg>${runs.length ? `<div class="vz-exc">${runs.map((r, k) => { const p = pts[r.peak], mins = Math.max(1, Math.round((Date.parse(pts[r.to].at) - Date.parse(pts[r.from].at)) / 60000)); return `<button type="button" class="vz-chip ${p.c > hi0 ? 'hot' : 'cold'}" data-k="${k}">${esc(p.c.toFixed(1))} °C ${p.c > hi0 ? 'too warm' : 'too cold'} · ${esc(timeIN(p.at))} · ${mins} min</button>`; }).join('')}</div>` : ''}`;
    const svg = el.querySelector('svg'), xh = svg.querySelector('.vz-xh');
    const show = (i, e) => {
      idx = i; const p = pts[i], b = svg.getBoundingClientRect();
      xh.setAttribute('transform', `translate(${X(i).toFixed(1)} 0)`); xh.querySelector('circle').setAttribute('cy', Y(p.c).toFixed(1)); xh.classList.add('on');
      tipShow(svg, timeIN(p.at), [{ value: `${p.c.toFixed(1)} °C`, label: p.out ? (p.c > hi0 ? 'too warm' : 'too cold') : `in range ${lo0}–${hi0} °C`, tone: p.out ? (p.c > hi0 ? 'rose' : 'sky') : 'mint' }], e || { clientX: b.left + X(i), clientY: b.top + Y(p.c) });
    };
    const hide = () => { xh.classList.remove('on'); tipHide(); };
    svg.addEventListener('pointermove', e => {
      const mx = e.clientX - svg.getBoundingClientRect().left; let b = 0;
      for (let i = 1; i < pts.length; i++) if (Math.abs(X(i) - mx) < Math.abs(X(b) - mx)) b = i;
      show(b, e);
    });
    svg.addEventListener('pointerleave', hide);
    svg.addEventListener('focus', () => show(idx));
    svg.addEventListener('blur', hide);
    svg.addEventListener('keydown', e => {
      const j = { ArrowRight: idx + 1, ArrowLeft: idx - 1, Home: 0, End: pts.length - 1 }[e.key];
      if (j == null) return; e.preventDefault(); show(Math.max(0, Math.min(pts.length - 1, j)));
    });
    el.querySelectorAll('.vz-chip').forEach(b => b.addEventListener('click', () => { svg.focus(); show(runs[+b.dataset.k].peak); }));
  };
  draw();
  let lastW = el.clientWidth;
  const ro = new ResizeObserver(() => { if (Math.abs(el.clientWidth - lastW) > 8) { lastW = el.clientWidth; el.classList.add('vz-redraw'); draw(); } });
  ro.observe(el);
  return () => { ro.disconnect(); tipHide(); };
}

// ---------------------------------------------------------------- heartbeat: feed health as an ECG strip
const FEED_WORD = { live: 'Up to date', stale: 'Out of date', offline: 'Offline' };
function heartbeat(el, { feed = 'offline', lastSyncedAt } = {}) {
  const f = FEED_WORD[feed] ? feed : 'offline', amp = { live: 1, stale: 0.3, offline: 0 }[f], m = 16;
  let d = `M0,${m}`;
  for (let x = 0; x < 90; x += 34) d += `H${x + 8}l3,${-2 * amp}l3,${2 * amp}h4l2,${3 * amp}l3,${-14 * amp}l3,${17 * amp}l2,${-6 * amp}h3l3,${-3 * amp}l3,${3 * amp}`;
  d += 'H110';
  const dot = f === 'live' ? `<circle cx="112" cy="${m}" r="3.4" fill="#2f9a68"/>`
    : f === 'stale' ? `<circle cx="112" cy="${m}" r="3.6" fill="#FBEDC2" stroke="#9A6700" stroke-width="1.6"/>` : `<circle cx="112" cy="${m}" r="3" fill="#B4BAC4"/>`;
  el.classList.add('vz-hb');
  el.innerHTML = `<svg viewBox="0 0 120 30" aria-hidden="true"><path class="vz-hb-line ${f}" d="${d}" pathLength="1"/>${dot}</svg><span class="vz-hb-t"><b class="vz-word vw-${{ live: 'mint', stale: 'sun', offline: 'grey' }[f]}">${FEED_WORD[f]}</b><small>${esc(ago(lastSyncedAt))}</small></span>`;
  return () => {};
}

// ---------------------------------------------------------------- layeredVial: usable / expiring / expired on a shared scale
function layeredVial(el, { usable = 0, expiring = 0, expired = 0 } = {}, { max } = {}) {
  const u = n0(usable), x = n0(expiring), e = n0(expired), top = Math.max(1, n0(max) || u + x + e), BH = 92, id = vzId('l');
  let y = 26 + BH + 2;
  const rects = [[e, 'hatch'], [x, 'sun'], [u, 'mint']].map(([v, t]) => { if (!v) return ''; const h = Math.max(2.5, (v / top) * BH); y -= h; return `<rect x="0" y="${y.toFixed(1)}" width="44" height="${(h + 0.5).toFixed(1)}" fill="${FILL[t]}"/><rect x="0" y="${y.toFixed(1)}" width="44" height="1" fill="${DARK[t]}" opacity=".45"/>`; }).join('');
  el.classList.add('vz-lvial');
  el.innerHTML = `<svg viewBox="0 0 44 124" role="img" tabindex="0" data-tip="0" aria-label="${fmtN(u)} usable, ${fmtN(x)} expiring, ${fmtN(e)} expired">
    <defs><clipPath id="${id}"><rect x="6" y="26" width="32" height="${BH + 2}" rx="3"/></clipPath></defs>
    <rect x="6" y="26" width="32" height="${BH + 2}" rx="3" fill="rgba(255,255,255,.72)"/>
    <g clip-path="url(#${id})"><g class="vz-liq">${rects}</g></g>
    <rect x="6" y="26" width="32" height="${BH + 2}" rx="3" fill="url(#vz-wall)" stroke="rgba(38,20,13,.26)"/>
    <rect x="12" y="19" width="20" height="8" fill="rgba(255,255,255,.85)" stroke="rgba(38,20,13,.2)" stroke-width=".8"/>${ridgedCap(9, 5, 26, 14)}
  </svg><ul class="vz-lv-k"><li><i class="vt-mint"></i><b>${fmtN(u)}</b> usable</li><li><i class="vt-sun"></i><b>${fmtN(x)}</b> expiring</li><li><i class="vt-hatch"></i><b>${fmtN(e)}</b> expired</li></ul>`;
  wireTips(el, [{ title: 'Units in stock', rows: [{ value: fmtN(u), label: 'usable', tone: 'mint' }, { value: fmtN(x), label: 'expiring', tone: 'sun' }, { value: fmtN(e), label: 'expired', tone: 'hatch' }] }]);
}

// ---------------------------------------------------------------- bullet: actual (ink) against the goal notch
function bullet(el, m = {}) {
  const goal = m.goal?.value ?? null; // /admin/metrics sends a numeric goal per metric
  const v = m.value == null ? null : n0(m.value);
  const top = m.unit === '%' ? 100 : Math.max(1, Math.max(v ?? 0, goal ?? 0) * 1.35);
  const word = m.met === true ? ['Met', 'mint'] : m.met === false ? ['Missed', 'rose'] : ['No data yet', 'grey'];
  el.classList.add('vz-bullet');
  el.innerHTML = `<div class="vz-bl-h"><span class="vz-bl-l">${esc(m.label)}</span><span class="vz-word vw-${word[1]}">${word[0]}</span></div>
    <div class="vz-bl-r"><b class="vz-bl-v">${v == null ? '—' : esc(fmtN(v))}<small>${esc(m.unit || '')}</small></b>
      <span class="vz-bl-t${v == null ? ' nil' : ''}" role="img" tabindex="0" data-tip="0" aria-label="${esc(m.label)}: ${v == null ? 'no data yet' : esc(fmtN(v) + ' ' + (m.unit || ''))}${m.target ? `, goal ${esc(m.target)}` : ''}, ${word[0]}">${v != null ? `<i class="vz-bl-f" data-w="${(v / top) * 100}"></i>` : ''}${goal != null ? '<i class="vz-bl-g"></i>' : ''}</span></div>
    ${m.text ? `<p class="vz-bl-x">${esc(m.text)}</p>` : ''}`;
  sizeMarks(el);
  const g = el.querySelector('.vz-bl-g'); if (g) g.style.left = Math.max(0, Math.min(100, (goal / top) * 100)) + '%';
  wireTips(el, [{ title: m.label, rows: [{ value: word[0], tone: word[1] }, { value: v == null ? '—' : `${fmtN(v)} ${m.unit || ''}`, label: 'actual' }, ...(m.target ? [{ value: m.target, label: 'goal (notch)' }] : [])] }]);
}

// ---------------------------------------------------------------- thermoChip: a tiny thermometer + the reading (HTML string)
function thermoChip(t) {
  if (!t || t.current == null || !Number.isFinite(Number(t.current))) return '';
  const c = Number(t.current), mn = n0(t.range?.minC ?? 2), mx = n0(t.range?.maxC ?? 8), ok = t.inRange !== false;
  const lo = Math.min(mn - 4, c - 1), hi = Math.max(mx + 4, c + 1), y = v => +(19 - ((v - lo) / (hi - lo)) * 17).toFixed(1);
  const merc = ok ? '#3B2218' : '#c9475f';
  return `<span class="vz-thermo ${ok ? 'in' : 'out'}"><svg viewBox="0 0 12 28" aria-hidden="true">
    <rect x="1" y="${y(mx)}" width="10" height="${(y(mn) - y(mx)).toFixed(1)}" rx="1.5" fill="#A9DFC1"/>
    <rect x="3.5" y="1" width="5" height="21" rx="2.5" fill="#fff" stroke="rgba(38,20,13,.35)" stroke-width=".9"/>
    <rect x="4.6" y="${y(c)}" width="2.8" height="${(23 - y(c)).toFixed(1)}" rx="1.4" fill="${merc}"/>
    <circle cx="6" cy="23.6" r="3.6" fill="${merc}" stroke="#fff" stroke-width=".9"/><circle cx="4.9" cy="22.6" r="1" fill="#fff" opacity=".6"/>
  </svg><b>${esc(c.toFixed(1))} °C</b><span>· ${ok ? 'in range' : 'out of range'}</span></span>`;
}

// ---------------------------------------------------------------- glyph: ~20px pharmacy icons (always paired with a word by the caller)
const GLYPH = {
  covered: `<g transform="translate(12 12) rotate(-35)">${capsule(20, 9, 'full', 'mint')}</g>`,
  low: `<g transform="translate(12 12) rotate(-35)">${capsule(20, 9, 'half', 'sun')}</g>`,
  short: `<g transform="translate(12 12) rotate(-35)">${capsule(20, 9, 'empty', 'rose')}</g>`,
  expired: `<g transform="translate(12 12) rotate(-35)">${capsule(20, 9, 'hatch', 'rose')}</g>`,
  out: `<rect x="5.5" y="8" width="13" height="14" rx="3" fill="rgba(255,255,255,.8)" stroke="#c9475f" stroke-width="1.3" stroke-dasharray="2.6 2"/><rect x="7" y="2" width="10" height="5.5" rx="1.5" fill="url(#vz-ridge)" stroke="#9AA1AB" stroke-width=".7"/>`,
  expiring: `<circle cx="12" cy="12" r="9" fill="#F5D77E" stroke="rgba(38,20,13,.25)"/><ellipse cx="9" cy="7.6" rx="4" ry="1.6" fill="#fff" opacity=".55"/><path d="M12 7.5v4.8l3 2" fill="none" stroke="#3B2218" stroke-width="1.6" stroke-linecap="round"/>`,
  transit: `<path d="M1.5 9h5M1 13h4.5M2.5 17h4" stroke="#2E6FA8" stroke-width="1.4" stroke-linecap="round"/><g transform="translate(15 13)">${capsule(16, 8, 'full', 'sky')}</g>`,
  loan: `<g transform="translate(12 8)">${capsule(15, 6.5, 'full', 'violet')}</g><g transform="translate(12 16)">${capsule(15, 6.5, 'full', 'mint')}</g><path d="M20 5.5l2 2.5-2 2.5M4 13.5l-2 2.5 2 2.5" fill="none" stroke="#6B4FA8" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/>`,
  alert: `<circle cx="12" cy="12" r="9" fill="#F4A7B9" stroke="rgba(38,20,13,.25)"/><ellipse cx="9" cy="7.6" rx="4" ry="1.6" fill="#fff" opacity=".55"/><path d="M12 7.5v5.5" stroke="#8A2D45" stroke-width="2" stroke-linecap="round"/><circle cx="12" cy="16.3" r="1.2" fill="#8A2D45"/>`,
  hospital: `<rect x="3.5" y="3.5" width="17" height="17" rx="4.5" fill="#3B2218"/><path d="M10.5 7.5h3v3h3v3h-3v3h-3v-3h-3v-3h3Z" fill="#F2F3F5"/>`,
  check: `<circle cx="12" cy="12" r="9" fill="#A9DFC1" stroke="rgba(38,20,13,.2)"/><path d="M7.8 12.3l2.8 2.8 5.6-5.8" fill="none" stroke="#26140D" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>`,
};
const glyph = kind => `<svg class="vz-glyph" viewBox="0 0 24 24" width="20" height="20" aria-hidden="true" focusable="false">${GLYPH[kind] || GLYPH.check}</svg>`;

// ---------------------------------------------------------------- emptyArt: a glass bottle with a few resting pills
function emptyArt() {
  const pill = (x, y, r, t) => `<g transform="translate(${x} ${y}) rotate(${r})"><g class="vz-ep">${capsule(22, 10, 'full', t)}</g></g>`;
  return `<svg class="vz-empty" viewBox="0 0 160 120" width="160" height="120" aria-hidden="true" focusable="false">
    <ellipse cx="80" cy="113" rx="64" ry="5" fill="rgba(38,20,13,.08)"/>
    <rect x="54" y="36" width="44" height="76" rx="12" fill="rgba(255,255,255,.78)"/>
    <g transform="translate(76 101) rotate(-8)">${capsule(18, 8, 'full', 'sun')}</g>
    <rect x="54" y="36" width="44" height="76" rx="12" fill="url(#vz-wall)" stroke="rgba(38,20,13,.24)"/>
    <rect x="59" y="46" width="5" height="52" rx="2.5" fill="#fff" opacity=".85"/>
    <rect x="64" y="28" width="24" height="10" fill="rgba(255,255,255,.85)" stroke="rgba(38,20,13,.2)"/>${ridgedCap(59, 9, 34, 20)}
    ${pill(32, 106, -14, 'rose')}${pill(120, 106, 10, 'sky')}${pill(140, 98, 68, 'violet')}${pill(26, 90, 62, 'mint')}
  </svg>`;
}
