'use strict';
/* MediLink pharmacy portal: #/login and the signed-in screens on the experience API (/me/*, docs/EXPERIENCE_API.md).
   For hospital pharmacy staff (pharmacist, chief pharmacist / approver) and the MediLink admin. Couriers never sign in:
   they use courier.html from the per-delivery link. Sign-in: MediLink accounts (POST /auth/login); the Bearer token
   lives in memory and in sessionStorage (this tab only). Live updates over the WebSocket with a one-time ticket,
   polling as the fallback. Buttons and forms are rendered from the API's action descriptors. Synthetic data only. */

const STAFF = ['pharmacist', 'approver', 'admin'];
const isLocal = ['localhost', '127.0.0.1', '[::1]'].includes(location.hostname); // only decides the demo quick links

// ---------------------------------------------------------------- session + API
const STORE = 'medilink.session';
const session = (() => {
  try { const s = JSON.parse(sessionStorage.getItem(STORE)); if (s?.token && Date.parse(s.expiresAt) > Date.now()) return s; } catch { /* none */ }
  return { token: null, user: null, expiresAt: null };
})();
function saveSession(s) {
  Object.assign(session, s);
  try { if (session.token) sessionStorage.setItem(STORE, JSON.stringify({ token: session.token, user: session.user, expiresAt: session.expiresAt })); else sessionStorage.removeItem(STORE); } catch { /* private mode: memory only */ }
}
const role = () => session.user?.role;
let flash = null, lastHome = null;
let cleanups = [];
const onCleanup = fn => cleanups.push(fn);

async function api(method, path, body, headers = {}) {
  try { return await http(method, path, body, { ...(session.token ? { Authorization: `Bearer ${session.token}` } : {}), ...headers }); }
  catch (e) { if (e.status === 401 && session.token) signOut('Your sign-in has ended. Please sign in again.'); throw e; }
}
function signOut(message) {
  if (session.token) fetch('/auth/logout', { method: 'POST', headers: { Authorization: `Bearer ${session.token}` } }).catch(() => {});
  saveSession({ token: null, user: null, expiresAt: null });
  lastHome = null; liveStop();
  flash = message || null;
  if (location.hash !== '#/login') location.hash = '#/login'; else route();
}

