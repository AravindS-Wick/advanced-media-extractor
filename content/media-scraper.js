// This content script runs in the ISOLATED world.
// It listens for messages from the page-injected script
// and forwards them to the extension (service worker → DevTools panel).

function onMessageFromPage(event) {
  if (event.source !== window) return;
  if (!event.data || event.data.source !== 'media-extractor-pro') return;

  // Safe check for runtime availability
  try {
    if (!chrome.runtime || !chrome.runtime.id) {
      window.removeEventListener('message', onMessageFromPage);
      return;
    }
  } catch (e) {
    // Context is invalidated, clean up listener
    try {
      window.removeEventListener('message', onMessageFromPage);
    } catch (_) {}
    return;
  }

  // Safe to send
  try {
    chrome.runtime.sendMessage({ type: 'FROM_PAGE', data: event.data });
  } catch (e) {
    try {
      window.removeEventListener('message', onMessageFromPage);
    } catch (_) {}
  }
}

window.addEventListener('message', onMessageFromPage);

// Also scrape DOM for generic media elements (audio/video tags, source tags, links)
function scrapeDOM() {
  try {
    if (!chrome.runtime || !chrome.runtime.id) return;
  } catch (e) {
    return;
  }

  const found = [];
  const seen = new Set();

  let pageDuration = 0;
  try {
    const vEl = document.querySelector('video');
    if (vEl && vEl.duration && !isNaN(vEl.duration) && isFinite(vEl.duration)) {
      pageDuration = Math.round(vEl.duration);
    }
  } catch (_) {}

  function add(url, type, quality = '', codec = '', customKind = '') {
    if (!url) return;
    if (/(\.cdninstagram\.com|\.fbcdn\.net)/i.test(url)) {
      try {
        const parsed = new URL(url);
        if (parsed.searchParams.has('bytestart') || parsed.searchParams.has('byteend')) {
          parsed.searchParams.delete('bytestart');
          parsed.searchParams.delete('byteend');
          url = parsed.toString();
        }
      } catch (_) {}
    }
    if (seen.has(url)) return;
    seen.add(url);
    const isHls = customKind === 'hls' || /\.m3u8/i.test(url);
    const isDash = customKind === 'dash' || /\.mpd/i.test(url);
    const kind = isHls ? 'hls' : isDash ? 'dash' : (customKind || 'file');
    const isVideo = type === 'video' || isHls || isDash;
    const isAudio = type === 'audio';

    if (isVideo && (/youtube\.com\/(embed|v|watch)/i.test(url) || /youtu\.be\//i.test(url) || /\/embed\//i.test(url))) return;

    found.push({
      url,
      type: isVideo ? 'video' : isAudio ? 'audio' : type,
      kind,
      quality: quality || (isHls ? 'HLS' : isDash ? 'DASH' : ''),
      codec,
      mimeType: codec || '',
      duration: isVideo ? pageDuration : 0,
      isVideo,
      isAudio
    });
  }

  function addSubtitle(url, label) {
    if (!url || seen.has(url)) return;
    seen.add(url);
    found.push({
      url,
      type: 'doc',
      kind: 'subtitle',
      quality: label || 'Subtitles',
      codec: '',
      mimeType: 'text/vtt',
      duration: 0,
      isVideo: false,
      isAudio: false,
      isSubtitle: true
    });
  }

  // <video> and <audio> elements
  document.querySelectorAll('video, audio').forEach(el => {
    const tag = el.tagName.toLowerCase();
    if (el.src) add(el.src, tag);
    el.querySelectorAll('source').forEach(s => add(s.src, tag, '', s.type));
    el.querySelectorAll('track').forEach(t => {
      const kind = (t.getAttribute('kind') || '').toLowerCase();
      if (kind && kind !== 'subtitles' && kind !== 'captions') return;
      addSubtitle(t.src, t.label || t.srclang || 'Subtitles');
    });
  });

  // OpenGraph & Twitter video/media meta tags (Instagram, Facebook, X, etc.)
  document.querySelectorAll('meta[property="og:video"], meta[property="og:video:url"], meta[property="og:video:secure_url"], meta[name="twitter:player:stream"]').forEach(m => {
    if (m.content && !/youtube\.com\/(embed|v|watch)/i.test(m.content) && !/youtu\.be\//i.test(m.content) && !/\/embed\//i.test(m.content)) {
      add(m.content, 'video', 'Direct Stream', 'video/mp4', 'file');
    }
  });
  document.querySelectorAll('meta[property="og:image"], meta[name="twitter:image"]').forEach(m => {
    if (m.content) add(m.content, 'image', 'Image', 'image/jpeg', 'file');
  });

  // <a> links to media files
  const mediaExtensions = /\.(mp4|webm|mkv|avi|mov|m4v|mp3|m4a|ogg|wav|flac|aac|pdf|docx?|pptx?|xlsx?|torrent|m3u8|mpd)(\?.*)?$/i;
  document.querySelectorAll('a[href]').forEach(a => {
    const isPdfPath = /\/pdf\/[a-z0-9.-]+/i.test(a.href);
    if (mediaExtensions.test(a.href) || isPdfPath) {
      const ext = a.href.match(/\.(mp4|webm|mkv|avi|mov|mp3|m4a|ogg|wav|flac|aac|pdf|torrent|m3u8|mpd)/i);
      const isHls = /\.m3u8/i.test(a.href);
      const isDash = /\.mpd/i.test(a.href);
      const type = ext ? (['mp4','webm','mkv','avi','mov','m4v'].includes(ext[1]) || isHls || isDash ? 'video' : ['mp3','m4a','ogg','wav','flac','aac'].includes(ext[1]) ? 'audio' : 'doc') : 'doc';
      add(a.href, type, '', '', isHls ? 'hls' : isDash ? 'dash' : 'file');
    }
  });

  // Scrape all elements for custom data attributes that contain media URLs
  document.querySelectorAll('*').forEach(el => {
    for (const attr of el.attributes) {
      const name = attr.name.toLowerCase();
      if (name.includes('src') || name.includes('url') || name.includes('video') || name.includes('stream') || name.includes('href')) {
        const val = attr.value;
        if (val && typeof val === 'string' && !val.startsWith('data:') && !val.startsWith('blob:')) {
          let absUrl;
          try { absUrl = new URL(val, window.location.href).href; } catch (_) { continue; }
          if (mediaExtensions.test(absUrl)) {
            const extMatch = absUrl.match(/\.(mp4|webm|mkv|avi|mov|m4v|mp3|m4a|ogg|wav|flac|aac|pdf|torrent|m3u8|mpd)/i);
            const isHls = /\.m3u8/i.test(absUrl);
            const isDash = /\.mpd/i.test(absUrl);
            const type = extMatch ? (['mp4','webm','mkv','avi','mov','m4v'].includes(extMatch[1]) || isHls || isDash ? 'video' : ['mp3','m4a','ogg','wav','flac','aac'].includes(extMatch[1]) ? 'audio' : 'doc') : 'doc';
            add(absUrl, type, '', '', isHls ? 'hls' : isDash ? 'dash' : 'file');
          } else if (/\/pdf\/[a-z0-9.-]+/i.test(absUrl)) {
            add(absUrl, 'doc', '', '', 'file');
          }
        }
      }
    }
  });

  // Scan all page script elements and innerHTML for media URLs
  try {
    const pageHtml = document.documentElement.innerHTML;
    const absUrlRegex = /(https?:\/\/[^\s"'`<>]+?\.(?:mp4|webm|m4v|mkv|mov|flv|avi|mp3|m4a|aac|ogg|opus|wav|flac|pdf|docx?|pptx?|xlsx?|epub|rtf|csv|zip|rar|7z|apk|torrent|m3u8|mpd)(?:\?[^\s"'`<>]*)?)/gi;
    let m;
    while ((m = absUrlRegex.exec(pageHtml)) !== null) {
      const u = m[1];
      const isHls = /\.m3u8/i.test(u);
      const isDash = /\.mpd/i.test(u);
      const extMatch = u.match(/\.(mp4|webm|mkv|avi|mov|m4v|mp3|m4a|ogg|wav|flac|aac|pdf|torrent|m3u8|mpd)/i);
      const type = extMatch ? (['mp4','webm','mkv','avi','mov','m4v'].includes(extMatch[1]) || isHls || isDash ? 'video' : ['mp3','m4a','ogg','wav','flac','aac'].includes(extMatch[1]) ? 'audio' : 'doc') : 'doc';
      add(u, type, '', '', isHls ? 'hls' : isDash ? 'dash' : 'file');
    }

    const relUrlRegex = /(?:"|')([a-z0-9_\-\/\\.+]+?\.(?:mp4|webm|m4v|mkv|mov|flv|avi|mp3|m4a|aac|ogg|opus|wav|flac|pdf|docx?|pptx?|xlsx?|epub|rtf|csv|zip|rar|7z|apk|torrent|m3u8|mpd)(?:\?[^\s"'`<>]*)*)(?:"|')/gi;
    while ((m = relUrlRegex.exec(pageHtml)) !== null) {
      const rawUrl = m[1].replace(/\\/g, '');
      try {
        const u = new URL(rawUrl, window.location.href).href;
        const isHls = /\.m3u8/i.test(u);
        const isDash = /\.mpd/i.test(u);
        const extMatch = u.match(/\.(mp4|webm|mkv|avi|mov|m4v|mp3|m4a|ogg|wav|flac|aac|pdf|torrent|m3u8|mpd)/i);
        const type = extMatch ? (['mp4','webm','mkv','avi','mov','m4v'].includes(extMatch[1]) || isHls || isDash ? 'video' : ['mp3','m4a','ogg','wav','flac','aac'].includes(extMatch[1]) ? 'audio' : 'doc') : 'doc';
        add(u, type, '', '', isHls ? 'hls' : isDash ? 'dash' : 'file');
      } catch (_) {}
    }
  } catch (_) {}

  if (found.length > 0) {
    try {
      chrome.runtime.sendMessage({
        type: 'FROM_PAGE',
        data: {
          source: 'media-extractor-pro',
          type: 'DOM_MEDIA',
          payload: { title: document.title, streams: found, url: window.location.href }
        }
      });
    } catch (e) {}
  }
}

// Run DOM scraper after page fully loads
if (document.readyState === 'complete') {
  scrapeDOM();
} else {
  window.addEventListener('load', scrapeDOM);
}

// Monitor SPA URL changes (Single Page App navigation)
let lastLocationUrl = location.href;
setInterval(() => {
  if (location.href !== lastLocationUrl) {
    lastLocationUrl = location.href;
    try {
      if (chrome.runtime && chrome.runtime.id) {
        chrome.runtime.sendMessage({ type: 'CLEAR_TAB_MEDIA' });
        setTimeout(scrapeDOM, 1000);
      }
    } catch (_) {}
  }
}, 1000);

// Monitor SPA episode/source switches that DON'T change location.href at all
// (e.g. an in-page episode player where Prev/Next or an episode number just
// swaps the <video> source). The old sniffed streams from the previous
// episode never get cleared in that case, so the extension keeps showing —
// and downloading — stale data from whatever episode loaded first. Native
// media events + polling the current source catch this regardless of how the
// site itself is built.
function currentVideoSrcSignature() {
  const v = document.querySelector('video');
  if (!v) return '';
  return v.currentSrc || v.src || '';
}

let lastVideoSrcSignature = currentVideoSrcSignature();

function handlePossibleEpisodeChange() {
  const sig = currentVideoSrcSignature();
  if (!sig || sig === lastVideoSrcSignature) return;
  lastVideoSrcSignature = sig;
  try {
    if (chrome.runtime && chrome.runtime.id) {
      chrome.runtime.sendMessage({ type: 'CLEAR_TAB_MEDIA' });
      setTimeout(scrapeDOM, 1000);
    }
  } catch (_) {}
}

// 'loadstart' fires whenever a <video> begins loading new source data — the
// most reliable native signal for an episode/quality switch. Media events
// don't bubble, so this has to be a capture-phase listener on the document.
document.addEventListener('loadstart', (e) => {
  if (e.target && e.target.tagName === 'VIDEO') handlePossibleEpisodeChange();
}, true);

// Fallback for players that tear down and recreate the <video> element
// itself (loadstart on the old node would never reach us): poll the current
// source signature too.
setInterval(handlePossibleEpisodeChange, 2000);

// Dynamic Cosmetic Ad Blocker Styles Management
const COSMETIC_ADBLOCK_CSS = `
[id*="google_ads"],[id*="gpt-ad"],[class*="ad-box"],[class*="ad-container"],[class*="ad-banner"],[class*="ad-unit"],[class*="ad-wrapper"],[class*="ad-slot"],.sponsored-post,.sponsored-content,.trc_rbox_outer,.outbrain-template,.taboola,.criteo-ad,.ad-header,.ad-footer,div[id^="ad_"],div[class^="ad_"],iframe[src*="doubleclick.net"],iframe[src*="googlesyndication.com"],iframe[src*="adservice"],iframe[src*="adsystem"],.dm-player-ad,.dm-ad-companion,[class*="dm-ad-"],div[id*="dailymotion-ad"],#player-ads,.ytp-ad-module,.ytp-ad-overlay-container,.ytp-ad-text,ytd-promoted-sparkles-web-renderer,ytd-promoted-video-renderer,ytd-display-ad-renderer,ytd-banner-promo-renderer,ytd-statement-banner-renderer,ytd-in-feed-ad-layout-renderer {
  display: none !important;
  visibility: hidden !important;
  pointer-events: none !important;
}
`;

function updateCosmeticAdBlock(enabled) {
  let styleEl = document.getElementById('media-extractor-cosmetic-adblock');
  if (enabled) {
    if (!styleEl) {
      styleEl = document.createElement('style');
      styleEl.id = 'media-extractor-cosmetic-adblock';
      styleEl.textContent = COSMETIC_ADBLOCK_CSS;
      (document.head || document.documentElement).appendChild(styleEl);
    }
  } else {
    if (styleEl) {
      styleEl.remove();
    }
  }
}

function checkAndApplyCosmeticAdBlock() {
  chrome.storage.local.get(['adBlockEnabled', 'adBlockDisabledDomains'], (res) => {
    const globalEnabled = typeof res.adBlockEnabled === 'boolean' ? res.adBlockEnabled : true;
    const disabledDomains = Array.isArray(res.adBlockDisabledDomains) ? res.adBlockDisabledDomains : [];

    const host = location.hostname.toLowerCase().replace(/^www\./, '');
    const isDomainDisabled = disabledDomains.some(d => {
      const clean = d.toLowerCase().replace(/^www\./, '').trim();
      return host === clean || host.endsWith('.' + clean);
    });

    const shouldEnable = globalEnabled && !isDomainDisabled;
    updateCosmeticAdBlock(shouldEnable);
  });
}

try {
  checkAndApplyCosmeticAdBlock();

  chrome.storage.onChanged.addListener((changes) => {
    if (changes.adBlockEnabled || changes.adBlockDisabledDomains) {
      checkAndApplyCosmeticAdBlock();
    }
  });
} catch (_) {}
