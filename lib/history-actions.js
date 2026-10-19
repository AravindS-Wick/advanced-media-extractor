/**
 * lib/history-actions.js
 * Restart / "open source page" actions for entries in the download history.
 * Shared by the popup and the grabber page so both render the same buttons.
 */
(function (global) {
  'use strict';

  function isWebUrl(u) {
    return /^https?:\/\//i.test(u || '');
  }

  // A history entry can be restarted when we kept the media URL it came from.
  function canRestart(item) {
    return !!item && isWebUrl(item.sourceUrl || item.url) && item.kind !== 'zip';
  }

  function canOpenPage(item) {
    return !!item && isWebUrl(item.pageUrl);
  }

  function buttonsHtml(item) {
    return [
      canRestart(item) ? '<button class="btn-dl-action restart-btn" title="Download this again from the saved link">↻ Restart</button>' : '',
      canOpenPage(item) ? '<button class="btn-dl-action page-btn" title="Open the page this came from (use it to refresh an expired link)">🔗 Open page</button>' : ''
    ].join('');
  }

  // Starts the same kind of job the original download used, under a fresh id.
  function restart(item, done) {
    const url = item.sourceUrl || item.url;
    const base = { url, filename: item.filename, pageUrl: item.pageUrl || item.referrer || '' };
    const isHls = item.kind === 'hls' || /\.m3u8(\?|#|$)/i.test(url);
    const msg = isHls
      ? { type: 'MUX_HLS', id: 'mux_' + Math.random().toString(36).slice(2), ...base, preferredQuality: item.preferredQuality }
      : { type: 'DOWNLOAD_STREAM', ...base };
    chrome.runtime.sendMessage(msg, (resp) => done && done(resp));
  }

  function openPage(item) {
    chrome.tabs.create({ url: item.pageUrl });
  }

  // Wires the buttons buttonsHtml() produced inside `card`.
  function bind(card, item, onChange) {
    const r = card.querySelector('.restart-btn');
    if (r) {
      r.onclick = () => {
        r.disabled = true;
        r.textContent = 'Starting…';
        restart(item, () => onChange && onChange());
      };
    }
    const p = card.querySelector('.page-btn');
    if (p) p.onclick = () => openPage(item);
  }

  const api = { canRestart, canOpenPage, buttonsHtml, restart, openPage, bind };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else global.HistoryActions = api;
})(typeof self !== 'undefined' ? self : this);