// ---------------------------------------------------------------- live updates (WebSocket + one-time ticket, backoff; polling as fallback)
const live = { ws: null, open: false, starting: false, tries: 0, timer: 0, subs: new Set() };
async function liveStart() {
  if (live.ws || live.starting || live.timer || !session.token || !('WebSocket' in window)) return;
  live.starting = true;
  let ticket;
  try { ({ ticket } = await api('POST', '/auth/ws-ticket')); } catch { ticket = null; }
  live.starting = false;
  if (!session.token) return;
  if (!ticket) return liveRetry();
  const ws = live.ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws/tracking?ticket=${encodeURIComponent(ticket)}`);
  ws.onopen = () => { live.open = true; live.tries = 0; };
  ws.onmessage = e => {
    let m; try { m = JSON.parse(e.data); } catch { return; }
    for (const fn of live.subs) fn(m.event, m.data || {});
  };
  ws.onclose = () => { if (live.ws !== ws) return; live.ws = null; live.open = false; if (session.token) liveRetry(); };
}
function liveRetry() {
  clearTimeout(live.timer);
  const ms = Math.min(60000, 1000 * 2 ** live.tries++) * (0.75 + Math.random() / 2);
  live.timer = setTimeout(() => { live.timer = 0; liveStart(); }, ms);
}
function liveStop() {
  clearTimeout(live.timer); live.timer = 0; live.tries = 0;
  const ws = live.ws; live.ws = null; live.open = false; ws?.close();
}
const onLive = fn => { live.subs.add(fn); onCleanup(() => live.subs.delete(fn)); };
/** Refresh on a timer: every period while the socket is down, every 6th period as a safety net while it is up. */
function poll(fn, ms = 10000) {
  let n = 0;
  const id = setInterval(() => { if (document.hidden || $('#dlg').open || (live.open && ++n % 6)) return; fn(); }, ms);
  onCleanup(() => clearInterval(id));
}
function debounce(fn, ms = 400) { let t; onCleanup(() => clearTimeout(t)); return () => { clearTimeout(t); t = setTimeout(fn, ms); }; }

// ---------------------------------------------------------------- router
const ROUTES = [
  [/^#\/login$/, viewLogin, false],
  [/^#\/home$/, viewHome, true],
  [/^#\/onboarding$/, viewOnboarding, true],
  [/^#\/journey\/(.+)$/, viewJourney, true],
  [/^#\/stock$/, viewStock, true],
  [/^#\/city$/, viewCity, true],
  [/^#\/admin$/, viewOverview, true],
];
let routed = 0;
async function route() {
  cleanups.forEach(fn => { try { fn(); } catch { /* ignore */ } }); cleanups = [];
  if ($('#dlg').open) $('#dlg').close();
  const hash = location.hash || '#/login';
  const hit = ROUTES.find(([re]) => re.test(hash));
  if (!hit) { location.hash = session.token ? '#/home' : '#/login'; return; }
  const [re, view, needsAuth] = hit;
  if (needsAuth && !session.token) { location.hash = '#/login'; return; }
  if (!needsAuth && session.token) { location.hash = '#/home'; return; }
  if (needsAuth) liveStart();
  const run = () => view(...hash.match(re).slice(1).map(decodeURIComponent));
  // between signed-in screens the old page cross-fades into the new one (and a clicked card morphs into its detail)
  if (needsAuth && document.body.classList.contains('route-app')) await withTransition(run); else await run();
  const h1 = $('#view h1');
  if (h1) { h1.setAttribute('tabindex', '-1'); if (routed++) h1.focus({ preventScroll: true }); }
}
addEventListener('hashchange', route);

// ================================================================= LOGIN
function bottleShell(inner, { capId = 'cap', label }) {
  return `<div class="stage" id="stage">
    <svg class="cap" id="${capId}" viewBox="0 0 240 46" aria-hidden="true">
      <rect x="1" y="1" width="238" height="44" rx="11" fill="rgba(238,241,244,0.95)" stroke="rgba(38,20,13,0.14)"/>
      ${Array.from({ length: 27 }, (_, i) => `<line x1="${14 + i * 8}" y1="7" x2="${14 + i * 8}" y2="39" stroke="rgba(38,20,13,0.11)" stroke-width="2" stroke-linecap="round"/>`).join('')}
      <line x1="10" y1="4" x2="230" y2="4" stroke="rgba(255,255,255,0.95)" stroke-width="2" stroke-linecap="round"/>
    </svg>
    <div class="neck" aria-hidden="true"></div>
    <section class="bottle" id="bottle" aria-label="${esc(label)}">
      <div class="gloss" aria-hidden="true"></div>
      <div class="bottle-in">${inner}</div>
      <div class="floor" aria-hidden="true"><div class="floor-clip" id="floor-clip"></div></div>
    </section>
    <p class="stage-foot">MediLink / Prototype for SAP Hackfest 2026 / Demo data only</p>
  </div>`;
}

// Demo staff accounts (synthetic, password DEMO_PASSWORD): pharmacy staff only, never partners or couriers.
const DEMO_STAFF = [['ravi', 'Pharmacist', 'supplying hospital'], ['asha', 'Requesting pharmacist', 'sets up first'], ['meera', 'Chief pharmacist / approver', 'signs off transfers']];
const STAFF_ONLY = { code: 'STAFF_ONLY', title: 'This portal is for hospital pharmacy staff', message: "Delivery partners don't sign in here.", fix: 'Open the courier link sent for your delivery.', retryable: false };

function viewLogin() {
  document.body.className = 'route-stage';
  document.title = 'Sign in · MediLink';
  const note = flash; flash = null;
  $('#view').innerHTML = bottleShell(`
    <form class="login" id="login" novalidate>
      <div class="brandrow"><a class="wordmark" href="index.html">MediLink</a><span class="tag">Pharmacy staff</span></div>
      <h1 id="login-h">Welcome back</h1>
      <p class="serif">Spare medicine, delivered in condition.</p>
      ${note ? `<p class="note" role="status">${esc(note)}</p>` : ''}
      <div>
        <label class="label" for="username">Username</label>
        <div class="control">${icon('user', 'lead')}<input class="input" id="username" name="username" type="text" autocomplete="username" autocapitalize="none" spellcheck="false" aria-describedby="user-err" required></div>
        <div class="ferr" id="user-err" hidden></div>
      </div>
      <div>
        <div class="rowlabel"><label class="label" for="password">Password</label><button type="button" class="link" id="forgot">Forgot password?</button></div>
        <div class="control">${icon('lock', 'lead')}<input class="input pw" id="password" name="password" type="password" autocomplete="current-password" aria-describedby="pw-err" required>
          <button type="button" class="eye" id="eye" aria-label="Show password" aria-pressed="false">${icon('eye')}</button></div>
        <div class="ferr" id="pw-err" hidden></div>
      </div>
      <div id="login-error"></div>
      <button type="submit" class="btn block" id="signin">Sign in ${icon('arrowRight')}</button>
      <p class="center">Need access? Ask your MediLink admin.</p>
      <p class="note center">Delivery partners don't sign in here — open the courier link sent for your delivery.</p>
      <div id="demo-slot"></div>
    </form>`, { label: 'Sign in to MediLink' });
  if (!reduced) $('#stage').classList.add('fade-up');

  const form = $('#login'), user = $('#username'), pw = $('#password');
  const showErr = (input, box, msg) => {
    input.setAttribute('aria-invalid', msg ? 'true' : 'false');
    box.hidden = !msg; box.innerHTML = msg ? `${icon('alert')}<span>${esc(msg)}</span>` : '';
  };
  const checkUser = () => { const m = user.value.trim() ? '' : 'Enter your username.'; showErr(user, $('#user-err'), m); return !m; };
  const checkPw = () => { const m = pw.value ? '' : 'Enter your password.'; showErr(pw, $('#pw-err'), m); return !m; };
  user.addEventListener('blur', () => user.value && checkUser());
  pw.addEventListener('blur', () => pw.value && checkPw());
  $('#eye').addEventListener('click', e => {
    const show = pw.type === 'password'; pw.type = show ? 'text' : 'password';
    e.currentTarget.setAttribute('aria-pressed', String(show));
    e.currentTarget.setAttribute('aria-label', show ? 'Hide password' : 'Show password');
    e.currentTarget.innerHTML = icon(show ? 'eyeOff' : 'eye');
  });
  $('#forgot').addEventListener('click', () => toast('Your MediLink admin resets passwords.'));

  // demo quick links: on localhost, or when the server says demo accounts exist
  const showDemo = () => {
    const slot = $('#demo-slot'); if (!slot) return;
    slot.innerHTML = `<hr class="hairline"><div class="demorow"><span class="k">Demo staff:</span>
      ${DEMO_STAFF.map(([u, label, what]) => `<button type="button" class="link" data-user="${u}" aria-pressed="false" title="${esc(what)}">${esc(label)} <span class="muted">(${u})</span></button>`).join('')}</div>`;
    slot.querySelectorAll('[data-user]').forEach(b => b.addEventListener('click', () => {
      slot.querySelectorAll('[data-user]').forEach(x => x.setAttribute('aria-pressed', String(x === b)));
      user.value = b.dataset.user; checkUser();
      if (isLocal) { pw.value = 'demo'; checkPw(); $('#signin').focus(); } else pw.focus(); // the development password only on localhost
    }));
  };
  if (isLocal) showDemo(); else http('GET', '/health').then(h => h?.demoAccounts && showDemo()).catch(() => {});

  const pile = mountPile($('#floor-clip'), $('#bottle'), { interactive: true });
  onCleanup(() => pile.destroy());
  pw.addEventListener('focus', () => pile.wiggle());

  async function submit() {
    const okU = checkUser(), okP = checkPw();
    if (!okU || !okP) { (okU ? pw : user).focus(); return; }
    const btn = $('#signin');
    btn.setAttribute('aria-busy', 'true'); btn.disabled = true; btn.textContent = 'Signing in…';
    $('#login-error').innerHTML = '';
    try {
      const r = await http('POST', '/auth/login', { username: user.value.trim(), password: pw.value });
      if (!STAFF.includes(r.user?.role)) { fetch('/auth/logout', { method: 'POST', headers: { Authorization: `Bearer ${r.token}` } }).catch(() => {}); throw STAFF_ONLY; }
      saveSession({ token: r.token, expiresAt: r.expiresAt, user: r.user });
      lastHome = await api('GET', '/me/home');
      const next = lastHome.onboarding ? '#/onboarding' : '#/home';
      if (reduced) { location.hash = next; return; }
      $('#cap').classList.add('unscrew'); pile.jostle(); $('#stage').classList.add('leaving');
      setTimeout(() => { location.hash = next; }, 850);
    } catch (err) {
      $('#login-error').innerHTML = errorCard(err, 'login-retry');
      wireRetry('login-retry', err, submit);
      if (!reduced) { pile.hop(); const b = $('#bottle'); b.classList.remove('shake'); void b.offsetWidth; b.classList.add('shake'); }
      btn.removeAttribute('aria-busy'); btn.disabled = false; btn.innerHTML = `Sign in ${icon('arrowRight')}`;
      (err.code === 'LOGIN_FAILED' ? pw : btn).focus();
    }
  }
  form.addEventListener('submit', e => { e.preventDefault(); submit(); });
  user.focus();
}

// ================================================================= SIGNED-IN CHROME
// The sign-in skin carried through: floating glass nav, frosted panes over drifting orbs, pastel status + a word.
const ALERT_WORD = { LOW_STOCK: 'Low stock', OUT_OF_STOCK: 'Out of stock', EXPIRING: 'Expiring', EXPIRED: 'Expired', SHORTFALL: 'Shortfall', EXCURSION: 'Temperature', STALE_FEED: 'Data out of date', LICENCE_EXPIRY: 'Licence' };
const ALERT_GLYPH = { LOW_STOCK: 'low', OUT_OF_STOCK: 'out', EXPIRING: 'expiring', EXPIRED: 'expired', SHORTFALL: 'short', EXCURSION: 'alert', STALE_FEED: 'hospital', LICENCE_EXPIRY: 'alert' };
const STOCK_KINDS = new Set(['LOW_STOCK', 'OUT_OF_STOCK', 'EXPIRING', 'EXPIRED']);
const CONN = { stale: ['stale', 'Data out of date'], never: ['stale', 'Waiting for first sync'], disconnected: ['off', 'Not connected'] }; // a working feed shows nothing
const COVER_WORD = { short: 'Short', low: 'Below safety margin', covered: 'Covered', none: 'No bookings' };
const shortHospital = name => String(name || '').split(',')[0];
/** Visuals come from viz.js; one that fails leaves its slot empty instead of breaking the screen. */
const vz = fn => { try { return fn() ?? ''; } catch (e) { console.error(e); return ''; } };
const mount = fn => { const d = vz(fn); if (typeof d === 'function') onCleanup(d); };
const NUM = ['no', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten'];
const words = n => NUM[n] || fmtN(n);
const cap1 = s => s.charAt(0).toUpperCase() + s.slice(1);
const joinAnd = xs => (xs.length > 1 ? `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}` : xs[0] || '');
const CAP_SVG = `<svg class="mini-cap" viewBox="0 0 26 30" aria-hidden="true"><rect x="3" y="1" width="20" height="9" rx="3" fill="#EEF1F4" stroke="rgba(38,20,13,.22)"/>${[7, 10.5, 14, 17.5].map(x => `<line x1="${x}" y1="3.5" x2="${x}" y2="7.5" stroke="rgba(38,20,13,.25)" stroke-width="1.3" stroke-linecap="round"/>`).join('')}<rect x="1" y="11" width="24" height="18" rx="7" fill="rgba(255,255,255,.7)" stroke="rgba(38,20,13,.22)"/><rect x="6" y="20" width="9" height="5" rx="2.5" fill="#F4A7B9"/><rect x="13" y="18" width="8" height="5" rx="2.5" fill="#A9DFC1" transform="rotate(-18 17 20.5)"/></svg>`;

function flushCleanups() { cleanups.forEach(fn => { try { fn(); } catch { /* ignore */ } }); cleanups = []; }
/** quiet = a background refresh of the same screen: no entrance, numbers final (the caller keeps the scroll). */
function appShell(active, content, quiet) {
  flushCleanups(); // a re-render replaces the previous render's timers and listeners
  document.body.className = 'route-app';
  const h = lastHome, admin = role() === 'admin', c = h?.hospital?.connection;
  const links = admin ? [['#/home', 'Overview'], ['#/city', 'City']] : [['#/home', 'Home'], ['#/stock', 'Stock'], ['#/city', 'City']];
  const [tone, word] = (c && CONN[c.status]) || [];
  const who = admin ? '<span class="who-n">Administrator</span>'
    : h?.hospital ? `<span class="who-n">${esc(shortHospital(h.hospital.name))}</span>${word ? `<span class="feed f-${tone}" title="${esc(c.text)}"><i class="livedot" aria-hidden="true"></i>${esc(word)}</span>` : ''}` : '';
  $('#view').innerHTML = `
    <header class="nav glass">
      <a class="brand" href="#/home">${CAP_SVG}<span class="wordmark">MediLink</span></a>
      <nav class="pills" aria-label="Main">${links.map(([href, l]) => `<a href="${href}"${active === href ? ' aria-current="page"' : ''}>${l}</a>`).join('')}</nav>
      <div class="who">${who}</div>
      <button class="btn ghost small" id="signout" type="button" aria-label="Sign out">${icon('logout')}<span>Sign out</span></button>
    </header>
    <main class="page${quiet ? ' quiet' : ''}" id="main">${content}</main>`;
  $('#signout').addEventListener('click', () => signOut('You are signed out.'));
  sizeMarks($('#main'));
  onCleanup(fxMount($('#main'), quiet));
}
function viewError(err, active) {
  appShell(active, `<section class="hello rise"><p class="eyebrow">Something went wrong</p><h1>That did not load</h1></section><div class="pane rise">${errorCard(err, 'view-retry')}</div>`);
  wireRetry('view-retry', err, route);
}
/** Page header: a mono eyebrow, the Unbounded title, one data-driven serif sentence. */
const hello = (eyebrow, title, line) => `<section class="hello rise"><p class="eyebrow">${esc(eyebrow)}</p><h1>${esc(title)}</h1>${line ? `<p class="lede">${esc(line)}</p>` : ''}</section>`;
function pane(id, title, body, { label = '', right = '', cls = '' } = {}) {
  return `<section class="pane rise ${cls}" aria-labelledby="${id}"><header class="ph"><div>${label ? `<p class="eyebrow">${esc(label)}</p>` : ''}<h2 id="${id}">${esc(title)}</h2></div>${right}</header>${body}</section>`;
}
/** Count tile: glyph, counting number, what it counts, what it means. zeroOk = a zero is good news (muted 0 + check). */
function tile({ kind, label, value, of, sub, tone = 'ink', zeroOk, href, filter, cls = 's3' }) {
  const calm = zeroOk && !value, tag = href ? 'a' : 'div';
  return `<${tag} class="tile pane lift rise ${cls} t-${calm ? 'calm' : tone}"${href ? ` href="${esc(href)}"` : ''}${filter ? ` data-sf="${esc(filter)}"` : ''}>
    <span class="tile-g" aria-hidden="true">${vz(() => glyph(calm ? 'check' : kind))}</span>
    <span class="tile-v">${countHtml(value)}${of != null ? `<small>/${esc(fmtN(of))}</small>` : ''}</span>
    <span class="tile-l">${esc(label)}</span><span class="tile-s">${esc(sub)}</span>${href ? `<span class="tile-go" aria-hidden="true">${icon('arrowRight')}</span>` : ''}</${tag}>`;
}
const emptyState = text => `<div class="empty">${vz(() => emptyArt())}<p class="empty-t">${esc(text)}</p></div>`;
const countBadge = n => (n ? `<span class="count">${esc(n)}</span>` : '');
/** Shown only when the hospital's stock data is not live (the one place that says so). */
function feedBanner(h) {
  const c = h?.hospital?.connection;
  if (!c || c.status === 'connected') return '';
  const title = { stale: 'Your stock data is out of date', never: 'Waiting for your first stock update', disconnected: 'Your hospital software is not connected' }[c.status] || 'Check your connection';
  const off = c.status === 'disconnected';
  return `<div class="capbar rise t-${off ? 'rose' : 'sun'}" role="status"><span class="capbar-cap">${vz(() => glyph('hospital'))}${off ? 'Not connected' : 'Out of date'}</span><div class="capbar-b"><b>${esc(title)}</b><p>${esc(c.text)}</p></div>${c.action ? actionBtn(c.action) : ''}</div>`;
}

// ---------------------------------------------------------------- action buttons (rendered from the API's action descriptors)
let actionSeq = 0, actRect = null;
const actionRegistry = new Map();
function regAct(a) { const id = 'act-' + (++actionSeq); actionRegistry.set(id, a); return id; }
function actionBtn(a, extraCls = '', text = null) {
  if (!a) return '';
  const id = regAct(a);
  const cls = a.style === 'secondary' ? 'btn ghost small' : 'btn small';
  return `<button type="button" class="${cls} ${extraCls}" data-act="${id}" ${a.available === false ? `disabled title="${esc(a.unavailableReason || '')}"` : ''}>${esc(text || a.label)}</button>${a.available === false && a.unavailableReason ? `<span class="muted">${esc(a.unavailableReason)}</span>` : ''}`;
}
const PENCIL = '<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21.17 6.81a1 1 0 0 0-3.99-3.98L3.84 16.17a2 2 0 0 0-.5.83l-1.32 4.35a.5.5 0 0 0 .62.62l4.35-1.32a2 2 0 0 0 .83-.5z"/><path d="m15 5 4 4"/></svg>';
const editBtn = (a, name) => (a ? `<button type="button" class="ibtn" data-act="${regAct(a)}" aria-label="Edit reorder level: ${esc(name)}" title="Edit reorder level">${PENCIL}</button>` : '');
function wireActions(root, after) {
  root.querySelectorAll('[data-act]').forEach(b => b.addEventListener('click', () => { actRect = b.getBoundingClientRect(); openAction(actionRegistry.get(b.dataset.act), after); }));
}
function previewTable(rows) {
  if (!Array.isArray(rows) || !rows.length) return '';
  const cols = ['generic', 'strength', 'batchNo', 'quantity', 'expiryDate'].filter(c => rows.some(r => r[c] !== undefined));
  return `<div class="preview"><table><thead><tr>${cols.map(c => `<th>${esc(c)}</th>`).join('')}</tr></thead><tbody>${rows.map(r => `<tr>${cols.map(c => `<td>${esc(r[c])}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`;
}

/** Open an action: confirm and/or a small form built from its fields, then POST with an Idempotency-Key. */
function openAction(a, after, extraHtml = '') {
  const dlg = $('#dlg');
  const fields = a.fields || [];
  if (!fields.length && !a.confirm && !extraHtml) return runAction(a, {}, after);
  dlg.innerHTML = `<form method="dialog" id="dlg-form" novalidate>
      <p class="eyebrow">Action</p>
      <h2 id="dlg-title">${esc(a.label)}</h2>
      ${a.confirm ? `<p class="m0 ink">${esc(a.confirm)}</p>` : ''}
      ${extraHtml}
      ${fields.map((f, i) => fieldHtml(f, i)).join('')}
      <div id="dlg-error"></div>
      <div class="acts"><button type="button" class="btn ghost small" id="dlg-cancel">Cancel</button><button type="submit" class="btn small" id="dlg-ok">${esc(a.label)}</button></div>
    </form>`;
  dlg.showModal();
  wireScan(dlg);
  const key = newKey(); // one key per dialog: a double tap or a retry runs the action once
  $('#dlg-cancel').addEventListener('click', () => dlg.close());
  $('#dlg-form').addEventListener('submit', async e => {
    e.preventDefault();
    const values = await collect(e.target, fields);
    if (!values) return;
    const ok = $('#dlg-ok'); ok.disabled = true; ok.setAttribute('aria-busy', 'true'); ok.textContent = 'Working…';
    const done = await runAction(a, values, after, key, err => {
      $('#dlg-error').innerHTML = errorCard(err, 'dlg-retry');
      wireRetry('dlg-retry', err, () => $('#dlg-form').requestSubmit());
    });
    if (!done) { ok.disabled = false; ok.removeAttribute('aria-busy'); ok.textContent = a.label; }
  });
  dlg.querySelector('input,select,textarea,button[type=submit]')?.focus();
}
$('#dlg').addEventListener('click', e => { if (e.target.id === 'dlg') e.target.close(); });

async function runAction(a, values, after, key = newKey(), onError) {
  try {
    const r = await api(a.method || 'POST', a.path, { ...(a.body || {}), ...values }, { 'Idempotency-Key': key });
    toast(r?.message || a.done);
    if ($('#dlg').open) $('#dlg').close();
    if (/^(accept|approve)-/.test(a.id || '')) confetti(actRect); // milestones only: a request accepted, a transfer approved, a delivery received
    if (/courier-link$/.test(a.id) && r?.result?.url) showCourierLink(r.result);
    else handleNext(r || {}, after);
    await after?.(r);
    return true;
  } catch (err) {
    if (onError) onError(err);
    else {
      const dlg = $('#dlg');
      dlg.innerHTML = `<form method="dialog"><h2 id="dlg-title">${esc(a.label)}</h2>${errorCard(err, 'dlg-retry2')}<div class="acts"><button class="btn ghost small" value="close">Close</button></div></form>`;
      dlg.showModal();
      wireRetry('dlg-retry2', err, () => { dlg.close(); runAction(a, values, after, key); });
    }
    return false;
  }
}
function handleNext(r, after) {
  const n = r.next;
  if (!n) return;
  const dlg = $('#dlg');
  if (n.type === 'open') {
    // opened from a direct click: browsers block popups that start after an await
    dlg.innerHTML = `<form method="dialog"><h2 id="dlg-title">${esc(n.label)}</h2>
      <p class="m0">Your hospital software opens in a small window. Sign in as you do every day, check what is shared, then tap Allow.</p>
      <div class="acts"><button type="button" class="btn ghost small" id="open-cancel">Not now</button><button type="button" class="btn small" id="open-go">Open sign-in ${icon('arrowRight')}</button></div></form>`;
    dlg.showModal();
    $('#open-cancel').addEventListener('click', () => dlg.close());
    $('#open-go').addEventListener('click', () => {
      const win = window.open(n.url, 'medilink-allow', 'width=480,height=680');
      if (!win) location.href = n.url; // popups disabled entirely: continue in this tab
      dlg.close();
    });
  } else if (n.type === 'show') {
    dlg.innerHTML = `<form method="dialog"><h2 id="dlg-title">Send this to your IT team</h2>
      <p class="m0">Your IT team installs a small read-only connector and pairs it once with this code. It works for 24 hours.</p>
      <div class="code" aria-label="Pairing code">${esc(n.pairingCode)}</div>
      <p class="m0">Setup guide: <a href="${esc(n.setupLink)}" target="_blank" rel="noopener">${esc(n.setupLink)}</a></p>
      <div class="acts"><button class="btn small" value="ok">Done</button></div></form>`;
    dlg.showModal();
  } else if (n.type === 'action') {
    setTimeout(() => openAction(n.action, after, previewTable(r.result?.rows || r.result?.preview)), 50);
  }
}

/** The courier link for one delivery (supplying hospital): copy it, or let the rider scan the QR code. */
function showCourierLink({ url, expiresAt }) {
  const dlg = $('#dlg');
  dlg.innerHTML = `<form method="dialog"><h2 id="dlg-title">Courier link</h2>
    <p class="m0">Send this link to the delivery partner's rider. It opens the pickup scan and live location sharing for this delivery only${expiresAt ? `, and works until ${esc(timeIN(expiresAt))} on ${esc(new Date(expiresAt).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', timeZone: 'Asia/Kolkata' }))} or until it is delivered` : ''}.</p>
    <div class="linkbox"><input class="input mono" id="cl-url" readonly value="${esc(url)}" aria-label="Courier link"><button type="button" class="btn small" id="cl-copy">${icon('copy')}Copy</button></div>
    <div class="qrwrap">${qrSvg(url)}</div>
    <p class="muted m0">Treat it like a key: anyone with the link can act as the courier for this delivery.</p>
    <div class="acts"><button class="btn ghost small" value="close">Close</button></div></form>`;
  dlg.showModal();
  $('#cl-copy').addEventListener('click', async () => {
    try { await navigator.clipboard.writeText(url); toast('Link copied.'); } catch { $('#cl-url').select(); toast('Press Ctrl+C (or ⌘C) to copy the selected link.'); }
  });
  $('#cl-copy').focus();
}

