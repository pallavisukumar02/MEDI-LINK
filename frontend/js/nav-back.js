(function () {
  'use strict';

  var NAV_KEY = 'medilink_in_app_nav';

  function isLanding() {
    var p = location.pathname.toLowerCase();
    if (p.includes('app.html') || p.includes('courier.html')) return false;
    return true;
  }

  function getFallbackTarget() {
    if (isLanding()) return null;
    var p = location.pathname.toLowerCase();
    var hash = (location.hash || '').toLowerCase();
    if (p.includes('courier.html')) return 'index.html';

    // In app.html:
    if (hash === '#/home' || hash === '' || hash === '#/' || hash === '#/login') {
      return 'index.html';
    }
    return '#/home';
  }

  function handleBack(e) {
    if (e) {
      e.preventDefault();
      e.stopPropagation();
    }

    // If a modal dialog is open, close it first without leaving the page
    var openDialog = document.querySelector('dialog[open]');
    if (openDialog && typeof openDialog.close === 'function') {
      openDialog.close();
      return;
    }

    var navCount = Number(sessionStorage.getItem(NAV_KEY) || 0);
    var sameOriginRef = false;
    if (document.referrer) {
      try {
        sameOriginRef = new URL(document.referrer).origin === location.origin;
      } catch (err) {}
    }
    var canGoBack = (navCount > 0) || (window.history.length > 1 && sameOriginRef);

    var hash = (location.hash || '').toLowerCase();
    // On app Home with no prior in-app history, explicitly take user to landing page
    if ((hash === '#/home' || hash === '' || hash === '#/') && navCount === 0 && !sameOriginRef) {
      location.href = 'index.html';
      return;
    }

    if (canGoBack) {
      var prevHref = location.href;
      window.history.back();
      setTimeout(function () {
        if (location.href === prevHref) {
          var fb = getFallbackTarget();
          if (fb) {
            if (fb.startsWith('#')) location.hash = fb;
            else location.href = fb;
          }
        }
      }, 250);
    } else {
      var fallback = getFallbackTarget();
      if (fallback) {
        if (fallback.startsWith('#')) location.hash = fallback;
        else location.href = fallback;
      }
    }
  }

  function createBackElement() {
    var wrap = document.createElement('div');
    wrap.className = 'nav-back-wrap';

    var btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'nav-back';
    btn.setAttribute('aria-label', 'Go back');
    btn.setAttribute('title', 'Go back');

    btn.innerHTML = '<svg class="nav-back__icon" viewBox="0 0 24 24" width="20" height="20" aria-hidden="true" focusable="false" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="m12 19-7-7 7-7"/><path d="M19 12H5"/></svg>';

    btn.addEventListener('click', handleBack);
    btn.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        handleBack(e);
      }
    });

    wrap.appendChild(btn);
    return wrap;
  }

  function update() {
    if (isLanding()) {
      var existing = document.querySelector('.nav-back-wrap');
      if (existing) existing.remove();
      return;
    }

    var targetContainer = document.querySelector('main.page, main.c-main, #stage, #main');
    if (!targetContainer) return;

    var existingWrap = targetContainer.querySelector(':scope > .nav-back-wrap');
    if (!existingWrap) {
      var wrap = createBackElement();
      var cTop = targetContainer.querySelector(':scope > .c-top');
      if (cTop && cTop.nextSibling) {
        targetContainer.insertBefore(wrap, cTop.nextSibling);
      } else {
        targetContainer.insertBefore(wrap, targetContainer.firstChild);
      }
    }
  }

  window.addEventListener('hashchange', function () {
    var count = Number(sessionStorage.getItem(NAV_KEY) || 0);
    sessionStorage.setItem(NAV_KEY, String(count + 1));
    update();
  });

  if (typeof MutationObserver !== 'undefined') {
    var observer = new MutationObserver(function () {
      update();
    });
    observer.observe(document.documentElement, { childList: true, subtree: true });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', update);
  } else {
    update();
  }
})();
