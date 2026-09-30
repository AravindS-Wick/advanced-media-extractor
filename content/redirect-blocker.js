/**
 * Redirect Link Blocker — Media Extractor PRO
 *
 * This script is the page-side half of an intent/outcome model:
 *
 *   1. When the user clicks, record what the HTML said would happen — the raw
 *      href attribute, exactly as DevTools shows it — and whether there was a
 *      link at all. That is the INTENT.
 *   2. The service worker watches chrome.webNavigation for what actually
 *      happened. That is the OUTCOME.
 *   3. If the outcome does not match the intent, the navigation was hijacked.
 *
 * The comparison itself lives in service-worker.js, which is the only context
 * that can see location assignments, meta refresh, form submits and server-side
 * 302 chains. No URL patterns or shortener lists live here any more: the old
 * pattern-matching classifier fired on any URL carrying a ?q= parameter, and
 * missed every redirector that was not already on its list.
 */
(function () {
  'use strict';

  const STORAGE_KEY_ENABLED = 'redirectBlockerEnabled';
  const STORAGE_KEY_DISABLED_DOMAINS = 'redirectBlockerDisabledDomains';
  const MAIN_BRIDGE_MARKER = '__mepRedirectGuard__';

  // ──────────────────────────────────────────────
  // STATE
  // ──────────────────────────────────────────────
  let isEnabled = true;
  let permanentlyDisabledDomains = new Set();

  function currentHost() {
    return location.hostname.replace(/^www\./, '').toLowerCase();
  }

  function isBypassedForCurrentSite() {
    const host = currentHost();
    for (const d of permanentlyDisabledDomains) {
      const norm = String(d).replace(/^www\./, '').toLowerCase();
      if (host === norm || host.endsWith('.' + norm)) return true;
    }
    return false;
  }

  function pushStateToMainWorld() {
    try {
      window.postMessage({
        [MAIN_BRIDGE_MARKER]: true,
        kind: 'state',
        enabled: isEnabled && !isBypassedForCurrentSite()
      }, '*');
    } catch (_) {}
  }

  function loadSettings(cb) {
    try {
      chrome.storage.local.get([STORAGE_KEY_ENABLED, STORAGE_KEY_DISABLED_DOMAINS], (res) => {
        if (typeof res[STORAGE_KEY_ENABLED] === 'boolean') isEnabled = res[STORAGE_KEY_ENABLED];
        if (Array.isArray(res[STORAGE_KEY_DISABLED_DOMAINS])) {
          permanentlyDisabledDomains = new Set(res[STORAGE_KEY_DISABLED_DOMAINS]);
        }
        if (cb) cb();
      });
    } catch (_) {}
  }

  function notifySW(type, payload = {}) {
    try {
      chrome.runtime.sendMessage({ type, ...payload }, () => void chrome.runtime.lastError);
    } catch (_) {}
  }

  // ──────────────────────────────────────────────
  // INTENT RECORDING
  //
  // Sent on pointerdown (earliest signal, fires before any page handler can
  // navigate) and refreshed on click. The worker keeps only the latest per tab.
  //
  // The critical field is `hadAnchor`. An overlay hijack — a transparent div or
  // ad iframe covering the viewport — produces a click with NO anchor, so the
  // intent is empty. A cross-site navigation with an empty intent is the
  // signature no pattern list can express.
  // ──────────────────────────────────────────────
  function recordIntent(e) {
    if (!isEnabled || isBypassedForCurrentSite()) return;

    let anchor = null;
    try {
      anchor = e.target && e.target.nodeType === 1 && e.target.closest
        ? e.target.closest('a[href]')
        : null;
    } catch (_) {}

    notifySW('NAV_INTENT', {
      hadAnchor: !!anchor,
      rawHref: anchor ? (anchor.getAttribute('href') || '') : null,
      resolvedHref: anchor ? anchor.href : null,
      opensNewTab: anchor ? (anchor.target === '_blank' || e.ctrlKey || e.metaKey) : false,
      frameUrl: location.href,
      isTopFrame: window.top === window
    });
  }

  document.addEventListener('pointerdown', recordIntent, true);
  document.addEventListener('click', recordIntent, true);

  // A form submit or a keyboard-driven navigation is user-initiated too.
  document.addEventListener('submit', function () {
    if (!isEnabled || isBypassedForCurrentSite()) return;
    notifySW('NAV_INTENT', { userSubmitted: true, frameUrl: location.href, isTopFrame: window.top === window });
  }, true);

  // ──────────────────────────────────────────────
  // TOAST UI
  // ──────────────────────────────────────────────
  let toastEl = null;
  let toastTimeout = null;

  function injectToastIfNeeded() {
    const existing = document.getElementById('mep-redirect-toast');
    if (existing) { toastEl = existing; return; }
    const div = document.createElement('div');
    div.id = 'mep-redirect-toast';
    (document.body || document.documentElement).appendChild(div);
    toastEl = div;
  }

  function typeLabel(type) {
    if (type === 'overlay-click') return '<span class="mep-redirect-type-badge js-redirect">🖱️ Overlay Hijack</span>';
    if (type === 'popup') return '<span class="mep-redirect-type-badge js-redirect">⧉ Popunder</span>';
    if (type === 'chain') return '<span class="mep-redirect-type-badge url-redirect">↩ Redirect Chain</span>';
    return '<span class="mep-redirect-type-badge cross-domain">🌐 Destination Changed</span>';
  }

  function truncate(str, max = 60) {
    str = String(str || '');
    return str.length > max ? str.slice(0, max) + '…' : str;
  }

  function escHtml(str) {
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function hostOf(url) {
    try { return new URL(url).hostname.replace(/^www\./, ''); } catch (_) { return ''; }
  }

  function showToast({ expected, actual, type }) {
    injectToastIfNeeded();
    clearTimeout(toastTimeout);

    const expectedLine = expected
      ? escHtml(truncate(expected, 55))
      : '<em>nothing — you did not click a link</em>';

    toastEl.innerHTML = `
      <div class="mep-toast-header">
        <div class="mep-toast-icon">🛡️</div>
        <div class="mep-toast-title">Redirect Blocked</div>
        ${typeLabel(type)}
        <button class="mep-toast-close" id="mep-toast-dismiss" aria-label="Dismiss">✕</button>
      </div>
      <div class="mep-link-row">
        <span class="mep-link-label">The page said</span>
        <span class="mep-link-src">${expectedLine}</span>
        <span class="mep-arrow">↓ but it tried to send you to</span>
        <span class="mep-link-label">Destination</span>
        <span class="mep-link-dest">${escHtml(truncate(actual, 70))}</span>
      </div>
      <div class="mep-toast-actions">
        <button class="mep-btn mep-btn-proceed" id="mep-toast-proceed">✓ Go anyway</button>
        <button class="mep-btn mep-btn-session" id="mep-toast-session">Trust ${escHtml(hostOf(location.href) || 'this site')}</button>
        <button class="mep-btn mep-btn-block" id="mep-toast-block">✕ Stay here</button>
      </div>
    `;

    toastEl.querySelector('#mep-toast-proceed').onclick = () => {
      hideToast();
      notifySW('REDIRECT_ALLOW_ONCE', { url: actual });
    };
    toastEl.querySelector('#mep-toast-session').onclick = () => {
      hideToast();
      notifySW('REDIRECT_TRUST_SITE', { domain: currentHost() });
    };
    toastEl.querySelector('#mep-toast-block').onclick = () => hideToast();
    toastEl.querySelector('#mep-toast-dismiss').onclick = () => hideToast();

    requestAnimationFrame(() => {
      requestAnimationFrame(() => toastEl.classList.add('mep-visible'));
    });

    toastTimeout = setTimeout(() => hideToast(), 15000);
  }

  function hideToast() {
    if (toastEl) toastEl.classList.remove('mep-visible');
  }

  // ──────────────────────────────────────────────
  // VERDICTS FROM THE WORKER
  // ──────────────────────────────────────────────
  chrome.runtime.onMessage.addListener((msg) => {
    if (!msg || msg.type !== 'REDIRECT_VERDICT') return;
    if (window.top !== window) return; // only the top frame draws the toast
    showToast({ expected: msg.expected, actual: msg.actual, type: msg.hijackType });
  });

  // A navigation that was bounced back lands as a fresh page load, so ask the
  // worker whether it has a verdict waiting for this tab.
  function claimPendingVerdict() {
    if (window.top !== window) return;
    try {
      chrome.runtime.sendMessage({ type: 'CLAIM_REDIRECT_VERDICT' }, (resp) => {
        void chrome.runtime.lastError;
        if (resp && resp.pending) {
          showToast({ expected: resp.expected, actual: resp.actual, type: resp.hijackType });
        }
      });
    } catch (_) {}
  }

  // ──────────────────────────────────────────────
  // POPUP BLOCKS REPORTED BY THE MAIN-WORLD GUARD
  // ──────────────────────────────────────────────
  window.addEventListener('message', function (e) {
    if (e.source !== window) return;
    const d = e.data;
    if (!d || d[MAIN_BRIDGE_MARKER] !== true || d.kind !== 'popup-blocked') return;

    notifySW('REDIRECT_BLOCKED', { url: location.href, redirectUrl: d.url, type: 'popup' });
    showToast({
      expected: d.hadAnchor ? null : null,
      actual: d.url,
      type: 'popup'
    });
  });

  // ──────────────────────────────────────────────
  // SETTINGS SYNC
  // ──────────────────────────────────────────────
  try {
    chrome.storage.onChanged.addListener((changes) => {
      if (changes[STORAGE_KEY_ENABLED]) isEnabled = !!changes[STORAGE_KEY_ENABLED].newValue;
      if (changes[STORAGE_KEY_DISABLED_DOMAINS]) {
        permanentlyDisabledDomains = new Set(changes[STORAGE_KEY_DISABLED_DOMAINS].newValue || []);
      }
      pushStateToMainWorld();
    });
  } catch (_) {}

  loadSettings(() => {
    pushStateToMainWorld();
    claimPendingVerdict();
  });
})();