// ---------------------------------------------------------------- tasks, alerts, live order cards
const URGENCY_WORD = { high: 'Do now', medium: 'Today', low: 'When you can' };
const when = iso => new Date(iso).toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit', timeZone: 'Asia/Kolkata' });
function taskItem(t, i) {
  const due = t.dueBy ? (t.dueBy.length > 10 ? 'By ' + timeIN(t.dueBy) : 'Needed by ' + dateIN(t.dueBy)) : '';
  const details = t.journeyId && !t.journeyId.startsWith('shortfall:') ? `<a class="link" href="#/journey/${encodeURIComponent(t.journeyId)}">Details<span class="sr-only">: ${esc(t.title)}</span></a>` : '';
  return `<li class="task drop"><span class="badge" aria-hidden="true">${i + 1}</span><div class="task-b">
    <div class="task-top">${statusChip(t.colour, URGENCY_WORD[t.urgency] || 'To do')}${due ? `<span class="muted">${esc(due)}</span>` : ''}</div>
    <b class="task-t">${esc(t.title)}</b><p class="task-p">${esc(t.subtitle)}</p>
    <div class="acts">${actionBtn(t.primaryAction)}${actionBtn(t.secondaryAction)}${details}</div></div></li>`;
}
/** A capsule: the left cap carries the severity tone and the word, the right half the message and actions. */
function alertItem(a) {
  const red = (a.colour || a.severity) === 'red'; // home alerts carry severity red|amber, inbox rows carry colour
  const links = [
    STOCK_KINDS.has(a.kind) && location.hash !== '#/stock' ? '<a class="link" href="#/stock">Open stock</a>' : '',
    a.journeyId ? `<a class="link" href="#/journey/${encodeURIComponent(a.journeyId)}">Open delivery</a>` : '',
  ].join('');
  const acts = (a.actions || []).map(x => actionBtn(x)).join('') + links;
  return `<li class="al t-${red ? 'rose' : 'sun'}"><span class="al-cap">${vz(() => glyph(ALERT_GLYPH[a.kind] || 'alert'))}<b>${esc(ALERT_WORD[a.kind] || 'Alert')}</b><small>${red ? 'Urgent' : 'Heads-up'}</small></span>
    <div class="al-b"><p class="al-m">${esc(a.message)}</p>${a.createdAt ? `<span class="muted">${esc(when(a.createdAt))}${a.ackedAt ? ' · seen' : ''}</span>` : ''}${acts ? `<div class="acts">${acts}</div>` : ''}</div></li>`;
}
/** Three capsules visible, the rest folded into a stack behind the third ("+n more" opens it; always open under reduced motion). */
function alertStack(list, id) {
  const more = reduced ? 0 : list.length - 3;
  return `<ul class="alstack${more > 0 ? ' folded' : ''}" id="${id}" aria-live="polite">${list.map(alertItem).join('')}</ul>${more > 0 ? `<button type="button" class="more" data-more="${id}" aria-expanded="false" aria-controls="${id}">+${more} more</button>` : ''}`;
}
function wireMore(root) {
  root.querySelectorAll('[data-more]').forEach(b => b.addEventListener('click', () => { $('#' + b.dataset.more).classList.remove('folded'); b.remove(); }));
}
const withWho = j => (j.counterpart ? `<span class="muted">${j.perspective === 'supplier' ? 'To' : 'From'}</span> ${esc(j.counterpart)}` : [j.from, j.to].filter(Boolean).map(esc).join(' → ') || '–');
/** Chip colour for a journey: the API's red wins; otherwise in transit = sky, waiting on someone = violet, done = brown. */
const journeyTone = j => (j.colour === 'red' ? 'red' : j.stage >= 7 ? 'ink' : j.stage >= 5 ? 'sky' : j.stage >= 2 ? 'violet' : j.colour);
/** While on the way, the current capsule fills by elapsed / (elapsed + time left) since pickup. */
function creep(j) {
  const p = j.timeline?.find(e => e.kind === 'picked_up');
  if (!p || !j.eta) return 0.5;
  const done = Date.now() - Date.parse(p.at), left = Math.max(0, Date.parse(j.eta) - Date.now());
  return done + left > 0 ? done / (done + left) : 0.5;
}
function rail(j, big) {
  return `<div class="rail${big ? ' big' : ''}" data-loop role="progressbar" aria-valuemin="1" aria-valuemax="${j.of}" aria-valuenow="${j.stage}" aria-valuetext="Stage ${j.stage} of ${j.of}: ${esc(j.stageLabel)}">${Array.from({ length: j.of }, (_, i) => {
    const n = i + 1, now = n === j.stage && j.stage < j.of;
    return `<i class="${n < j.stage || n === j.of && j.stage === j.of ? 'on' : now ? 'now' : ''}"${now ? ` data-fill="${j.stage === 5 ? creep(j).toFixed(3) : 0.5}"` : ''}></i>`;
  }).join('')}</div>`;
}
const etaMin = j => (j.eta && j.stage === 5 ? Math.max(0, Math.round((Date.parse(j.eta) - Date.now()) / 60000)) : null);
/** A live order card: what, who, the seven-capsule rail, a big ETA, the cold chain, and what you can do. */
function orderCard(j) {
  const t = j.temperatureC, em = etaMin(j);
  const big = em != null ? `${esc(em)}<small> min</small>` : esc(j.stage >= 7 ? 'Done' : j.stage === 6 ? 'Arrived' : j.stageLabel);
  const track = j.requestId ? `<a class="btn small ${j.stage === 5 || j.stage === 6 ? '' : 'ghost'} o-track" href="#/journey/${encodeURIComponent(j.id)}" data-vt>${j.stage === 5 || j.stage === 6 ? 'Track' : 'Open'}<span class="sr-only">: ${esc(j.drug.name)}</span>${icon('arrowRight')}</a>` : '';
  return `<article class="order pane lift" aria-label="${esc(j.drug.name)}: ${esc(j.stageLabel)}">
    <header class="o-top"><div><p class="eyebrow">${j.perspective === 'supplier' ? 'Sending' : j.perspective === 'admin' ? 'Transfer' : j.stage === 1 ? 'Shortfall' : 'Incoming'} / ${esc(j.stageLabel)}</p>
      <h3 class="o-drug">${esc(j.drug.name)}</h3><p class="o-who">${j.qty ? `<b>${esc(fmtN(j.qty))} ${j.stage === 1 ? 'doses' : 'vials'}</b> · ` : ''}${withWho(j)}</p></div>
      ${t != null ? `<div class="o-thermo">${vz(() => thermoChip({ current: t, range: { minC: 2, maxC: 8 }, inRange: t >= 2 && t <= 8 }))}</div>` : ''}</header>
    ${rail(j)}
    <div class="o-eta"><span class="o-big">${big}</span>${em != null ? `<span class="muted">arrives ${esc(timeIN(j.eta))}</span>` : ''}${j.neededBy ? `<span class="o-by">Latest by ${esc(dateIN(j.neededBy))}</span>` : ''}</div>
    <p class="o-head">${statusChip(journeyTone(j), j.colour === 'red' ? 'Needs attention' : j.stageLabel)}<span>${esc(j.headline)}</span></p>
    <div class="acts">${(j.actions || []).map(a => actionBtn(a)).join('')}${track}</div>
  </article>`;
}
/** The clicked card morphs into the journey page (View Transitions). */
function wireTrack(root) {
  root.querySelectorAll('a[data-vt]').forEach(a => a.addEventListener('click', () => { a.closest('.order').style.viewTransitionName = 'hero'; }));
}

