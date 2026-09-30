/**
 * Redirect Guard — MAIN world companion to content/redirect-blocker.js
 *
 * Runs in the page's own JS context (world: MAIN, see manifest.json) so it can
 * replace window.open before a popunder script ever gets a window handle.
 *
 * It deliberately does NOT patch location.href / assign / replace. Location's
 * members are [LegacyUnforgeable] in WebIDL: `href` is a non-configurable OWN
 * property of the location instance, not an accessor on Location.prototype, so
 * it cannot be redefined in any browser. An earlier version tried, and the
 * failure was silent because the attempt sat inside a try/catch. Navigation
 * hijacks (location assignment, meta refresh, form.submit, server 302 chains)
 * are detected in the service worker via chrome.webNavigation instead — see the
 * intent/outcome engine in service-worker.js.
 *
 * No domain lists or URL patterns live here. The only question this file answers
 * is the one it can answer synchronously, from the DOM, with no lists at all:
 * "did a real link click lead to this popup?"
 */
(function () {
  'use strict';

  const MARKER = '__mepRedirectGuard__';
  const GESTURE_WINDOW_MS = 1000;

  let enabled = true;

  // ──────────────────────────────────────────────
  // STATE PUSHED IN FROM THE ISOLATED WORLD
  // (that side owns chrome.storage; this side has no extension APIs)
  // ──────────────────────────────────────────────
  window.addEventListener('message', function (e) {
    if (e.source !== window) return;
    const d = e.data;
    if (!d || d[MARKER] !== true || d.kind !== 'state') return;
    enabled = !!d.enabled;
  });

  // ──────────────────────────────────────────────
  // LAST USER GESTURE
  // Recorded at pointerdown, which fires before any handler the page installs
  // on mousedown/click can navigate.
  // ──────────────────────────────────────────────
  let lastGesture = { at: 0, anchorHref: null, hadAnchor: false };

  document.addEventListener('pointerdown', function (e) {
    let anchor = null;
    try {
      anchor = e.target && e.target.nodeType === 1 && e.target.closest
        ? e.target.closest('a[href]')
        : null;
    } catch (_) {}

    lastGesture = {
      at: Date.now(),
      anchorHref: anchor ? anchor.href : null,
      hadAnchor: !!anchor
    };
  }, true);

  function sameSite(a, b) {
    try {
      return new URL(a).hostname.replace(/^www\./, '') ===
             new URL(b).hostname.replace(/^www\./, '');
    } catch (_) {
      return false;
    }
  }

  /**
   * Decide whether a window.open call is a legitimate consequence of something
   * the user clicked. This is the invariant model applied to popups: a real
   * link click leaves an anchor behind, a popunder never does.
   */
  function isSanctionedPopup(fullUrl) {
    const sinceGesture = Date.now() - lastGesture.at;

    // No recent user gesture at all -> purely programmatic. Popunder.
    if (sinceGesture > GESTURE_WINDOW_MS) return false;

    // Gesture landed on a real link, and the popup goes where that link pointed.
    if (lastGesture.hadAnchor && lastGesture.anchorHref &&
        sameSite(lastGesture.anchorHref, fullUrl)) {
      return true;
    }

    // Gesture landed on a link, popup goes somewhere else entirely -> hijack.
    if (lastGesture.hadAnchor) return false;

    // Click was not on a link. Same-site popups are normal app behaviour
    // (a button opening a preview); cross-site ones are the overlay pattern.
    return sameSite(location.href, fullUrl);
  }

  function report(payload) {
    try {
      window.postMessage(Object.assign({ [MARKER]: true, kind: 'popup-blocked' }, payload), '*');
    } catch (_) {}
  }

  // ──────────────────────────────────────────────
  // PATCH window.open
  // ──────────────────────────────────────────────
  const _open = window.open.bind(window);

  window.open = function (url, target, features) {
    if (!enabled || !url) return _open(url, target, features);

    let fullUrl;
    try {
      fullUrl = new URL(url, location.href).href;
    } catch (_) {
      return _open(url, target, features);
    }

    if (!/^https?:/i.test(fullUrl)) return _open(url, target, features);
    if (isSanctionedPopup(fullUrl)) return _open(url, target, features);

    report({ url: fullUrl, hadAnchor: lastGesture.hadAnchor });

    // Return null exactly as the browser's own popup blocker does, so pages
    // that null-check the result take their normal "popup blocked" path.
    return null;
  };
})();
