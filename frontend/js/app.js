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
  [/^#\/admin$/, viewAdmin, true],
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
  await view(...hash.match(re).slice(1).map(decodeURIComponent));
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
const SEVERITY_WORD = { red: 'Urgent', amber: 'Heads-up' };
const ALERT_WORD = { LOW_STOCK: 'Low stock', OUT_OF_STOCK: 'Out of stock', EXPIRING: 'Expiring', EXPIRED: 'Expired' };
const STOCK_KINDS = new Set(Object.keys(ALERT_WORD));

function appShell(active, content) {
  document.body.className = 'route-app';
  const h = lastHome;
  const who = h?.hospital ? `<b>${esc(h.hospital.name)}</b><span>${esc(h.hospital.connection.text)}</span>` : '<b>Administrator</b><span>All hospitals · demo data</span>';
  const links = [['#/home', 'Home'], ...(role() !== 'admin' ? [['#/stock', 'Stock']] : []), ['#/city', 'City'], ...(role() === 'admin' ? [['#/admin', 'Admin']] : [])];
  $('#view').innerHTML = `
    <header class="topbar glass">
      <a class="wordmark" href="#/home">MediLink</a>
      <div class="who">${who}</div>
      <nav class="topnav" aria-label="Main">${links.map(([href, l]) => `<a href="${href}" ${active === href ? 'aria-current="page"' : ''}>${l}</a>`).join('')}</nav>
      <button class="btn ghost small" id="signout" type="button">${icon('logout')}Sign out</button>
    </header>
    <main class="page" id="main">${content}</main>`;
  $('#signout').addEventListener('click', () => signOut('You are signed out.'));
}
function viewError(err, active) {
  appShell(active, `<div class="hello"><h1>That did not load</h1></div>${errorCard(err, 'view-retry')}`);
  wireRetry('view-retry', err, route);
}

// ---------------------------------------------------------------- action buttons (rendered from the API's action descriptors)
let actionSeq = 0;
const actionRegistry = new Map();
function actionBtn(a, extraCls = '') {
  if (!a) return '';
  const id = 'act-' + (++actionSeq);
  actionRegistry.set(id, a);
  const cls = a.style === 'secondary' ? 'btn ghost small' : 'btn small';
  return `<button type="button" class="${cls} ${extraCls}" data-act="${id}" ${a.available === false ? `disabled title="${esc(a.unavailableReason || '')}"` : ''}>${esc(a.label)}</button>${a.available === false && a.unavailableReason ? `<span class="muted">${esc(a.unavailableReason)}</span>` : ''}`;
}
function wireActions(root, after) {
  root.querySelectorAll('[data-act]').forEach(b => b.addEventListener('click', () => openAction(actionRegistry.get(b.dataset.act), after)));
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

// ---------------------------------------------------------------- cards
function progress(j, big) {
  return `<div class="prog ${big ? 'big' : ''}" role="progressbar" aria-valuemin="1" aria-valuemax="${j.of}" aria-valuenow="${j.stage}" aria-valuetext="Stage ${j.stage} of ${j.of}: ${esc(j.stageLabel)}">${Array.from({ length: j.of }, (_, i) => `<i class="${i + 1 < j.stage ? 'on' : i + 1 === j.stage ? 'now' : ''}"></i>`).join('')}</div>`;
}
function journeyCard(j, compact) {
  const last = j.timeline?.[j.timeline.length - 1];
  const facts = [
    j.counterpart && `<span>${icon('pin')}${esc(j.perspective === 'supplier' ? 'For ' : 'From ')}${esc(j.counterpart)}</span>`,
    j.eta && `<span>${icon('clock')}ETA ${esc(timeIN(j.eta))}</span>`,
    j.temperatureC != null && `<span>${icon('thermo')}${esc(j.temperatureC.toFixed(1))} °C</span>`,
  ].filter(Boolean).join('');
  return `<article class="card glass" aria-label="${esc(j.drug.name)}">
    <div class="jhead">${statusChip(j.colour)}<span class="stagelabel">Stage ${j.stage} of ${j.of} · ${esc(j.stageLabel)}</span></div>
    ${progress(j)}
    <h3>${esc(j.drug.name)}${j.qty ? ` · ${esc(j.qty)} ${j.stage === 1 ? 'doses' : 'vials'}` : ''}</h3>
    <p class="headline">${esc(j.headline)}</p>
    ${facts ? `<div class="facts">${facts}</div>` : ''}
    ${!compact && last ? `<p class="muted">${esc(last.time)} · ${esc(last.text)}</p>` : ''}
    <div class="acts">${(j.actions || []).map(a => actionBtn(a)).join('')}${j.requestId ? `<a class="link" href="#/journey/${encodeURIComponent(j.id)}">${j.stage === 5 || j.stage === 6 ? 'Track live' : 'Details'}<span class="sr-only">: ${esc(j.drug.name)}</span></a>` : ''}</div>
  </article>`;
}
function taskCard(t) {
  return `<article class="card glass">
    <div class="jhead">${statusChip(t.colour, t.urgency === 'high' ? 'Do now' : t.urgency === 'medium' ? 'Today' : 'When you can')}${t.dueBy ? `<span class="stagelabel">${t.dueBy.length > 10 ? 'By ' + esc(timeIN(t.dueBy)) : 'Needed by ' + esc(dateIN(t.dueBy))}</span>` : ''}</div>
    <h3>${esc(t.title)}</h3>
    <p>${esc(t.subtitle)}</p>
    <div class="acts">${actionBtn(t.primaryAction)}${actionBtn(t.secondaryAction)}${t.journeyId && !t.journeyId.startsWith('shortfall:') ? `<a class="link" href="#/journey/${encodeURIComponent(t.journeyId)}">Details<span class="sr-only">: ${esc(t.title)}</span></a>` : ''}</div>
  </article>`;
}
function alertCard(a) {
  const colour = a.colour || a.severity; // home alerts carry severity red|amber, inbox rows carry colour
  return `<div class="alert glass">${statusChip(colour === 'red' ? 'red' : 'amber', ALERT_WORD[a.kind] || SEVERITY_WORD[colour] || 'Alert')}<div class="alert-b"><p>${esc(a.message)}</p>
    ${a.createdAt ? `<p class="muted">${esc(new Date(a.createdAt).toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit', timeZone: 'Asia/Kolkata' }))}${a.ackedAt ? ' · seen' : ''}</p>` : ''}
    <div class="acts">${(a.actions || []).map(x => actionBtn(x)).join('')}${STOCK_KINDS.has(a.kind) && location.hash !== '#/stock' ? '<a class="link" href="#/stock">Open stock</a>' : ''}</div></div></div>`;
}
const pillTablet = (cls, n, title, sub) => `<div class="tablet glass"><span class="pill ${cls}">${esc(n)}</span><span><b>${esc(title)}</b><span>${esc(sub)}</span></span></div>`;
const stockTablets = s => `<div class="tablets">${pillTablet('red', s.out ?? 0, 'Out of stock', 'nothing usable left')}${pillTablet('amber', s.low ?? 0, 'Low', 'at or under the reorder level')}${pillTablet('amber', s.expiring ?? 0, 'Expiring', 'use or offer first')}${pillTablet('red', s.expired ?? 0, 'Expired', 'take off the shelf')}</div>`;

// ================================================================= HOME
async function viewHome() {
  document.title = 'Home · MediLink';
  let h;
  try { h = await api('GET', '/me/home'); } catch (err) { return viewError(err, '#/home'); }
  lastHome = h;
  const cs = h.coverSummary, ss = h.stockSummary;
  appShell('#/home', `
    <section class="hello">
      <p class="eyebrow">${esc(h.greeting)}</p>
      <h1>${esc(h.hospital ? h.hospital.name.split(',')[0] : 'All hospitals')}</h1>
      ${h.hospital ? `<p class="serif">${esc(h.hospital.licence.text)}.</p>` : ''}
    </section>
    ${h.onboarding ? `<section class="card glass"><div class="jhead">${statusChip('amber', 'Setting up')}<span class="stagelabel">${esc(h.onboarding.step || '')}</span></div><p class="ink">${esc(h.onboarding.message)}</p><div class="acts"><a class="btn small" href="#/onboarding">Continue setting up ${icon('arrowRight')}</a></div></section>` : ''}
    ${cs ? `<section aria-labelledby="cover-h"><div class="section-h"><h2 id="cover-h">Your critical drugs</h2><span class="note">Next ${esc(cs.windowDays)} days</span></div>
      <div class="tablets">${pillTablet('red', cs.red, 'Short', 'booked doses not covered')}${pillTablet('amber', cs.amber, 'Low', 'below your safety margin')}${pillTablet('green', cs.green, 'Covered', 'all booked doses')}</div>
      ${cs.emptyText ? `<p class="serif mt12">${esc(cs.emptyText)}</p>` : ''}</section>` : ''}
    ${ss ? `<section aria-labelledby="stock-h"><div class="section-h"><h2 id="stock-h">Stock &amp; expiry</h2><a class="link" href="#/stock">Open stock</a></div>
      ${stockTablets(ss)}${ss.emptyText ? `<p class="serif mt12">${esc(ss.emptyText)}</p>` : ''}</section>` : ''}
    <div class="grid2">
      <section aria-labelledby="tasks-h"><div class="section-h"><h2 id="tasks-h">Needs you now</h2></div>
        <div class="cards">${h.tasks.map(taskCard).join('') || `<p class="empty glass">${esc(h.empty.tasks)}</p>`}</div></section>
      <section aria-labelledby="alerts-h"><div class="section-h"><h2 id="alerts-h">Alerts</h2></div>
        <div class="cards" aria-live="polite">${h.alerts.map(alertCard).join('') || `<p class="empty glass">${esc(h.empty.alerts)}</p>`}</div></section>
    </div>
    <section aria-labelledby="j-h"><div class="section-h"><h2 id="j-h">Medicine on the move</h2><span class="note">Live</span></div>
      <div class="jgrid">${h.journeys.map(j => journeyCard(j)).join('') || `<p class="empty glass">${esc(h.empty.journeys)}</p>`}</div></section>`);
  wireActions($('#main'), () => viewHome());
  const refresh = async () => {
    try { const fresh = await api('GET', '/me/home'); if (!$('#dlg').open && JSON.stringify(fresh) !== JSON.stringify(lastHome)) viewHome(); } catch { /* keep the screen */ }
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
function journeySummary(j) {
  const facts = [
    ['Medicine', j.drug.name], ['Quantity', j.qty ? `${j.qty} vials` : null], ['Needed by', j.neededBy ? dateIN(j.neededBy, true) : null],
    ['From', j.from], ['To', j.to], ['Arriving', j.eta ? timeIN(j.eta) : null],
    ['Temperature', j.temperatureC != null ? `${j.temperatureC.toFixed(1)} °C` : null],
    ['Loan', j.loan ? `${j.loan.qty} vials · ${j.loan.status === 'OPEN' ? 'open' : 'repaid'} · ${j.loan.mode === 'IN_KIND' ? 'repay in kind' : 'repay at cost'}` : null],
  ].filter(([, v]) => v);
  return `<section class="card glass pad24">
      <div class="jhead">${statusChip(j.colour)}<span class="stagelabel">Stage ${j.stage} of ${j.of} · ${esc(j.stageLabel)}</span></div>
      <div>${progress(j, true)}<div class="stagenames" aria-hidden="true">${STAGES.map((s, i) => `<span class="${i + 1 === j.stage ? 'now' : ''}">${s}</span>`).join('')}</div></div>
      <h1 class="j-h1">${esc(j.drug.name)}</h1>
      <p class="headline j-headline">${esc(j.headline)}</p>
      <div class="facts f13">${facts.map(([k, v]) => `<span><b class="k">${esc(k)}:</b> ${esc(v)}</span>`).join('')}</div>
      ${j.note ? `<div class="notebox"><p class="label mb4">Handling note</p>${esc(j.note)}</div>` : ''}
      ${(j.actions || []).length ? `<div class="acts">${j.actions.map(a => actionBtn(a)).join('')}</div>` : ''}
    </section>`;
}
const timelineHtml = j => `<section class="card glass" aria-labelledby="tl-h"><h2 id="tl-h" class="h17">What happened</h2>
  ${j.timeline.length ? `<ol class="timeline">${j.timeline.map(e => `<li><time datetime="${esc(e.at)}">${esc(e.time)}</time><span class="tdot" aria-hidden="true"></span><p>${esc(e.text)}</p></li>`).join('')}</ol>` : '<p class="muted">Nothing has happened yet.</p>'}</section>`;

async function viewJourney(id) {
  document.title = 'Journey · MediLink';
  let j;
  try { j = await api('GET', `/me/journeys/${encodeURIComponent(id)}`); } catch (err) { return viewError(err, '#/home'); }
  if (!lastHome) { try { lastHome = await api('GET', '/me/home'); } catch { /* chrome without status */ } }
  appShell('#/home', `<a class="back" href="#/home">${icon('arrowLeft')}Back to home</a><div id="j-sum"></div><div id="j-track" class="cards"></div><div id="j-tl"></div>`);
  const track = trackingSection($('#j-track'), j.id);
  onCleanup(() => track.destroy());
  const after = r => (r?.journey ? paint(r.journey) : refresh());
  function paint(next) {
    // keep keyboard focus on the same button when the summary is redrawn
    const focused = document.activeElement?.closest('#j-sum') ? document.activeElement.textContent : null;
    j = next;
    $('#j-sum').innerHTML = journeySummary(j);
    $('#j-tl').innerHTML = timelineHtml(j);
    wireActions($('#j-sum'), after);
    if (focused) [...$('#j-sum').querySelectorAll('button, a')].find(b => b.textContent === focused)?.focus();
    track.sync(j);
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
const legHtml = (l, persp) => `<section class="card glass track" data-leg="${esc(l.transferId)}" aria-label="Live tracking: ${esc(l.drug?.name)}">
  <div class="lt-head"><div class="lt-eta" role="status" aria-live="polite"></div><div class="lt-flags"></div></div>
  <div class="lt-banner"></div>
  <div class="lt-steps"></div>
  <div class="lt-grid ${persp === 'supplier' ? 'nomap' : ''}">
    ${persp === 'supplier' ? '' : `<div class="lt-map" role="region" aria-label="Map from ${esc(l.origin?.name)} to ${esc(l.destination?.name)} with the courier's position"></div>`}
    <div class="lt-side"><div class="lt-partner"></div><div class="lt-temp"></div><p class="lt-note muted" aria-live="polite"></p></div>
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
  let cur = leg, routeKey = JSON.stringify(leg.route);
  function paint() {
    const l = cur;
    const eta = l.etaText && (/^arriv/i.test(l.etaText) ? l.etaText : `Arriving in ${l.etaText}`);
    q('.lt-eta').innerHTML = eta
      ? `<p class="eta">${esc(eta)}</p>${l.remainingKm != null ? `<p class="muted m0">${esc(Number(l.remainingKm).toFixed(1))} km to go</p>` : ''}`
      : `<p class="eta">${esc(l.steps?.find(s => !s.done)?.label || 'Courier assigned')}</p>`;
    q('.lt-flags').innerHTML = l.delayed ? statusChip('amber', 'Running late') : '';
    q('.lt-banner').innerHTML = l.excursion ? `<div class="banner red" role="alert">${icon('alert')}<p><b>Temperature went out of range on the way.</b> ${persp === 'supplier' ? 'The receiving pharmacy will check it on arrival.' : "When it arrives, set it aside (quarantine) and don't use it until it has been checked."}</p></div>` : '';
    q('.lt-steps').innerHTML = stepper(l.steps);
    const tel = persp !== 'supplier' && l.riderPhone ? String(l.riderPhone).replace(/[^\d+]/g, '') : '';
    q('.lt-partner').innerHTML = `<p class="label">Courier</p><p class="ink m0"><b>${esc(l.partner?.name)}</b>${l.riderName ? `<br>${esc(l.riderName)}` : ''}</p>
      ${tel ? `<a class="btn small" href="tel:${esc(tel)}">${icon('phone')}Call ${esc(l.riderName || 'the rider')}</a>` : ''}`;
    q('.lt-temp').innerHTML = temperatureHtml(l.temperature);
    q('.lt-note').textContent = l.routeNote || '';
  }
  paint();
  return {
    update(l) {
      cur = l; paint();
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
    destroy: () => map?.destroy(),
  };
}

// ================================================================= STOCK & EXPIRY
const STOCK_STATUS = { out: ['red', 'Out of stock'], low: ['amber', 'Low'], ok: ['green', 'OK'], untracked: ['grey', 'Not watched'] };
// The safety margin is an OData action (approver / admin; the server checks); the experience API has no descriptor for it.
const MARGIN_ACTION = {
  id: 'set-safety-margin', label: 'Change safety margin', style: 'secondary', method: 'POST', path: '/odata/v4/settings/setSafetyMargin', done: 'Safety margin saved.',
  fields: [{ name: 'pct', label: 'Safety margin (%)', type: 'number', min: 0, max: 100, required: true, hint: 'Extra stock, as a share of booked doses, that MediLink keeps for your own patients before offering any to other hospitals.' }],
};
let inboxStatus = 'open';
function drugRow(d) {
  const [colour, word] = STOCK_STATUS[d.status] || ['grey', d.status];
  return `<div class="row glass stockrow"><div><b>${esc(d.drug)}</b><p class="muted m0">${esc(d.text)}</p>
    ${d.lots?.length ? `<ul class="lots">${d.lots.map(l => `<li>${statusChip(l.severity === 'HIGH' ? 'red' : 'amber', l.status === 'expired' ? 'Expired' : `${l.daysLeft} days left`)}<span><b class="k">Batch ${esc(l.batchNo)}</b> · ${esc(l.brandName)} · ${esc(l.qty)} left<br><span class="muted">${esc(l.text)}</span></span></li>`).join('')}</ul>` : ''}
  </div><div class="rowacts">${statusChip(colour, word)}${(d.actions || []).map(a => actionBtn({ style: 'secondary', ...a })).join('')}</div></div>`;
}
async function viewStock() {
  document.title = 'Stock & expiry · MediLink';
  let s, n;
  try {
    [s, n] = await Promise.all([api('GET', '/me/stock'), api('GET', `/me/notifications?status=${inboxStatus}`)]);
    if (!lastHome) lastHome = await api('GET', '/me/home');
  } catch (err) { return viewError(err, '#/stock'); }
  const sum = s.summary || {};
  appShell('#/stock', `
    <section class="hello"><p class="eyebrow">Stock &amp; expiry</p><h1>${esc((s.hospital?.name || '').split(',')[0])}</h1><p class="serif">${esc(sum.text || sum.emptyText || '')}</p></section>
    <section aria-label="Summary">${stockTablets(sum)}</section>
    <section aria-labelledby="inbox-h"><div class="section-h"><h2 id="inbox-h">${inboxStatus === 'open' ? 'Open alerts' : 'All alerts'}</h2>
      <button type="button" class="link" id="inbox-toggle">${inboxStatus === 'open' ? 'Show all alerts' : 'Show open alerts only'}</button></div>
      <div class="cards" aria-live="polite">${n.notifications.map(alertCard).join('') || `<p class="empty glass">${esc(n.emptyText)}</p>`}</div></section>
    <section aria-labelledby="drugs-h"><div class="section-h"><h2 id="drugs-h">Medicines</h2><span class="note">Worst first</span></div>
      <div class="rows">${s.drugs.map(drugRow).join('') || `<p class="empty glass">${esc(s.emptyText)}</p>`}</div></section>
    <section class="card glass" aria-labelledby="set-h"><h2 id="set-h" class="h17">Settings</h2>
      ${n.alertEmail ? `<div class="setrow"><div><b class="k">My alert email</b><p class="muted m0">${n.alertEmail.email ? `${esc(n.alertEmail.email)} · ` : ''}${esc(n.alertEmail.text)}</p></div>${actionBtn({ style: 'secondary', ...n.alertEmail.action })}</div>` : ''}
      ${['approver', 'admin'].includes(role()) ? `<div class="setrow"><div><b class="k">Safety margin</b><p class="muted m0">${esc(MARGIN_ACTION.fields[0].hint)}</p></div>${actionBtn(MARGIN_ACTION)}</div>` : ''}
      <p class="muted m0">Reorder levels are set per medicine, above.</p>
    </section>`);
  wireActions($('#main'), () => viewStock());
  $('#inbox-toggle').addEventListener('click', () => { inboxStatus = inboxStatus === 'open' ? 'all' : 'open'; viewStock(); });
  const soon = debounce(() => { if (!$('#dlg').open) viewStock(); }, 600);
  onLive(event => { if (event === 'alert') soon(); });
}

// ================================================================= CITY
async function viewCity() {
  document.title = 'City view · MediLink';
  let c;
  try { c = await api('GET', '/me/city'); if (!lastHome) lastHome = await api('GET', '/me/home'); } catch (err) { return viewError(err, '#/city'); }
  appShell('#/city', `
    <section class="hello"><p class="eyebrow">Bengaluru · next ${esc(c.windowDays)} days</p><h1>City view</h1>
      <p class="serif">Shortages across the city, counted, never named.</p></section>
    ${c.emptyText ? `<p class="empty glass">${esc(c.emptyText)}</p>` : ''}
    <section class="rows" aria-label="Medicines">${c.rows.map(r => `<div class="row glass"><div><b>${esc(r.drug)}</b><p class="muted mt2">${esc(r.text)}</p></div>${statusChip(r.dosesShort > 0 ? 'red' : 'green', r.dosesShort > 0 ? `${r.hospitalsShort} short` : 'Covered')}</div>`).join('')}</section>`);
}

// ================================================================= ADMIN
async function viewAdmin() {
  document.title = 'Admin · MediLink';
  let hi, m;
  try { [hi, m] = await Promise.all([api('GET', '/health/integrations'), api('GET', '/admin/metrics')]); if (!lastHome) lastHome = await api('GET', '/me/home'); } catch (err) { return viewError(err, '#/admin'); }
  const S = { connected: ['green', 'Connected'], fallback: ['amber', 'Fallback'], misconfigured: ['red', 'Needs attention'] };
  appShell('#/admin', `
    <section class="hello"><p class="eyebrow">Administrator</p><h1>System status</h1><p class="serif">${esc(hi.summary)}</p></section>
    <section aria-labelledby="m-h"><div class="section-h"><h2 id="m-h">Success metrics</h2><span class="note">Demo data</span></div>
      <div class="mgrid">${m.metrics.map(x => `<div class="metric glass">${statusChip(x.met === null ? 'grey' : x.met ? 'green' : 'red', x.met === null ? 'No data yet' : x.met ? 'On target' : 'Off target')}<b class="k">${esc(x.label)}</b><span class="v">${x.value === null ? '–' : esc(x.value)}<small class="unit"> ${esc(x.unit)}</small></span><span class="muted">${esc(x.text)} Target: ${esc(x.target)}.</span></div>`).join('')}</div></section>
    <section aria-labelledby="i-h"><div class="section-h"><h2 id="i-h">Integrations</h2></div>
      <div class="rows">${hi.items.map(i => `<div class="row glass"><div><b>${esc(i.service)}</b><p class="muted mt2">${esc(i.text)}</p></div>${statusChip(...(S[i.status] || ['grey', i.status]))}</div>`).join('')}</div></section>`);
}

// ---------------------------------------------------------------- start
if (location.protocol === 'file:') {
  $('#view').innerHTML = '<div class="stage"><section class="card glass"><h1 class="h22">Open MediLink through its server</h1><p>Run <b>npm run dev</b>, then open <b>http://localhost:4004/app.html</b>.</p></section></div>';
} else {
  route();
}