// ================================================================= HOME
function coverLine(cs) {
  if (!cs?.drugs?.length) return '';
  const short = cs.drugs.filter(d => d.status === 'short').sort((a, b) => String(a.firstAffectedDate).localeCompare(String(b.firstAffectedDate)));
  const low = cs.drugs.filter(d => d.status === 'low');
  if (short.length === 1) return `${short[0].name} runs short ${short[0].firstAffectedDate ? `on ${dateIN(short[0].firstAffectedDate)}` : `in the next ${cs.windowDays} days`}.`;
  if (short.length) return `${cap1(words(short.length))} medicines run short in the next ${cs.windowDays} days, first ${short[0].name}.`;
  if (low.length) return `Everything critical is covered for ${cs.windowDays} days, but ${low[0].name}${low.length > 1 ? ` and ${words(low.length - 1)} more dip` : ' dips'} below your safety margin.`;
  return `Everything critical is covered for the next ${cs.windowDays} days.`;
}
async function viewHome(quiet) {
  if (role() === 'admin') return viewOverview(quiet);
  document.title = 'Home · MediLink';
  let h;
  try { h = await api('GET', '/me/home'); } catch (err) { return viewError(err, '#/home'); }
  lastHome = h;
  const y = scrollY, cs = h.coverSummary, ss = h.stockSummary, banner = feedBanner(h);
  const alerts = h.alerts.filter(a => !(banner && a.kind === 'STALE_FEED')); // the banner at the top says it once
  const drugs = cs?.drugs || [];
  const shortJ = id => h.journeys.find(j => j.id === `shortfall:${id}`);
  const worry = drugs.filter(d => d.status === 'short' || d.status === 'low').sort((a, b) => (a.status === 'short' ? 0 : 1) - (b.status === 'short' ? 0 : 1));
  const side = worry.length ? worry.slice(0, 4) : drugs.filter(d => d.status === 'covered').sort((a, b) => a.stock / Math.max(1, a.booked) - b.stock / Math.max(1, b.booked)).slice(0, 3);
  const cvItem = d => {
    const [tone, colour] = { short: ['rose', 'red'], low: ['sun', 'amber'] }[d.status] || ['mint', 'green'];
    const sub = d.status === 'short' ? `${fmtN(d.shortfall)} doses short${d.firstAffectedDate ? ` from ${dateIN(d.firstAffectedDate)}` : ''}` : `${fmtN(d.stock)} in stock for ${fmtN(d.booked)} booked`;
    const act = d.status === 'short' ? shortJ(d.id)?.actions?.[0] : null;
    return `<li class="cv t-${tone}"><span class="cv-pill" aria-hidden="true"></span><span class="cv-b"><b>${esc(d.name)}</b><small>${esc(sub)}</small></span>${statusChip(colour, COVER_WORD[d.status])}${act ? actionBtn(act) : ''}</li>`;
  };
  const sf = (kind, label, value, tone, filter, yes, no) => tile({ kind, label, value, tone, zeroOk: true, href: '#/stock', filter, sub: value ? yes : no });
  appShell('#/home', `
    ${banner}
    ${hello([h.greeting || 'Your pharmacy today', h.hospital?.licence?.text].filter(Boolean).join(' / '), h.hospital ? shortHospital(h.hospital.name) : 'Home', coverLine(cs) || (h.onboarding ? 'Connect your hospital software, and your cover shows up here.' : cs?.emptyText))}
    ${h.onboarding ? `<div class="capbar rise t-sun"><span class="capbar-cap">${vz(() => glyph('hospital'))}Setting up</span><div class="capbar-b"><b>Finish setting up</b><p>${esc(h.onboarding.message)}</p></div><a class="btn small" href="#/onboarding">Continue ${icon('arrowRight')}</a></div>` : ''}
    <div class="bento">
      <section class="pane hero s7 rise" id="hero" aria-labelledby="cv-h">
        <header class="ph"><div><p class="eyebrow">Cover / next ${esc(cs?.windowDays ?? 14)} days</p><h2 id="cv-h">Critical medicines</h2></div>${cs && drugs.length ? statusChip(cs.red ? 'red' : cs.amber ? 'amber' : 'green', cs.red ? `${cs.red} short` : cs.amber ? `${cs.amber} low` : 'All covered') : ''}</header>
        ${drugs.length ? `<div class="hero-in"><div class="ringhost" id="ring"></div>
          <div class="hero-side"><p class="eyebrow">${worry.length ? 'Needs you' : 'Closest to the line'}</p><ul class="cvlist">${side.map(cvItem).join('')}</ul>
          <a class="link" href="#/stock">See all stock</a></div></div>` : emptyState('Your cover shows here once your stock and bookings arrive.')}
      </section>
      ${pane('tasks-h', 'To do', h.tasks.length ? `<ol class="tasks">${h.tasks.map(taskItem).join('')}</ol>` : emptyState(h.empty?.tasks || 'Nothing needs you right now.'), { label: 'Requests / approvals', right: countBadge(h.tasks.length), cls: 's5' })}
      ${ss ? [
        sf('out', 'Out of stock', ss.out, 'rose', 'out', 'Nothing usable left', 'Nothing has run out'),
        sf('low', 'Low stock', ss.low, 'sun', 'low', 'At or under the reorder level', 'All above reorder level'),
        sf('expiring', 'Expiring soon', ss.expiring, 'sun', 'expiring', 'Batches to use or offer first', 'Nothing close to expiry'),
        sf('expired', 'Expired', ss.expired, 'rose', 'expired', 'Batches to take off the shelf', 'None on the shelf'),
      ].join('') : ''}
      ${pane('alerts-h', 'Alerts', alerts.length ? alertStack(alerts, 'home-al') : emptyState(h.empty?.alerts || 'No alerts. All clear.'), { label: 'Stock / expiry / deliveries', right: countBadge(alerts.length), cls: 's5' })}
      ${pane('j-h', 'Requests & deliveries', h.journeys.length ? `<div class="orders">${h.journeys.map(orderCard).join('')}</div>` : emptyState(h.empty?.journeys || 'No medicine on the move for you right now.'), { label: 'Swap / lend / borrow', cls: 's7' })}
    </div>`, quiet);
  if (drugs.length) mount(() => capsuleRing($('#ring'), drugs, { windowDays: cs.windowDays, onSelect: x => {
    const d = typeof x === 'string' ? drugs.find(v => v.id === x) : x;
    const act = d?.status === 'short' ? shortJ(d.id)?.actions?.[0] : null;
    if (act) return openAction(act, () => viewHome(true));
    stockFilter = d && d.status !== 'covered' ? 'care' : 'all'; location.hash = '#/stock';
  } }));
  onCleanup(tilt($('#hero')));
  const main = $('#main');
  wireActions(main, () => viewHome(true));
  wireMore(main); wireTrack(main);
  main.querySelectorAll('[data-sf]').forEach(a => a.addEventListener('click', () => { stockFilter = a.dataset.sf; }));
  if (quiet) scrollTo(0, y);
  const refresh = async () => {
    try { const fresh = await api('GET', '/me/home'); if (!$('#dlg').open && JSON.stringify(fresh) !== JSON.stringify(lastHome)) viewHome(true); } catch { /* keep the screen */ }
  };
  poll(refresh);
  const soon = debounce(refresh);
  onLive(event => { if (event !== 'tracking') soon(); });
}

