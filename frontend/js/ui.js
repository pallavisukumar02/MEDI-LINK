'use strict';
/* Shared by app.js (pharmacy portal) and courier.js (courier page): escaping, icons, HTTP + error shape, toast,
   action-form fields with camera barcode scanning, and small widgets (status chip, stepper, temperature, QR).
   Every server string goes through esc() before it reaches innerHTML. No inline handlers or styles (CSP). */

// ---------------------------------------------------------------- icons (Lucide, inline)
const LUCIDE = {
  user: '<path d="M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/>',
  lock: '<rect width="18" height="11" x="3" y="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/>',
  eye: '<path d="M2.062 12.348a1 1 0 0 1 0-.696 10.75 10.75 0 0 1 19.876 0 1 1 0 0 1 0 .696 10.75 10.75 0 0 1-19.876 0"/><circle cx="12" cy="12" r="3"/>',
  eyeOff: '<path d="M10.733 5.076a10.744 10.744 0 0 1 11.205 6.575 1 1 0 0 1 0 .696 10.747 10.747 0 0 1-1.444 2.49"/><path d="M14.084 14.158a3 3 0 0 1-4.242-4.242"/><path d="M17.479 17.499a10.75 10.75 0 0 1-15.417-5.151 1 1 0 0 1 0-.696 10.75 10.75 0 0 1 4.446-5.143"/><path d="m2 2 20 20"/>',
  arrowRight: '<path d="M5 12h14"/><path d="m12 5 7 7-7 7"/>',
  arrowLeft: '<path d="m12 19-7-7 7-7"/><path d="M19 12H5"/>',
  alert: '<path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3"/><path d="M12 9v4"/><path d="M12 17h.01"/>',
  check: '<path d="M20 6 9 17l-5-5"/>',
  clock: '<circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/>',
  thermo: '<path d="M14 4v10.54a4 4 0 1 1-4 0V4a2 2 0 0 1 4 0Z"/>',
  pin: '<path d="M20 10c0 4.993-5.539 10.193-7.399 11.799a1 1 0 0 1-1.202 0C9.539 20.193 4 14.993 4 10a8 8 0 0 1 16 0"/><circle cx="12" cy="10" r="3"/>',
  logout: '<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" x2="9" y1="12" y2="12"/>',
  refresh: '<path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16"/><path d="M8 16H3v5"/>',
  phone: '<path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z"/>',
  truck: '<path d="M14 18V6a2 2 0 0 0-2-2H4a2 2 0 0 0-2 2v11a1 1 0 0 0 1 1h2"/><path d="M15 18H9"/><path d="M19 18h2a1 1 0 0 0 1-1v-3.65a1 1 0 0 0-.22-.624l-3.48-4.35A1 1 0 0 0 17.52 8H14"/><circle cx="17" cy="18" r="2"/><circle cx="7" cy="18" r="2"/>',
  nav: '<polygon points="3 11 22 2 13 21 11 13 3 11"/>',
  copy: '<rect width="14" height="14" x="8" y="8" rx="2" ry="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/>',
  camera: '<path d="M14.5 4h-5L7 7H4a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-3l-2.5-3z"/><circle cx="12" cy="13" r="3"/>',
  box: '<path d="M21 8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16Z"/><path d="m3.3 7 8.7 5 8.7-5"/><path d="M12 22V12"/>',
};
const icon = (name, cls = 'icon') => `<svg class="${cls}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${LUCIDE[name]}</svg>`;
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const $ = (sel, root = document) => root.querySelector(sel);
const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
const coarse = matchMedia('(hover: none)').matches;
const newKey = () => (crypto.randomUUID ? crypto.randomUUID() : Date.now() + '-' + Math.random().toString(16).slice(2));
const timeIN = iso => new Date(iso).toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit', timeZone: 'Asia/Kolkata' });
const dateIN = (ymd, year) => new Date(ymd + 'T12:00:00Z').toLocaleDateString('en-IN', { day: 'numeric', month: 'short', ...(year ? { year: 'numeric' } : {}) });

