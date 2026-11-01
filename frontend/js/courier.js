'use strict';
/* Courier page (no login, mobile first): opened from the per-delivery link .../courier.html#t=<token>.
   The token is read from the fragment, kept in sessionStorage for reloads (this tab only), removed from the address
   bar, and sent as "Authorization: Courier <token>" (docs/EXPERIENCE_API.md §13). Pickup scan, live location
   sharing (watchPosition, at most one fix per 5 s, wake lock while sharing) and "road closed". */

const TOKEN_KEY = 'medilink.courier';
const token = (() => {
  const m = /(?:^#|&)t=([A-Za-z0-9_-]+)/.exec(location.hash);
  if (m) {
    try { sessionStorage.setItem(TOKEN_KEY, m[1]); } catch { /* memory only */ }
    history.replaceState(null, '', location.pathname + location.search); // the link is a key: keep it out of the address bar
    return m[1];
  }
  try { return sessionStorage.getItem(TOKEN_KEY); } catch { return null; }
})();
const view = $('#view');
const SEND_GAP_MS = 5000, SEND_EVERY_MS = 10000, MOVE_M = 25, REFRESH_MS = 20000; // server: <= 60 calls/min per link
let job = null, map = null, refreshTimer = 0;
const share = { watch: null, timer: 0, last: null, sent: null, sentAt: 0, busy: false, lock: null, msg: '' };

async function capi(method, path, body) {
  try { return await http(method, path, body, { Authorization: `Courier ${token}` }); }
  catch (e) { if (e.status === 401) expired(e); throw e; }
}

// ---------------------------------------------------------------- states
function expired(err) {
  stopSharing(); clearInterval(refreshTimer); map?.destroy(); map = null;
  try { sessionStorage.removeItem(TOKEN_KEY); } catch { /* ignore */ }
  document.title = 'Link not working · MediLink';
  view.innerHTML = `<main class="c-main" id="main"><header class="c-top glass"><span class="wordmark">MediLink</span><span class="tag">Courier</span></header>
    <section class="card glass c-expired" aria-labelledby="x-h">${icon('alert')}
      <h1 id="x-h">${esc(err?.title || 'This link does not work')}</h1>
      <p class="ink">${esc(err?.message || 'This delivery link is not complete, has expired, or was replaced by a new one.')}</p>
      <p>${esc(err?.fix || 'Ask the hospital that is sending the medicine for a new link.')}</p>
    </section></main>`;
}
const STATUS = { ASSIGNED: ['amber', 'Ready for pickup'], IN_TRANSIT: ['green', 'On the way'], DELIVERED: ['green', 'Delivered'], QUARANTINED: ['grey', 'Handed over'] };
const navUrl = p => `https://www.google.com/maps/dir/?api=1&destination=${Number(p.lat)},${Number(p.long)}&travelmode=driving`;
const stop = (p, letter, title, state) => `<li class="card glass c-stop ${state}">
  <span class="c-letter" aria-hidden="true">${letter}</span>
  <div><p class="label m0">${title}${state === 'now' ? ' · next' : state === 'done' ? ' · done' : ''}</p><b class="ink">${esc(p.name)}</b><p class="muted m0">${esc(p.address)}</p></div>
  ${p.lat != null ? `<a class="btn ghost small" href="${esc(navUrl(p))}" target="_blank" rel="noopener">${icon('nav')}Navigate<span class="sr-only"> to ${esc(p.name)}</span></a>` : ''}</li>`;

function headHtml(j) {
  const [colour, word] = STATUS[j.status] || ['grey', j.status];
  const range = j.temperatureRange ? `Keep between ${j.temperatureRange.minC} and ${j.temperatureRange.maxC} °C` : '';
  const eta = j.eta ? `Arrive by about ${timeIN(j.eta)}` : j.etaMin ? `About ${j.etaMin} min drive` : '';
  return `<div class="jhead">${statusChip(colour, word)}<span class="stagelabel">${esc(j.partner?.name)}</span></div>
      <h1 id="c-h" class="c-h1">${esc(j.drug?.name)} ${esc(j.drug?.strength)}</h1>
      <p class="ink m0">${esc(j.qty)} × ${esc((j.drug?.form || '').toLowerCase())}</p>
      <div class="facts">${range ? `<span>${icon('thermo')}${esc(range)}${j.storageClass ? ` · ${esc(j.storageClass.toLowerCase().replace(/_/g, ' '))}` : ''}</span>` : ''}${eta ? `<span>${icon('clock')}${esc(eta)}</span>` : ''}</div>
      ${j.routeNote ? `<div class="banner amber" role="status">${icon('alert')}<p>${esc(j.routeNote)}</p></div>` : ''}`;
}
function render() {
  const j = job;
  document.title = `${j.drug?.name || 'Delivery'} · MediLink courier`;
  map?.destroy();
  view.innerHTML = `<main class="c-main" id="main">
    <header class="c-top glass"><span class="wordmark">MediLink</span><span class="tag">Courier</span></header>
    <section class="card glass" id="c-head" aria-labelledby="c-h">${headHtml(j)}</section>
    <section class="card glass c-mapcard" aria-label="Route map"><div class="lt-map c-map" id="c-map" role="region" aria-label="Map from ${esc(j.pickup?.name)} to ${esc(j.drop?.name)}"></div></section>
    <ol class="c-stops">
      ${stop(j.pickup, 'A', 'Pick up', j.next === 'pickup' ? 'now' : 'done')}
      ${stop(j.drop, 'B', 'Deliver to the pharmacy', j.next === 'deliver' ? 'now' : j.next === 'done' ? 'done' : '')}
    </ol>
    ${j.handlingNote ? `<div class="notebox"><p class="label mb4">Handling note</p>${esc(j.handlingNote)}</div>` : ''}
    <section id="c-act" class="card glass" aria-labelledby="act-h"></section>
    <p class="stage-foot">MediLink · synthetic demo data${j.expiresAt ? ` · this link works until ${esc(timeIN(j.expiresAt))}` : ''}</p>
  </main>`;
  map = liveMap($('#c-map'), { origin: j.pickup, destination: j.drop, route: j.route?.points, position: share.last, riderLabel: 'You' });
  renderAct();
}

// ---------------------------------------------------------------- what to do next
const PICKUP_FIELDS = () => [
  { name: 'batchNo', label: 'Batch label(s)', type: 'barcode', required: true, hint: 'Scan every batch label on the boxes. Several batches: separate them with commas.' },
  { name: 'sealId', label: 'Seal', type: 'barcode', required: true },
  { name: 'loggerId', label: 'Temperature logger', type: 'barcode', required: true },
  { name: 'riderName', label: 'Your name (optional)', type: 'text', autocomplete: 'name', default: job.rider?.name || '' },
  { name: 'riderPhone', label: 'Your phone (optional, so the hospital can call you)', type: 'tel', autocomplete: 'tel', default: job.rider?.phone || '' },
];
function renderAct() {
  const el = $('#c-act'); if (!el) return;
  const j = job;
  if (j.next === 'pickup' && !j.readOnly) {
    const fields = PICKUP_FIELDS();
    el.innerHTML = `<h2 id="act-h" class="h17">${icon('box')} Pickup scan</h2>
      <p class="m0">At ${esc(j.pickup?.name)}: check the seal is intact, then scan the labels${canScan ? '' : ' or type them'}.</p>
      <form id="pick" class="c-form" novalidate>${fields.map((f, i) => fieldHtml(f, i, 'p')).join('')}
        <div id="pick-err"></div><button type="submit" class="btn block" id="pick-ok">Confirm pickup</button></form>`;
    wireScan(el);
    const key = { busy: false };
    $('#pick').addEventListener('submit', async e => {
      e.preventDefault();
      if (key.busy) return;
      const values = await collect(e.target, fields, 'p');
      if (!values) return;
      key.busy = true; const ok = $('#pick-ok'); ok.disabled = true; ok.textContent = 'Saving…';
      try {
        const r = await capi('POST', '/courier/pickup', values);
        toast(r.message); job = r.job; render();
        $('#share-go')?.focus();
      } catch (err) {
        if (err.status === 401) return;
        $('#pick-err').innerHTML = errorCard(err, 'pick-retry');
        wireRetry('pick-retry', err, () => $('#pick').requestSubmit());
        ok.disabled = false; ok.textContent = 'Confirm pickup'; key.busy = false;
        if (err.code === 'INVALID_STATUS') refresh();
      }
    });
  } else if (j.next === 'deliver' && !j.readOnly) {
    const on = share.watch != null;
    el.innerHTML = `<h2 id="act-h" class="h17">${icon('truck')} On the way</h2>
      <p class="m0">Share your location so ${esc(j.drop?.name)} can see you coming. <b>Keep this page open</b> while you ride; the screen stays on while sharing.</p>
      <p class="c-share ${on ? 'on' : ''}" id="share-msg" role="status" aria-live="polite">${esc(share.msg || (on ? 'Waiting for GPS…' : 'Location is not being shared.'))}</p>
      <div class="acts">${on ? '<button type="button" class="btn ghost" id="share-stop">Stop sharing</button>' : '<button type="button" class="btn" id="share-go">Start sharing location</button>'}
        <button type="button" class="btn ghost" id="road">Road closed</button></div>
      <p class="muted m0">At the drop, hand the box to the pharmacist. They scan it in, and this page then shows Delivered.</p>`;
    $('#share-go')?.addEventListener('click', startSharing);
    $('#share-stop')?.addEventListener('click', () => { stopSharing(); renderAct(); });
    $('#road').addEventListener('click', roadClosed);
  } else {
    stopSharing();
    const delivered = ['DELIVERED', 'QUARANTINED'].includes(j.status);
    el.innerHTML = `<h2 id="act-h" class="h17">${icon('check')} ${delivered ? 'Delivered. Thank you!' : 'Nothing to do on this link'}</h2>
      <p class="m0">${delivered ? 'The hospital has taken over the medicine. You can close this page.' : 'This delivery is not active any more. Ask the hospital that is sending the medicine if you think this is wrong.'}</p>`;
  }
}

// ---------------------------------------------------------------- location sharing
const distM = (a, b) => { const R = 6371000, r = x => x * Math.PI / 180, dLat = r(b.lat - a.lat), dLon = r(b.long - a.long); const h = Math.sin(dLat / 2) ** 2 + Math.cos(r(a.lat)) * Math.cos(r(b.lat)) * Math.sin(dLon / 2) ** 2; return 2 * R * Math.asin(Math.sqrt(h)); };
function say(msg) { share.msg = msg; const m = $('#share-msg'); if (m) m.textContent = msg; }
function startSharing() {
  if (!window.isSecureContext) return say('Location sharing needs the secure (https) link. Ask the hospital for it.');
  if (!navigator.geolocation) return say('This phone cannot share its location from the browser.');
  share.msg = 'Waiting for GPS…';
  share.watch = navigator.geolocation.watchPosition(onFix, onGeoError, { enableHighAccuracy: true, maximumAge: 5000, timeout: 30000 });
  share.timer = setInterval(() => { if (share.last && Date.now() - share.sentAt >= SEND_EVERY_MS - 250) send(share.last); }, SEND_EVERY_MS / 2);
  wake();
  document.addEventListener('visibilitychange', rewake);
  renderAct();
}
function stopSharing() {
  if (share.watch != null) navigator.geolocation.clearWatch(share.watch);
  clearInterval(share.timer);
  share.watch = null; share.timer = 0; share.msg = '';
  share.lock?.release().catch(() => {}); share.lock = null;
  document.removeEventListener('visibilitychange', rewake);
}
async function wake() { try { share.lock = await navigator.wakeLock?.request('screen'); } catch { share.lock = null; } }
function rewake() { if (share.watch != null && document.visibilityState === 'visible') wake(); }
function onFix(p) {
  const fix = { lat: p.coords.latitude, long: p.coords.longitude, accuracyM: Math.round(p.coords.accuracy), ts: new Date(p.timestamp).toISOString() };
  share.last = fix;
  map?.move(fix);
  const gap = Date.now() - share.sentAt;
  if (!share.sent || (gap >= SEND_GAP_MS && distM(share.sent, fix) > MOVE_M) || gap >= SEND_EVERY_MS) send(fix);
}
function onGeoError(e) {
  if (e.code === 1) { stopSharing(); renderAct(); say('Location is blocked for this page. Allow location in your browser settings, then tap Start sharing location again.'); }
  else if (Date.now() - share.sentAt > 30000) say('Waiting for GPS… Move to open sky if this takes long.'); // a brief GPS gap is normal
}
async function send(fix) {
  if (share.busy || share.watch == null) return;
  share.busy = true;
  try {
    const r = await capi('POST', '/courier/location', fix);
    share.sent = fix; share.sentAt = Date.now();
    say(`Sharing your location · last sent ${timeIN(new Date().toISOString())}${r?.excursion ? ' · the temperature is out of range, tell the hospital' : ''}`);
  } catch (e) {
    if (e.status === 401) return;
    share.sentAt = Date.now() + (e.retryAfter || 0) * 1000; // 429: wait as told
    if (e.code === 'INVALID_STATUS') { refresh(); return; }
    say(e === NETWORK_ERROR ? 'No connection. Your location is sent again when you are back online.' : `Location not sent: ${e.title}. Retrying.`);
  } finally { share.busy = false; }
}

// ---------------------------------------------------------------- road closed
function roadClosed() {
  const dlg = $('#dlg'), f = [{ name: 'note', label: 'Where is it closed? (optional)', type: 'text' }];
  dlg.innerHTML = `<form method="dialog" id="rc" novalidate><h2 id="dlg-title">Road closed</h2>
    <p class="m0">MediLink finds a new route around it and tells the hospital.</p>${fieldHtml(f[0], 0, 'rc')}
    <div id="rc-err"></div><div class="acts"><button type="button" class="btn ghost small" id="rc-cancel">Cancel</button><button type="submit" class="btn small" id="rc-ok">Report road closed</button></div></form>`;
  dlg.showModal();
  $('#rc-cancel').addEventListener('click', () => dlg.close());
  $('#rc').addEventListener('submit', async e => {
    e.preventDefault();
    const values = await collect(e.target, f, 'rc'); if (!values) return;
    const ok = $('#rc-ok'); ok.disabled = true;
    try { const r = await capi('POST', '/courier/road-closed', values); dlg.close(); toast(r.message); refresh(); }
    catch (err) { if (err.status === 401) return dlg.close(); $('#rc-err').innerHTML = errorCard(err); ok.disabled = false; }
  });
  $('#rc-0').focus();
}
$('#dlg').addEventListener('click', e => { if (e.target.id === 'dlg') e.target.close(); });

// ---------------------------------------------------------------- load + refresh
async function refresh(force) {
  try {
    const fresh = await capi('GET', '/courier/job'), old = job;
    job = fresh;
    if (force || !old || ['status', 'next', 'readOnly'].some(k => fresh[k] !== old[k])) { if ($('#dlg').open) $('#dlg').close(); return render(); }
    // same step: update in place, so the map and the form keep their state
    if (JSON.stringify(fresh.route) !== JSON.stringify(old.route)) map?.setRoute(fresh.route?.points);
    if (fresh.eta !== old.eta || fresh.routeNote !== old.routeNote) $('#c-head').innerHTML = headHtml(fresh);
  } catch (e) {
    if (e.status === 401) return;
    if (!job) { view.innerHTML = `<main class="c-main" id="main"><header class="c-top glass"><span class="wordmark">MediLink</span><span class="tag">Courier</span></header>${errorCard(e, 'load-retry')}</main>`; wireRetry('load-retry', e, () => refresh(true)); }
  }
}
if (!token) expired(null);
else {
  refresh(true);
  refreshTimer = setInterval(() => { if (!document.hidden && !$('#pick')?.contains(document.activeElement)) refresh(); }, REFRESH_MS);
}