// ================================================================= ONBOARDING (checklist inside the bottle)
async function viewOnboarding() {
  document.title = 'Set up · MediLink';
  let ob;
  try { ob = await api('GET', '/me/onboarding'); } catch (err) { return viewError(err, '#/home'); }
  document.body.className = 'route-stage';
  const stepIcon = s => (s.status === 'done' ? icon('check') : s.status === 'blocked' ? icon('alert') : '');
  $('#view').innerHTML = bottleShell(`
    <div class="brandrow"><a class="wordmark" href="#/home">MediLink</a><span class="tag">Setting up</span></div>
    <h1 class="ob-h1">${ob.done ? "You're connected" : 'Connect your hospital'}</h1>
    <p class="serif">${esc(ob.message)}</p>
    <ol class="steps">${ob.steps.map((s, i) => `<li class="step ${esc(s.status)}" ${s.status === 'current' ? 'aria-current="step"' : ''}><span class="dot">${stepIcon(s) || i + 1}</span><span><b>${esc(s.label)}<span class="sr-only"> (${esc(s.status)})</span></b><span>${esc(s.detail)}</span></span></li>`).join('')}</ol>
    ${ob.error ? errorCard(ob.error) : ''}
    <div class="stackacts">
      ${ob.done ? `<a class="btn block" href="#/home">Go to my board ${icon('arrowRight')}</a>` : ob.nextAction ? actionBtn({ ...ob.nextAction, style: 'primary' }, 'block') : ''}
    </div>
    ${ob.fallbacks?.length ? `<hr class="hairline"><p class="label m0">Other ways to connect</p><div class="fallbacks">${ob.fallbacks.map(a => actionBtn({ ...a, style: 'secondary' })).join('')}</div>` : ''}
  `, { label: 'Connect your hospital' });
  $('#view .bottle-in .btn.block')?.classList.remove('small');
  wireActions($('#view'), () => viewOnboarding());
  const pile = mountPile($('#floor-clip'), $('#bottle'), { interactive: false });
  onCleanup(() => pile.destroy());
  // the hospital software's sign-in popup (our own callback page) tells us when the Allow step is done
  const onMsg = e => { if (e.origin === location.origin && e.data?.medilink === 'connected') { toast('Connected. Your board will be ready in a few minutes.'); viewOnboarding(); } };
  addEventListener('message', onMsg); onCleanup(() => removeEventListener('message', onMsg));
  if (!ob.done) poll(async () => { try { const fresh = await api('GET', '/me/onboarding'); if (fresh.current !== ob.current) viewOnboarding(); } catch { /* ignore */ } }, 4000);
}

// ================================================================= JOURNEY DETAIL (+ live tracking)
const STAGES = ['Shortfall', 'Request', 'Supplier', 'Approval', 'On the way', 'Arrived', 'Done'];
function journeySummary(j, first) {
  const facts = [
    ['Quantity', j.qty ? `${j.qty} vials` : null], ['Needed by', j.neededBy ? dateIN(j.neededBy, true) : null],
    ['From', j.from], ['To', j.to], ['Arriving', j.eta ? timeIN(j.eta) : null],
    ['Temperature', j.temperatureC != null ? `${j.temperatureC.toFixed(1)} °C` : null],
    ['Loan', j.loan ? `${j.loan.qty} vials · ${j.loan.status === 'OPEN' ? 'open' : 'repaid'} · ${j.loan.mode === 'IN_KIND' ? 'repay in kind' : 'repay at cost'}` : null],
  ].filter(([, v]) => v);
  return `<section class="pane hero jsum${first ? ' rise' : ''}" aria-labelledby="j-h1">
      <div class="j-top"><p class="eyebrow">Journey / stage ${esc(j.stage)} of ${esc(j.of)}</p>${statusChip(journeyTone(j), j.colour === 'red' ? 'Needs attention' : j.stageLabel)}</div>
      <div>${rail(j, true)}<div class="stagenames" aria-hidden="true">${STAGES.map((s, i) => `<span class="${i + 1 < j.stage ? 'done' : i + 1 === j.stage ? 'now' : ''}">${s}</span>`).join('')}</div></div>
      <h1 class="j-h1" id="j-h1">${esc(j.drug.name)}</h1>
      <p class="lede">${esc(j.headline)}</p>
      <dl class="readouts">${facts.map(([k, v]) => `<div class="ro"><dt class="ro-k">${esc(k)}</dt><dd class="ro-v">${esc(v)}</dd></div>`).join('')}</dl>
      ${j.note ? `<div class="ro"><p class="ro-k">Handling note</p><p class="ro-v">${esc(j.note)}</p></div>` : ''}
      ${(j.actions || []).length ? `<div class="acts">${j.actions.map(a => actionBtn(a)).join('')}</div>` : ''}
    </section>`;
}
const timelineHtml = (j, first) => `<section class="pane tlpane${first ? ' rise' : ''}" aria-labelledby="tl-h"><header class="ph"><div><p class="eyebrow">Timeline</p><h2 id="tl-h">What happened</h2></div></header>
  ${j.timeline.length ? `<ol class="tl">${j.timeline.map(e => `<li><time class="tl-when tl-mono" datetime="${esc(e.at)}">${esc(e.time)}</time><span class="tl-dot" aria-hidden="true"></span><p>${esc(e.text)}</p></li>`).join('')}</ol>` : emptyState('Nothing has happened yet.')}</section>`;