// ---------------------------------------------------------------- HTTP + the experience-layer error shape
const NETWORK_ERROR = { code: 'NETWORK', title: 'Cannot reach MediLink', message: 'The MediLink server did not answer.', fix: 'Check your internet connection, then try again.', retryable: true };
const waitText = s => (s < 90 ? `${s} seconds` : `${Math.ceil(s / 60)} minutes`);
function toError(res, data) {
  const status = res.status;
  const e = data && data.title && data.message ? { ...data }
    : { code: data?.error?.code || 'UNEXPECTED', title: 'Something went wrong', message: 'We could not finish this just now.', fix: 'Try again in a minute. If it keeps happening, contact MediLink support.', retryable: status >= 500 };
  e.status = status;
  const wait = Number(res.headers.get('Retry-After'));
  if (status === 429 && wait > 0) e.retryAfter = wait; // RATE_LIMITED / TOO_MANY_LOGIN_ATTEMPTS: never auto-retry
  return e;
}
async function http(method, path, body, headers = {}) {
  let res;
  try {
    res = await fetch(path, {
      method, credentials: 'same-origin',
      headers: { ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch { throw NETWORK_ERROR; }
  let data = null;
  try { data = await res.json(); } catch { data = null; }
  if (!res.ok) throw toError(res, data);
  return data;
}

// ---------------------------------------------------------------- toast + error card
let toastTimer;
function toast(msg) {
  if (!msg) return;
  const t = $('#toast');
  t.textContent = msg; t.hidden = false;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => (t.hidden = true), 4200);
}
function errorCard(err, retryId) {
  return `<div class="errbox" role="alert">
    <div class="t">${icon('alert')}<span>${esc(err.title)}</span></div>
    <p>${esc(err.message)}</p><p class="fix">${esc(err.fix)}</p>
    ${err.retryAfter ? `<p class="fix">You can try again in ${esc(waitText(err.retryAfter))}.</p>` : ''}
    ${err.retryable && retryId ? `<button type="button" class="btn ghost small" id="${retryId}">${icon('refresh')}Try again</button>` : ''}
  </div>`;
}
/** Wires a Try again button; after a 429 it stays disabled until Retry-After has passed. */
function wireRetry(id, err, fn) {
  const b = document.getElementById(id);
  if (!b) return;
  b.addEventListener('click', fn);
  if (err.retryAfter) { b.disabled = true; setTimeout(() => { b.disabled = false; }, err.retryAfter * 1000); }
}

// ---------------------------------------------------------------- status words (colour AND a word, never colour alone)
const STATUS_WORD = { red: 'Needs attention', amber: 'In progress', green: 'On track', grey: 'Closed' };
const statusChip = (colour, word) => `<span class="status s-${esc(colour)}"><i aria-hidden="true"></i>${esc(word || STATUS_WORD[colour] || colour)}</span>`;

/** Steps [{key,label,at,done}] as an ordered stepper; the first step not done is the current one. */
function stepper(steps = []) {
  const cur = steps.findIndex(s => !s.done);
  return `<ol class="stepper">${steps.map((s, i) => `<li class="${s.done ? 'done' : i === cur ? 'now' : ''}" ${i === cur ? 'aria-current="step"' : ''}>
    <span class="sdot" aria-hidden="true">${s.done ? icon('check') : ''}</span><span class="sl">${esc(s.label)}<span class="sr-only">${s.done ? ' (done)' : i === cur ? ' (now)' : ''}</span></span>${s.done && s.at ? `<time datetime="${esc(s.at)}">${esc(timeIN(s.at))}</time>` : ''}</li>`).join('')}</ol>`;
}

/** Temperature chip + sparkline of recent readings against the allowed range. t = {current, range:{minC,maxC}, inRange, readings:[{at,c}]} */
function temperatureHtml(t) {
  if (!t || t.current == null) return '';
  const lo = t.range?.minC, hi = t.range?.maxC;
  const chip = statusChip(t.inRange === false ? 'red' : 'green', t.inRange === false ? 'Out of range' : 'In range');
  return `<div class="temp">${icon('thermo')}<b>${esc(Number(t.current).toFixed(1))} °C</b>${chip}${lo != null ? `<span class="muted">allowed ${esc(lo)}–${esc(hi)} °C</span>` : ''}${sparkline(t.readings, t.range)}</div>`;
}
function sparkline(readings = [], range) {
  const vals = readings.slice(-30).map(r => Number(r.c)).filter(Number.isFinite);
  if (vals.length < 2) return '';
  const lo = Number(range?.minC ?? NaN), hi = Number(range?.maxC ?? NaN);
  const min = Math.min(...vals, Number.isFinite(lo) ? lo : Infinity) - 0.5, max = Math.max(...vals, Number.isFinite(hi) ? hi : -Infinity) + 0.5;
  const W = 120, H = 32, y = v => (H - ((v - min) / (max - min)) * H).toFixed(1);
  const pts = vals.map((v, i) => `${((i / (vals.length - 1)) * W).toFixed(1)},${y(v)}`).join(' ');
  const band = Number.isFinite(lo) && Number.isFinite(hi) ? `<rect class="band" x="0" y="${y(hi)}" width="${W}" height="${(y(lo) - y(hi)).toFixed(1)}"/>` : '';
  return `<svg class="spark" viewBox="0 0 ${W} ${H}" role="img" aria-label="Last ${vals.length} readings, from ${vals[0].toFixed(1)} to ${vals[vals.length - 1].toFixed(1)} °C">${band}<polyline points="${pts}"/></svg>`;
}

/** A QR code as inline SVG (vendor/qrcode, MIT); only numbers reach the markup. */
function qrSvg(text) {
  if (typeof qrcode === 'undefined') return '';
  const q = qrcode(0, 'M'); q.addData(text); q.make();
  const n = q.getModuleCount();
  let d = '';
  for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (q.isDark(r, c)) d += `M${c + 4},${r + 4}h1v1h-1z`;
  return `<svg class="qr" viewBox="0 0 ${n + 8} ${n + 8}" shape-rendering="crispEdges" role="img" aria-label="QR code of the link"><rect width="100%" height="100%" fill="#fff"/><path d="${d}" fill="#26140D"/></svg>`;
}

// ---------------------------------------------------------------- action-form fields (rendered from the API's field descriptors)
const canScan = 'BarcodeDetector' in window && !!navigator.mediaDevices?.getUserMedia;
function fieldHtml(f, i, prefix = 'f') {
  const id = `${prefix}-${i}`, req = f.required ? 'required' : '';
  const hint = f.hint ? `<div class="muted" id="${id}-hint">${esc(f.hint)}</div>` : '';
  const err = `<div class="ferr" id="${id}-err" hidden></div>`;
  const desc = `aria-describedby="${f.hint ? id + '-hint ' : ''}${id}-err"`;
  let control;
  if (f.type === 'boolean') {
    control = `<div class="yesno">${[['true', 'Yes'], ['false', 'No']].map(([v, l]) => `<label class="opt"><input type="radio" name="${esc(f.name)}" value="${v}" ${String(f.default ?? '') === v ? 'checked' : ''}><b>${l}</b></label>`).join('')}</div>`;
    return `<fieldset class="fs"><legend class="label">${esc(f.label)}</legend>${control}${hint}${err}</fieldset>`;
  }
  if (f.type === 'choice') {
    if ((f.options || []).length <= 5) {
      control = `<div class="opts">${f.options.map(o => `<label class="opt"><input type="radio" name="${esc(f.name)}" value="${esc(o.value)}" ${String(f.default ?? '') === String(o.value) ? 'checked' : ''} ${req}><span><b>${esc(o.label)}</b>${o.reason ? `<small>${esc(o.reason)}</small>` : ''}</span></label>`).join('')}</div>`;
      return `<fieldset class="fs"><legend class="label">${esc(f.label)}</legend>${control}${hint}${err}</fieldset>`;
    }
    control = `<select class="input" id="${id}" name="${esc(f.name)}" ${req} ${desc}>${f.options.map(o => `<option value="${esc(o.value)}" ${String(f.default ?? '') === String(o.value) ? 'selected' : ''}>${esc(o.label)}</option>`).join('')}</select>`;
  } else if (f.type === 'file') {
    control = `<input class="input file" id="${id}" name="${esc(f.name)}" type="file" accept="${esc(f.accept || '')}" ${req} ${desc}>`;
  } else if (f.type === 'text' && /note|reason|stockText|question/i.test(f.name)) {
    control = `<textarea class="input" id="${id}" name="${esc(f.name)}" ${req} ${desc}>${esc(f.default ?? '')}</textarea>`;
  } else {
    const type = { number: 'number', date: 'date', tel: 'tel', email: 'email' }[f.type] || 'text';
    const extra = f.type === 'barcode' ? 'autocomplete="off" spellcheck="false" autocapitalize="characters"' : f.autocomplete ? `autocomplete="${esc(f.autocomplete)}"` : '';
    control = `<input class="input ${f.type === 'barcode' ? 'mono' : ''}" id="${id}" name="${esc(f.name)}" type="${type}" ${f.min !== undefined ? `min="${esc(f.min)}"` : ''} ${f.max !== undefined ? `max="${esc(f.max)}"` : ''} value="${esc(f.default ?? '')}" placeholder="${esc(f.placeholder || '')}" ${extra} ${req} ${desc}>`;
    if (f.type === 'barcode' && canScan) control = `<div class="scanrow">${control}<button type="button" class="btn ghost small" data-scan="${id}" ${/batch/i.test(f.name) ? 'data-multi' : ''}>${icon('camera')}Scan</button></div>`;
  }
  return `<div><label class="label" for="${id}">${esc(f.label)}</label>${control}${hint}${err}</div>`;
}
const readFile = (file, asText) => new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(asText ? r.result : String(r.result).replace(/^data:[^;]+;base64,/, '')); r.onerror = rej; asText ? r.readAsText(file) : r.readAsDataURL(file); });

/** Reads and checks a form built with fieldHtml; marks missing / out-of-range fields. Returns values or null. */
async function collect(form, fields, prefix = 'f') {
  const values = {}; let ok = true, first = null;
  for (const [i, f] of fields.entries()) {
    const errBox = form.querySelector(`#${prefix}-${i}-err`);
    let v;
    if (f.type === 'boolean' || (f.type === 'choice' && f.options.length <= 5)) v = form.querySelector(`input[name="${CSS.escape(f.name)}"]:checked`)?.value;
    else if (f.type === 'file') { const file = form.querySelector(`#${prefix}-${i}`).files[0]; if (file) { v = await readFile(file, f.name === 'csv'); if (f.name === 'imageBase64') values.mimeType = file.type || 'image/jpeg'; } }
    else v = form.querySelector(`#${prefix}-${i}`).value.trim();
    let msg = f.required && (v === undefined || v === '') ? 'Please fill this in.' : '';
    if (!msg && f.type === 'number' && v !== '' && v !== undefined && (!Number.isFinite(Number(v)) || (f.min !== undefined && Number(v) < f.min) || (f.max !== undefined && Number(v) > f.max))) msg = `Enter a number${f.min !== undefined ? ` from ${f.min}` : ''}${f.max !== undefined ? ` to ${f.max}` : ''}.`;
    if (errBox) { errBox.hidden = !msg; errBox.innerHTML = msg ? `${icon('alert')}<span>${esc(msg)}</span>` : ''; }
    form.querySelector(`#${prefix}-${i}`)?.setAttribute('aria-invalid', msg ? 'true' : 'false');
    if (msg) { ok = false; first ||= form.querySelector(`#${prefix}-${i}, input[name="${CSS.escape(f.name)}"]`); continue; }
    if (v === undefined || v === '') continue;
    values[f.name] = f.type === 'boolean' ? v === 'true' : f.type === 'number' || (f.type === 'choice' && typeof f.options[0]?.value === 'number') ? Number(v) : v;
  }
  first?.focus();
  return ok ? values : null;
}

// ---------------------------------------------------------------- camera barcode scanning (BarcodeDetector; manual entry always works)
function wireScan(root) {
  root.querySelectorAll('[data-scan]').forEach(b => b.addEventListener('click', () => scanInto(document.getElementById(b.dataset.scan), b.hasAttribute('data-multi'))));
}
async function scanInto(input, multi) {
  const dlg = $('#scan-dlg');
  dlg.innerHTML = `<form method="dialog" class="scanbox"><h2 id="scan-title">Scan the label</h2>
    <video id="scan-video" playsinline muted></video>
    <p class="muted" id="scan-msg" role="status">Hold the barcode inside the frame.</p>
    <div class="acts"><button class="btn ghost small" value="cancel">Type it instead</button></div></form>`;
  dlg.showModal();
  let stream = null, stop = false;
  dlg.addEventListener('close', () => { stop = true; stream?.getTracks().forEach(t => t.stop()); input.focus(); }, { once: true });
  try {
    stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' }, audio: false });
    if (stop) return stream.getTracks().forEach(t => t.stop());
    const v = $('#scan-video'); v.srcObject = stream; await v.play();
    const det = new BarcodeDetector();
    while (!stop) {
      const code = (await det.detect(v).catch(() => []))[0]?.rawValue;
      if (code) {
        const have = input.value.split(',').map(s => s.trim()).filter(Boolean);
        input.value = multi && have.length && !have.includes(code) ? [...have, code].join(', ') : code;
        toast(`Scanned ${code}`);
        return dlg.close();
      }
      await new Promise(r => setTimeout(r, 250));
    }
  } catch {
    const m = $('#scan-msg'); if (m) m.textContent = 'The camera is not available. Type the code instead.';
  }
}