async function viewJourney(id) {
  document.title = 'Journey · MediLink';
  let j;
  try { j = await api('GET', `/me/journeys/${encodeURIComponent(id)}`); } catch (err) { return viewError(err, '#/home'); }
  if (!lastHome) { try { lastHome = await api('GET', '/me/home'); } catch { /* chrome without status */ } }
  appShell('#/home', `<a class="back rise" href="#/home">${icon('arrowLeft')}Back to ${role() === 'admin' ? 'overview' : 'home'}</a>
    <div class="bento"><div id="j-sum" class="s7"></div><div id="j-tl" class="s5"></div><div id="j-track" class="s12 legs"></div></div>`);
  $('#j-sum').style.viewTransitionName = 'hero'; // the delivery card that was clicked morphs into this pane
  const track = trackingSection($('#j-track'), j.id);
  onCleanup(() => track.destroy());
  const after = r => (r?.journey ? paint(r.journey) : refresh());
  let first = true;
  function paint(next) {
    // keep keyboard focus on the same button when the summary is redrawn
    const focused = document.activeElement?.closest('#j-sum') ? document.activeElement.textContent : null;
    j = next;
    $('#j-sum').innerHTML = journeySummary(j, first);
    $('#j-tl').innerHTML = timelineHtml(j, first);
    onCleanup(fxMount($('#j-sum'), !first));
    first = false;
    wireActions($('#j-sum'), after);
    if (focused) [...$('#j-sum').querySelectorAll('button, a')].find(b => b.textContent === focused)?.focus();
    track.sync(j);
    if (j.stage >= 6) { // arrived or done: celebrate once per journey
      let seen = true; try { seen = !!sessionStorage.getItem('medilink.cf.' + j.id); sessionStorage.setItem('medilink.cf.' + j.id, '1'); } catch { /* private mode */ }
      if (!seen) confetti($('#j-sum').getBoundingClientRect());
    }
  }
  async function refresh() {
    try { const fresh = await api('GET', `/me/journeys/${encodeURIComponent(id)}`); if (JSON.stringify(fresh) !== JSON.stringify(j)) paint(fresh); } catch { /* keep the screen */ }
  }
  paint(j);
  poll(refresh);
  poll(() => track.reload(), 20000); // the tracking API asks for 15-30 s polls
  onLive((event, data) => {
    if (event === 'journey.updated' && data.journey?.id === j.id) { if (JSON.stringify(data.journey) !== JSON.stringify(j)) paint(data.journey); track.reload(); }
    else if (event === 'tracking') track.live(data);
    else if (['excursion', 'replan', 'status'].includes(event) && track.has(data.transferId)) track.reload();
  });
}

/** Live tracking cards for the legs the API returns (assigned, on the way, or delivered in the last 2 h).
    The receiving hospital (and admin) get the map; the supplying hospital a lighter card without map or phone. */
function trackingSection(el, journeyId) {
  const panels = new Map();
  let on = false, persp = null;
  const clear = () => { panels.forEach(p => p.destroy()); panels.clear(); el.innerHTML = ''; };
  async function reload() {
    let t;
    try { t = await api('GET', `/me/journeys/${encodeURIComponent(journeyId)}/tracking`); } catch { return; }
    if (!on) return; // the journey moved on while loading
    const legs = t.legs || [];
    if (t.perspective === persp && legs.length === panels.size && legs.every(l => panels.has(l.transferId))) return legs.forEach(l => panels.get(l.transferId).update(l));
    clear(); persp = t.perspective;
    el.innerHTML = legs.map(l => legHtml(l, persp)).join('');
    for (const l of legs) panels.set(l.transferId, mountLeg(el.querySelector(`[data-leg="${CSS.escape(l.transferId)}"]`), l, persp, reload));
  }
  return {
    sync(j) { const want = j.stage >= 5; if (want === on) return; on = want; if (on) reload(); else clear(); },
    reload: () => on && reload(),
    live: d => panels.get(d.transferId)?.live(d),
    has: id => panels.has(id),
    destroy: clear,
  };
}
const legHtml = (l, persp) => `<section class="pane leg rise" data-leg="${esc(l.transferId)}" aria-label="Tracking: ${esc(l.drug?.name)}">
  <div class="lt-head"><div class="lt-eta" role="status" aria-live="polite"></div><div class="lt-flags"></div></div>
  <div class="lt-banner"></div>
  <div class="lt-steps"></div>
  <div class="lt-grid ${persp === 'supplier' ? 'nomap' : ''}">
    ${persp === 'supplier' ? '' : `<div class="well"><div class="lt-map" role="region" aria-label="Map from ${esc(l.origin?.name)} to ${esc(l.destination?.name)} with the courier's position"></div></div>`}
    <div class="lt-side"><div class="ro lt-partner"></div><div class="ro lt-temp"></div><div class="lt-trace"></div><p class="lt-note muted" aria-live="polite"></p></div>
  </div>
</section>`;

/** WS tracking events carry the latest temperature without the history: append it to the readings. */
function mergeTemp(old, t, at) {
  if (!t || t.current == null) return old;
  return { ...old, ...t, readings: [...(old?.readings || []), { at, c: t.current }].slice(-20) };
}
function mountLeg(root, leg, persp, reload) {
  const q = s => root.querySelector(s);
  const map = q('.lt-map') && liveMap(q('.lt-map'), { ...leg, riderLabel: leg.riderName || leg.partner?.name || 'Courier' });
  let cur = leg, routeKey = JSON.stringify(leg.route), traceAt = 0, traceKill = null;
  // the trace redraws at most every 30 s: its draw-on entrance should not replay on every 5 s reading
  function trace(force) {
    const t = cur.temperature, box = q('.lt-trace');
    if (!box || !t?.readings?.length || (!force && Date.now() - traceAt < 30000)) return;
    traceAt = Date.now(); traceKill?.(); traceKill = null;
    const min = t.range?.minC ?? 2, max = t.range?.maxC ?? 8;
    const d = vz(() => tempTrace(box, { points: t.readings.map(r => ({ at: r.at, c: r.c, out: r.c < min || r.c > max })), min, max }));
    if (typeof d === 'function') traceKill = d;
  }
  function paint() {
    const l = cur, text = String(l.etaText || ''), [big, at] = text.split(' · '), arrived = /^arriv/i.test(text);
    const sub = [at && !arrived ? `at ${at}` : '', l.remainingKm != null ? `${Number(l.remainingKm).toFixed(1)} km to go` : ''].filter(Boolean).join(' · ');
    const step = k => l.steps?.find(s => s.key === k);
    const waiting = step('arrived')?.done && !step('delivered')?.done; // at the door: no countdown, say who has to act
    q('.lt-eta').innerHTML = waiting
      ? `<p class="eyebrow">Status</p><p class="eta">Arrived</p><p class="eta-sub">${persp === 'receiver' ? 'The courier is at your pharmacy. Receive it to finish.' : `At ${esc(l.destination?.name || 'the receiving pharmacy')}, waiting to be received.`}</p>`
      : text
      ? `<p class="eyebrow">${arrived ? 'Status' : 'Arriving in'}</p><p class="eta">${esc(arrived ? text : big)}</p>${sub ? `<p class="eta-sub">${esc(sub)}</p>` : ''}`
      : `<p class="eyebrow">Status</p><p class="eta">${esc(l.steps?.find(s => !s.done)?.label || 'Courier assigned')}</p>`;
    q('.lt-flags').innerHTML = l.delayed ? statusChip('amber', 'Running late') : '';
    q('.lt-banner').innerHTML = l.excursion ? `<div class="capbar t-rose" role="alert"><span class="capbar-cap">${vz(() => glyph('alert'))}Temperature</span><div class="capbar-b"><b>Temperature went out of range on the way.</b><p>${persp === 'supplier' ? 'The receiving pharmacy will check it on arrival.' : "When it arrives, set it aside (quarantine) and don't use it until it has been checked."}</p></div></div>` : '';
    q('.lt-steps').innerHTML = stepper(l.steps);
    const tel = persp !== 'supplier' && l.riderPhone ? String(l.riderPhone).replace(/[^\d+]/g, '') : '';
    q('.lt-partner').innerHTML = `<p class="ro-k">Courier</p><p class="ro-v">${esc(l.partner?.name)}</p>${l.riderName ? `<p class="muted m0">${esc(l.riderName)}</p>` : ''}
      ${tel ? `<a class="btn small" href="tel:${esc(tel)}">${icon('phone')}Call ${esc(l.riderName || 'the rider')}</a>` : ''}`;
    q('.lt-temp').innerHTML = l.temperature?.current != null ? `<p class="ro-k">Cold chain</p>${vz(() => thermoChip(l.temperature))}` : '';
    q('.lt-temp').hidden = l.temperature?.current == null;
    q('.lt-note').textContent = l.routeNote || '';
    trace();
  }
  paint();
  return {
    update(l) {
      const excursionChanged = l.excursion !== cur.excursion;
      cur = l; paint(); if (excursionChanged) trace(true);
      const rk = JSON.stringify(l.route); if (rk !== routeKey) { routeKey = rk; map?.setRoute(l.route); }
      if (l.position) map?.move(l.position);
    },
    live(d) {
      const statusChanged = d.status && d.status !== cur.status;
      cur = { ...cur, temperature: mergeTemp(cur.temperature, d.temperature, d.position?.at || new Date().toISOString()) };
      for (const k of ['position', 'eta', 'etaText', 'remainingKm', 'status']) if (d[k] !== undefined) cur[k] = d[k];
      paint();
      if (d.position) map?.move(d.position);
      if (statusChanged) reload();
    },
    destroy: () => { traceKill?.(); map?.destroy(); },
  };
}

// ================================================================= STOCK & EXPIRY
const STOCK_STATUS = { out: ['red', 'Out of stock'], low: ['amber', 'Low'], ok: ['green', 'OK'], untracked: ['grey', 'Not watched'] };
// The safety margin is an OData action (approver / admin; the server checks); the experience API has no descriptor for it.
const MARGIN_ACTION = {
  id: 'set-safety-margin', label: 'Change safety margin', style: 'secondary', method: 'POST', path: '/odata/v4/settings/setSafetyMargin', done: 'Safety margin saved.',
  fields: [{ name: 'pct', label: 'Safety margin (%)', type: 'number', min: 0, max: 100, required: true, hint: 'Extra stock, as a share of booked doses, that MediLink keeps for your own patients before offering any to other hospitals.' }],
};
let inboxStatus = 'open', stockFilter = 'all';
const needsCare = d => d.status === 'out' || d.status === 'low' || d.lots?.length > 0;
const hasLot = s => d => (d.lots || []).some(l => l.status === s);
const STOCK_FILTERS = [['all', 'All', () => true], ['care', 'Needs attention', needsCare], ['out', 'Out', d => d.status === 'out'], ['low', 'Low', d => d.status === 'low'], ['expiring', 'Expiring', hasLot('expiring')], ['expired', 'Expired', hasLot('expired')]];
const vials = q => `${fmtN(q)} ${Number(q) === 1 ? 'vial' : 'vials'}`;
function stockLine(sum, n) {
  const p = [];
  if (sum.out) p.push(`${words(sum.out)} ${sum.out === 1 ? 'medicine is' : 'medicines are'} out`);
  if (sum.low) p.push(`${words(sum.low)} ${sum.low === 1 ? 'is' : 'are'} low`);
  if (sum.expiring) p.push(`${words(sum.expiring)} ${sum.expiring === 1 ? 'batch expires' : 'batches expire'} soon`);
  if (sum.expired) p.push(`${words(sum.expired)} expired ${sum.expired === 1 ? 'batch is' : 'batches are'} still on the shelf`);
  return p.length ? cap1(joinAnd(p)) + '.' : n ? `All ${words(n)} medicines are above their reorder level, and nothing is close to expiry.` : '';
}
function stockRow(d, i) {
  const [colour, word] = STOCK_STATUS[d.status] || ['grey', d.status];
  return `<li class="srow drop">
    <div class="sr-name"><b>${esc(d.drug)}</b></div>
    <div class="sr-vial"><div class="vg" data-vg="${i}"></div><p class="sr-num"><b>${esc(fmtN(d.onHand))}</b>in stock<small>${d.threshold == null ? 'not watched' : `reorder at ${esc(fmtN(d.threshold))}${d.thresholdSource === 'default' ? ' (default)' : ''}`}</small></p></div>
    <div class="sr-lots">${d.lots?.length ? `<div class="bl" data-bl="${i}"></div>` : '<span class="muted">No batch close to expiry</span>'}</div>
    <div class="sr-st">${statusChip(colour, word)}</div>
    <div class="sr-act">${editBtn((d.actions || []).find(a => a.id === 'set-reorder-level') || d.actions?.[0], d.drug)}</div></li>`;
}
async function viewStock(quiet) {
  document.title = 'Stock & expiry · MediLink';
  let s, n;
  try {
    [s, n] = await Promise.all([api('GET', '/me/stock'), api('GET', `/me/notifications?status=${inboxStatus}`)]);
    if (!lastHome) lastHome = await api('GET', '/me/home');
  } catch (err) { return viewError(err, '#/stock'); }
  const y = scrollY, sum = s.summary || {};
  const filter = STOCK_FILTERS.find(([k]) => k === stockFilter) || STOCK_FILTERS[0];
  const shown = s.drugs.filter(filter[2]), max = Math.max(1, ...s.drugs.map(d => d.onHand || 0));
  const banner = feedBanner(lastHome);
  const notes = n.notifications.filter(a => !(banner && a.kind === 'STALE_FEED'));
  appShell('#/stock', `
    ${banner}
    ${hello(`Stock & expiry / ${shortHospital(s.hospital?.name)}`, 'Stock', stockLine(sum, s.drugs.length))}
    ${s.drugs.length ? `<div class="filters rise" role="group" aria-label="Show">${STOCK_FILTERS.map(([k, l, f]) => `<button type="button" class="fcap${k === filter[0] ? ' on' : ''}" data-filter="${k}" aria-pressed="${k === filter[0]}">${esc(l)}<span class="fcap-n">${s.drugs.filter(f).length}</span></button>`).join('')}</div>` : ''}
    <section class="sheet rise" aria-labelledby="drugs-h"><h2 id="drugs-h" class="sr-only">Medicines</h2>
      ${s.drugs.length ? `<div class="srow sr-head" aria-hidden="true"><span>Medicine</span><span>In stock / reorder</span><span>Batches by expiry</span><span>Status</span><span></span></div>
        <ul class="srows">${shown.map(stockRow).join('') || `<li class="pane">${emptyState('Nothing here right now.')}</li>`}</ul>` : `<div class="pane">${emptyState(s.emptyText || 'No medicines yet.')}</div>`}
    </section>
    <div class="bento">
      ${pane('inbox-h', inboxStatus === 'open' ? 'Open alerts' : 'All alerts', notes.length ? alertStack(notes, 'stock-al') : emptyState(n.emptyText || 'No open alerts.'),
        { label: 'Inbox', right: `<button type="button" class="link" id="inbox-toggle">${inboxStatus === 'open' ? 'Show past alerts too' : 'Open alerts only'}</button>`, cls: 's7' })}
      ${pane('set-h', 'Settings', `<ul class="settings">
        ${n.alertEmail ? `<li><div><b>My alert email</b><small>${n.alertEmail.email ? `${esc(n.alertEmail.email)} · ` : ''}${esc(n.alertEmail.text)}</small></div>${actionBtn({ style: 'secondary', ...n.alertEmail.action })}</li>` : ''}
        ${['approver', 'admin'].includes(role()) ? `<li><div><b>Safety margin</b><small>${esc(MARGIN_ACTION.fields[0].hint)}</small></div>${actionBtn(MARGIN_ACTION)}</li>` : ''}
        <li><div><b>Reorder levels</b><small>Set per medicine with the pencil. MediLink alerts you when stock falls to that level.</small></div></li></ul>`, { label: 'Alerts / approvals', cls: 's5' })}
    </div>`, quiet);
  shown.forEach((d, i) => {
    mount(() => vialGauge($(`[data-vg="${i}"]`), { onHand: d.onHand, threshold: d.threshold, status: d.status, max }));
    if (d.lots?.length) mount(() => blisterStrip($(`[data-bl="${i}"]`), d.lots));
  });
  const main = $('#main');
  wireActions(main, () => viewStock(true));
  wireMore(main);
  $('#inbox-toggle').addEventListener('click', () => { inboxStatus = inboxStatus === 'open' ? 'all' : 'open'; viewStock(true); });
  main.querySelectorAll('[data-filter]').forEach(b => b.addEventListener('click', () => { stockFilter = b.dataset.filter; viewStock(true).then(() => $(`[data-filter="${stockFilter}"]`)?.focus()); }));
  if (quiet) scrollTo(0, y);
  const soon = debounce(() => { if (!$('#dlg').open) viewStock(true); }, 600);
  onLive(event => { if (event === 'alert') soon(); });
}

// ================================================================= CITY
async function viewCity() {
  document.title = 'City · MediLink';
  let c;
  try { c = await api('GET', '/me/city'); if (!lastHome) lastHome = await api('GET', '/me/home'); } catch (err) { return viewError(err, '#/city'); }
  const rows = [...c.rows].sort((a, b) => b.dosesShort - a.dosesShort || b.citySurplus - a.citySurplus);
  const short = rows.filter(r => r.dosesShort > 0), sum = k => rows.reduce((s, r) => s + (r[k] || 0), 0);
  appShell('#/city', `
    ${hello(`Bengaluru / next ${c.windowDays} days`, 'City', 'Totals only. No hospital is ever named.')}
    <div class="bento">
      ${tile({ kind: 'covered', label: 'Medicines tracked', value: rows.length, tone: 'sky', sub: 'Critical cancer medicines' })}
      ${tile({ kind: 'short', label: 'Short somewhere', value: short.length, tone: 'rose', zeroOk: true, sub: short.length ? 'Booked doses not covered' : 'Every booked dose is covered' })}
      ${tile({ kind: 'out', label: 'Doses short', value: sum('dosesShort'), tone: 'rose', zeroOk: true, sub: short.length ? `Across ${words(sum('hospitalsShort'))} hospital${sum('hospitalsShort') === 1 ? '' : 's'}` : 'Nothing missing' })}
      ${tile({ kind: 'loan', label: 'Spare doses', value: sum('citySurplus'), tone: 'mint', sub: 'Hospitals could lend these' })}
      <section class="pane hero s12 rise" aria-labelledby="city-h">
        <header class="ph"><div><p class="eyebrow">Short to the left / spare to the right</p><h2 id="city-h">Every critical medicine</h2></div><span class="eyebrow">Short first · hover or tab for detail</span></header>
        ${rows.length ? '<div id="city-chart" class="cbars"></div>' : emptyState(c.emptyText || 'Nothing to show yet.')}
      </section>
    </div>`);
  if (!rows.length) return;
  const hs = n => `${words(n)} hospital${n === 1 ? '' : 's'}`;
  mount(() => capsuleBars($('#city-chart'), rows.map(r => ({
    label: r.drug, left: r.dosesShort ? [{ value: r.dosesShort, tone: 'rose' }] : [], parts: [{ value: r.citySurplus, tone: 'mint' }],
    total: `${fmtN(r.citySurplus)} spare`, sub: r.dosesShort ? `${cap1(hs(r.hospitalsShort))} short` : '', extra: r.hospitalsShort ? vz(() => unitDots(5, r.hospitalsShort)) : '',
    aria: `${r.drug}: ${fmtN(r.citySurplus)} spare, ${r.dosesShort ? `${fmtN(r.dosesShort)} doses short at ${hs(r.hospitalsShort)}` : 'covered'}`,
    tip: { title: r.drug, rows: [
      ...(r.dosesShort ? [{ value: fmtN(r.dosesShort), label: `doses short at ${hs(r.hospitalsShort)}`, tone: 'rose' }] : []),
      { value: fmtN(r.citySurplus), label: 'spare across the city', tone: 'mint' },
      { value: fmtN(r.dosesBooked), label: `doses booked in ${c.windowDays} days` },
    ] },
  })), { diverging: true, legend: [{ tone: 'rose', label: 'Doses short' }, { tone: 'mint', label: 'Spare across the city' }] }));
}

// ================================================================= ADMIN OVERVIEW
const SOFTWARE = { SAP_SANDBOX: 'SAP S/4HANA', MEDISOFT: 'Medisoft', CONNECTOR: 'Connector', SHEET: 'Spreadsheet', NONE: 'None' };
const INTEGRATION = { connected: ['mint', 'Connected'], fallback: ['sun', 'Fallback'], misconfigured: ['rose', 'Needs attention'] };
const AUDIT_WORD = {
  SEED_LOADED: 'Demo data loaded', INGEST: 'Stock updated', STOCK_ALERTS: 'Stock alerts raised', ALERT_ACKNOWLEDGED: 'Alert acknowledged', FEED_STALE: 'Feed went out of date',
  SUPPLIER_ACCEPTED: 'Supplier accepted', SUPPLIER_DECLINED: 'Supplier declined', APPROVED: 'Transfer approved', REJECTED: 'Transfer rejected', COURIER_LINK_ISSUED: 'Courier link sent',
  PICKUP: 'Picked up', EXCURSION: 'Temperature out of range', DELIVERED: 'Delivered', QUARANTINED: 'Quarantined', REQUEST_CREATED: 'Request raised',
};
const auditWord = a => AUDIT_WORD[a] || (a.charAt(0) + a.slice(1).toLowerCase()).replace(/_/g, ' ');
const agoText = iso => { const m = Math.round((Date.now() - Date.parse(iso)) / 60000); return m < 1 ? 'just now' : m < 60 ? `${m} min ago` : m < 2880 ? `${Math.round(m / 60)} h ago` : `${Math.round(m / 1440)} days ago`; };

function adminLine(o) {
  const kh = o.kpis.hospitals, live = `${cap1(words(kh.live))} of ${words(kh.total)} hospitals are up to date`;
  const names = new Map(o.cover.drugs.map(d => [d.id, d.name])), byDrug = new Map();
  for (const c of o.cover.cells) if (c.status === 'short') byDrug.set(c.drugId, (byDrug.get(c.drugId) || 0) + 1);
  if (!byDrug.size) return `${live}, and every booked dose is covered.`;
  if (byDrug.size === 1) { const [[id, n]] = byDrug; return `${live}; ${names.get(id) || 'one medicine'} is short at ${words(n)} of them.`; }
  return `${live}; ${words(byDrug.size)} medicines are short somewhere in the next ${o.cover.windowDays} days.`;
}
const hospCard = (x, i) => `<article class="hosp pane lift" aria-labelledby="hosp-${i}">
  <header><b id="hosp-${i}">${esc(x.name)}</b><small>${esc([x.area, SOFTWARE[x.software] || x.software].filter(Boolean).join(' / '))}</small></header>
  <div class="hosp-hb" data-hb="${i}"></div>
  <div class="hosp-mid"><div class="hosp-lv" data-lv="${i}"></div>
    <dl class="hosp-dl">
      <div><dt>Short</dt><dd class="${x.short ? 'crit' : ''}">${esc(x.short)}${x.low ? `<small>${esc(x.low)} low</small>` : ''}</dd></div>
      <div><dt>Alerts</dt><dd>${esc(fmtN(x.alerts))}${x.urgent ? `<small>${esc(x.urgent)} urgent</small>` : ''}</dd></div>
      <div><dt>In / out</dt><dd>${esc(x.incoming)} / ${esc(x.outgoing)}</dd></div>
    </dl></div></article>`;
const integrationsChips = hi => `<ul class="syschips" id="sys-chips">${hi.items.map((i, n) => {
  const [t, w] = INTEGRATION[i.status] || ['ink', i.status];
  return `<li class="syschip t-${t}" tabindex="0" data-tip="${n}"><i aria-hidden="true"></i><b>${esc(i.service)}</b><span class="sc-w">${esc(w)}</span><span class="sr-only">: ${esc(i.text)}</span></li>`;
}).join('')}</ul>`;
const activityList = xs => (xs.length ? `<ol class="tl act">${xs.map(a => `<li><time class="tl-when" datetime="${esc(a.at)}">${esc(agoText(a.at))}</time><span class="tl-dot" aria-hidden="true"></span><p><b>${esc(auditWord(a.action))}</b> <span class="muted">${esc(a.actor)}</span></p></li>`).join('')}</ol>` : emptyState('Nothing has happened yet.'));

async function viewOverview(quiet) {
  document.title = 'Overview · MediLink';
  let o, hi, m, h;
  try { [o, hi, m, h] = await Promise.all([api('GET', '/admin/overview'), api('GET', '/health/integrations'), api('GET', '/admin/metrics'), api('GET', '/me/home')]); }
  catch (err) { return viewError(err, '#/home'); }
  lastHome = h;
  const y = scrollY, k = o.kpis, kh = k.hospitals;
  const maxUnits = Math.max(1, ...o.hospitals.map(x => x.units.usable + x.units.expiring + x.units.expired));
  appShell('#/home', `
    ${hello(`Administrator / Bengaluru / updated ${timeIN(o.generatedAt)}`, 'Network overview', adminLine(o))}
    <div class="bento">
      ${tile({ kind: 'hospital', label: 'Feeds up to date', value: kh.live, of: kh.total, tone: kh.live === kh.total ? 'mint' : 'sun', sub: [kh.stale && `${kh.stale} out of date`, kh.offline && `${kh.offline} offline`].filter(Boolean).join(' · ') || 'Every feed is up to date' })}
      ${tile({ kind: 'covered', label: 'Units in stock', value: k.units, tone: 'sky', sub: `Usable, all hospitals · ${k.loans.open} open loan${k.loans.open === 1 ? '' : 's'}` })}
      ${tile({ kind: 'short', label: 'Medicines short', value: k.shortMedicines, tone: 'rose', zeroOk: true, sub: `Somewhere, next ${o.cover.windowDays} days` })}
      ${tile({ kind: 'alert', label: 'Open alerts', value: k.alerts.open, tone: k.alerts.urgent ? 'rose' : 'sun', zeroOk: true, sub: k.alerts.urgent ? `${k.alerts.urgent} urgent` : 'None urgent' })}
      <section class="s12 rise hosps-sec" aria-labelledby="hs-h"><header class="ph"><div><p class="eyebrow">Feed / stock / alerts</p><h2 id="hs-h">Hospitals</h2></div><span class="eyebrow">${esc(k.moving)} moving · ${esc(k.onRoad)} on the road</span></header>
        <div class="hosps">${o.hospitals.map(hospCard).join('')}</div></section>
      ${pane('cv-h', 'Cover by hospital', o.cover.drugs.length ? '<div id="ch-cover"></div>' : emptyState('No stock or bookings yet.'), { label: `Next ${o.cover.windowDays} days / units in stock, −n = doses short`, cls: 's12' })}
      ${pane('ex-h', 'Expiry outlook', '<div id="ch-expiry"></div>', { label: 'Units by days left', cls: 's6' })}
      ${pane('al-h', 'Alerts by type', o.alerts.length ? '<div id="ch-alerts" class="cbars"></div>' : emptyState('No open alerts.'), { label: `${k.alerts.open} open / ${k.alerts.urgent} urgent`, cls: 's6' })}
      ${pane('cc-h', 'Cold chain', o.coldChain.length ? o.coldChain.map((s, i) => `<div class="cc"><div class="cc-h"><b>${esc(s.drug)}</b><span class="muted">${esc(s.from)} → ${esc(s.to)}</span>${statusChip(s.excursion ? 'red' : 'green', s.excursion ? 'Went out of range' : 'In range')}</div><div class="cc-trace" id="cc-${i}"></div></div>`).join('') : emptyState('Nothing on the road. Temperature traces appear here while medicine moves.'), { label: 'Temperature on the road', cls: 's7' })}
      ${pane('dl-h', 'Deliveries', h.journeys.length ? `<div class="orders one">${h.journeys.map(orderCard).join('')}</div>` : emptyState('Nothing on the move. Transfers between hospitals show up here.'), { label: 'Between hospitals', cls: 's5' })}
      ${pane('mt-h', 'Success targets', `<div class="bullets">${m.metrics.map((x, i) => `<div class="bul" data-bu="${i}"></div>`).join('')}</div>`, { label: 'Synthetic data', cls: 's7' })}
      ${pane('sy-h', 'System', integrationsChips(hi), { label: hi.summary, cls: 's5' })}
      ${pane('ac-h', 'Recent activity', activityList(o.activity), { label: 'Audit trail', cls: 's12' })}
    </div>`, quiet);

  o.hospitals.forEach((x, i) => {
    mount(() => heartbeat($(`[data-hb="${i}"]`), { feed: x.feed, lastSyncedAt: x.lastSyncedAt }));
    mount(() => layeredVial($(`[data-lv="${i}"]`), x.units, { max: maxUnits }));
  });
  if (o.cover.drugs.length) mount(() => pillbox($('#ch-cover'), o.cover));
  mount(() => expiryShelf($('#ch-expiry'), o.expiry));
  if (o.alerts.length) mount(() => capsuleBars($('#ch-alerts'), o.alerts.map(a => ({
    label: a.label, parts: [{ value: a.urgent, tone: 'rose' }, { value: a.count - a.urgent, tone: 'sun' }], total: fmtN(a.count), aria: `${a.label}: ${a.count} open, ${a.urgent} urgent`,
    tip: { title: a.label, rows: [{ value: fmtN(a.urgent), label: 'urgent', tone: 'rose' }, { value: fmtN(a.count - a.urgent), label: 'heads-up', tone: 'sun' }] },
  })), { legend: [{ tone: 'rose', label: 'Urgent' }, { tone: 'sun', label: 'Heads-up' }] }));
  o.coldChain.forEach((s, i) => mount(() => tempTrace($('#cc-' + i), { points: s.points, min: s.min, max: s.max })));
  m.metrics.forEach((x, i) => mount(() => bullet($(`[data-bu="${i}"]`), x)));
  vz(() => wireTips($('#sys-chips'), hi.items.map(i => { const [t, w] = INTEGRATION[i.status] || ['ink', i.status]; return { title: i.service, rows: [{ value: w, tone: t }, { value: '', label: i.text }] }; })));

  const main = $('#main');
  wireActions(main, () => viewOverview(true));
  wireTrack(main);
  if (quiet) scrollTo(0, y);
  const sig = x => JSON.stringify({ ...x, generatedAt: 0 });
  const refresh = async () => {
    try {
      const [fresh, fh] = await Promise.all([api('GET', '/admin/overview'), api('GET', '/me/home')]);
      if (!$('#dlg').open && (sig(fresh) !== sig(o) || JSON.stringify(fh.journeys) !== JSON.stringify(h.journeys))) viewOverview(true);
    } catch { /* keep the screen */ }
  };
  poll(refresh, 15000);
  const soon = debounce(refresh, 800);
  onLive(event => { if (event !== 'tracking') soon(); });
}

// ---------------------------------------------------------------- start
if (location.protocol === 'file:') {
  $('#view').innerHTML = '<div class="stage"><section class="card glass"><h1 class="h22">Open MediLink through its server</h1><p>Run <b>npm run dev</b>, then open <b>http://localhost:4004/app.html</b>.</p></section></div>';
} else {
  route();
}
