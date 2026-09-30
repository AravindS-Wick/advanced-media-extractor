// Service worker: bridges content scripts <-> DevTools panels
importScripts('lib/download-db.js');

// Store media found per tab
const tabMediaStore = {};

// ── Universal network sniffer (1DM-style): catch downloadable resources on ANY
// site/iframe by watching response content-types and URL extensions. Observational
// only (no blocking). Populates tabMediaStore so the grabber/panel can show them. ──
const EXT_VIDEO = /\.(mp4|webm|m4v|mkv|mov|flv|avi)(\?|#|$)/i;
const EXT_AUDIO = /\.(mp3|m4a|aac|ogg|opus|wav|flac)(\?|#|$)/i;
const EXT_DOC = /\.(pdf|docx?|pptx?|xlsx?|epub|rtf|csv|zip|rar|7z|apk|torrent)(\?|#|$)/i;
const EXT_HLS = /(\.m3u8|manifest\.m3u8|\/manifest\/video\/|\/master\.m3u8|\/hls\/|\.hls|\/chunklist|\/playlist\.m3u8|type=hls|format=hls|format=m3u8)/i;
const EXT_DASH = /(\.mpd|manifest\.mpd|\/dash\/|\.mpd\?|type=dash|format=mpd|format=dash)/i;

// chrome.downloads.download()'s filename must be a relative path: no drive
// letter, no leading slash, no ".." component, and no path segment containing
// : * ? " < > | — Chrome rejects the ENTIRE download with "Invalid filename"
// if any of that shows up, which is exactly what happens if someone types a
// real Windows path like "D:\Anime" into the folder setting. Split on
// separators and clean each segment individually so this can never produce
// an invalid path, no matter what was typed.
function sanitizeDownloadFolder(raw) {
  return (raw || '')
    .replace(/\\/g, '/')
    .split('/')
    .map((seg) => seg.replace(/[:*?"<>|]/g, '').trim())
    .filter((seg) => seg && seg !== '.' && seg !== '..')
    .join('/');
}

// Chrome extensions can only steer chrome.downloads.download() to a path
// *relative to* the browser's own Downloads directory (there's no API for an
// arbitrary absolute folder) — this reads the user's configured subfolder and
// prefixes it onto a filename so every save lands there without a prompt.
function withDownloadFolder(filename) {
  return new Promise((resolve) => {
    chrome.storage.local.get(['downloadSubfolder'], (res) => {
      const folder = sanitizeDownloadFolder(res.downloadSubfolder);
      resolve(folder ? `${folder}/${filename}` : filename);
    });
  });
}

function classifyResource(url, contentType = '') {
  const ct = (contentType || '').toLowerCase();
  const u = (url || '').toLowerCase();
  if (EXT_HLS.test(u) || ct.includes('mpegurl') || ct.includes('x-mpegurl') || ct.includes('vnd.apple.mpegurl') || ct.includes('application/vnd.apple.mpegurl') || ct.includes('audio/x-mpegurl')) {
    return { type: 'video', kind: 'hls' };
  }
  if (EXT_DASH.test(u) || ct.includes('dash+xml') || ct.includes('application/dash+xml')) {
    return { type: 'video', kind: 'dash' };
  }
  // Audio detection:
  // 1. Content-Type explicitly starts with audio/
  // 2. Extension is an explicit audio extension (.mp3, .m4a, .aac, .wav, .ogg, .flac)
  // 3. Instagram/Facebook or DASH audio streams (e.g. audio_dashinit, dash-audio, or audio in URL)
  const isAudioUrl = EXT_AUDIO.test(u) || (/audio/i.test(u) && !/video_dashinit/i.test(u)) || u.includes('audio_dashinit');
  if (ct.startsWith('audio/') || (!ct.startsWith('video/') && isAudioUrl)) {
    return { type: 'audio', kind: 'file' };
  }
  if (EXT_VIDEO.test(u) || ct.startsWith('video/')) {
    return { type: 'video', kind: 'file' };
  }
  if (EXT_DOC.test(u) || ct.includes('pdf') || ct.includes('officedocument') ||
      ct.includes('msword') || ct.includes('zip') || ct.includes('epub')) {
    return { type: 'doc', kind: 'file' };
  }
  return null;
}

function updateTabBadge(tabId) {
  if (!tabId || tabId < 0) return;
  try {
    const store = tabMediaStore[tabId];
    if (!store || !store.streams) {
      chrome.action.setBadgeText({ tabId, text: '' });
      return;
    }
    const cleanStreams = store.streams.filter(it => !/\.m4s(\?|#|$)/i.test(it.url) && !/\/frag\(\d+\)/i.test(it.url));
    const count = cleanStreams.length;
    if (count > 0) {
      chrome.action.setBadgeText({ tabId, text: count > 99 ? '99+' : String(count) });
      chrome.action.setBadgeBackgroundColor({ tabId, color: '#4f46e5' });
    } else {
      chrome.action.setBadgeText({ tabId, text: '' });
    }
  } catch (_) {}
}

function normalizeSniffedUrl(url) {
  if (!url || typeof url !== 'string') return url;
  // Instagram / Facebook CDN: clean bytestart & byteend range parameters so the full progressive MP4 is retrieved
  if (/(\.cdninstagram\.com|\.fbcdn\.net)/i.test(url)) {
    try {
      const u = new URL(url);
      if (u.searchParams.has('bytestart') || u.searchParams.has('byteend')) {
        u.searchParams.delete('bytestart');
        u.searchParams.delete('byteend');
        return u.toString();
      }
    } catch (_) {
      return url.replace(/([?&])bytestart=\d+(&|$)/gi, '$1')
                .replace(/([?&])byteend=\d+(&|$)/gi, '$1')
                .replace(/[?&]$/, '');
    }
  }
  return url;
}

function addSniffed(tabId, url, contentType, size = 0) {
  if (tabId < 0 || !/^https?:/i.test(url)) return;
  // Skip noisy segment spam (.m4s, fragment chunks, googlevideo)
  if (url.includes('googlevideo.com/videoplayback') || /\.m4s(\?|#|$)/i.test(url) || /\/frag\(\d+\)/i.test(url)) return;

  const cleanUrl = normalizeSniffedUrl(url);
  const isInstagramChunk = (cleanUrl !== url);
  url = cleanUrl;
  if (isInstagramChunk) size = 0;

  const c = classifyResource(url, contentType);
  if (!c) return;
  if (!tabMediaStore[tabId]) tabMediaStore[tabId] = { streams: [], title: '', url: '' };

  const existing = tabMediaStore[tabId].streams.find((s) => s.url === url);
  if (existing) {
    if (c.type === 'audio' && existing.type !== 'audio') {
      existing.type = 'audio';
      existing.isAudio = true;
      existing.isVideo = false;
    }
    if (!existing.kind || existing.kind === 'file') existing.kind = c.kind;
    if (!existing.size && size) existing.size = size;
    if (size && existing.size !== size) existing.size = size;
    return;
  }

  // Discard isolated tiny audio fragments (< 100KB)
  if (c.type === 'audio' && size > 0 && size < 100000) return;

  const existingPoster = tabMediaStore[tabId]?.poster || '';
  const existingTitle = tabMediaStore[tabId]?.title || '';

  tabMediaStore[tabId].streams.push({
    url, type: c.type, kind: c.kind, source: 'network',
    isVideo: c.type === 'video', isAudio: c.type === 'audio',
    mimeType: contentType || '', quality: c.kind === 'hls' ? 'HLS' : c.kind === 'dash' ? 'DASH' : '',
    size: size || 0,
    poster: existingPoster,
    metaTitle: existingTitle,
  });
  updateTabBadge(tabId);
  chrome.runtime.sendMessage({ type: 'MEDIA_UPDATE', tabId, data: tabMediaStore[tabId] }).catch(() => {});
}

chrome.webRequest.onHeadersReceived.addListener(
  (details) => {
    const ctHeader = (details.responseHeaders || []).find((h) => h.name.toLowerCase() === 'content-type');
    const lenHeader = (details.responseHeaders || []).find((h) => h.name.toLowerCase() === 'content-length');
    const size = lenHeader ? parseInt(lenHeader.value, 10) : 0;
    addSniffed(details.tabId, details.url, ctHeader ? ctHeader.value : '', size);
  },
  { urls: ['<all_urls>'] },
  ['responseHeaders']
);
// Also catch by extension before response (for direct media links / redirects)
chrome.webRequest.onBeforeRequest.addListener(
  (details) => { addSniffed(details.tabId, details.url, '', 0); },
  { urls: ['<all_urls>'] }
);

// Injected into the page (all frames) to harvest every downloadable resource in the DOM.
function collectPageResources() {
  const out = [];
  const seen = new Set();

  let pageVideoDuration = 0;
  let pageVideoPoster = '';
  let activeVideoEl = null;
  try {
    const allVideos = Array.from(document.querySelectorAll('video'));
    if (allVideos.length > 0) {
      // 1. Active playing video in viewport
      activeVideoEl = allVideos.find(v => !v.paused && v.currentTime > 0);
      // 2. Video closest to the vertical center of the window (active Instagram reel)
      if (!activeVideoEl) {
        const centerY = window.innerHeight / 2;
        let bestDist = Infinity;
        for (const v of allVideos) {
          const r = v.getBoundingClientRect();
          if (r.bottom > 0 && r.top < window.innerHeight) {
            const dist = Math.abs((r.top + r.height / 2) - centerY);
            if (dist < bestDist) {
              bestDist = dist;
              activeVideoEl = v;
            }
          }
        }
      }
      if (!activeVideoEl) activeVideoEl = allVideos[0];

      if (activeVideoEl.duration && !isNaN(activeVideoEl.duration) && isFinite(activeVideoEl.duration)) {
        pageVideoDuration = Math.round(activeVideoEl.duration);
      }
      if (activeVideoEl.poster) pageVideoPoster = activeVideoEl.poster;
    }
    if (!pageVideoPoster) {
      const ogImg = document.querySelector('meta[property="og:image"], meta[name="twitter:image"]');
      if (ogImg && ogImg.content) pageVideoPoster = ogImg.content;
    }
  } catch (_) {}

  const push = (raw, type, kind = 'file', meta = {}) => {
    if (!raw) return;
    let url;
    try { url = new URL(raw, location.href).href; } catch { return; }
    if (!/^https?:/i.test(url)) return;
    // Never treat YouTube webpage / embed URLs as downloadable video files
    if (type === 'video' && (/youtube\.com\/(embed|v|watch)/i.test(url) || /youtu\.be\//i.test(url))) return;

    // Dailymotion image resolution upgrade (/x160, /x240, /x360, /x480 -> /x1080)
    if (type === 'image' && url.includes('dmcdn.net/v/')) {
      url = url.replace(/\/x(160|240|360|480|720)(\?|$)/, '/x1080$2');
    }

    if (seen.has(url)) return;
    seen.add(url);
    out.push({
      url,
      type,
      kind,
      source: 'dom',
      isVideo: type === 'video',
      isAudio: type === 'audio',
      poster: meta.poster || (type === 'video' ? pageVideoPoster : ''),
      metaTitle: meta.title || '',
      duration: (type === 'video' || kind === 'hls' || kind === 'dash') ? pageVideoDuration : 0
    });
  };

  // Images & Picture sources
  document.querySelectorAll('img').forEach((img) => {
    push(img.currentSrc || img.src, 'image');
    if (img.srcset) img.srcset.split(',').forEach((s) => push(s.trim().split(/\s+/)[0], 'image'));
    // Lazy loaded image attributes
    ['data-src', 'data-srcset', 'data-original', 'data-lazy', 'data-lazy-src', 'data-poster', 'data-thumb'].forEach(attr => {
      const val = img.getAttribute(attr);
      if (val) push(val.trim().split(/\s+/)[0], 'image');
    });
  });
  document.querySelectorAll('picture source[srcset]').forEach((s) =>
    s.srcset.split(',').forEach((x) => push(x.trim().split(/\s+/)[0], 'image')));
  document.querySelectorAll('meta[property="og:image"], meta[name="twitter:image"]').forEach((m) => push(m.content, 'image'));

  // OpenGraph & Twitter video tags (Instagram, Facebook, X, etc.)
  document.querySelectorAll('meta[property="og:video"], meta[property="og:video:url"], meta[property="og:video:secure_url"], meta[name="twitter:player:stream"]').forEach((m) => {
    if (m.content && !/youtube\.com\/(embed|v|watch)/i.test(m.content) && !/\/embed\//i.test(m.content) && !/youtu\.be\//i.test(m.content)) {
      push(m.content, 'video', 'file');
    }
  });

  // Instagram embedded JSON scripts scanner
  if (location.hostname.includes('instagram.com')) {
    document.querySelectorAll('script[type="application/json"]').forEach((s) => {
      try {
        const text = s.textContent || '';
        if (text.includes('video_versions') || text.includes('display_url')) {
          const json = JSON.parse(text);
          const findMedia = (obj) => {
            if (!obj || typeof obj !== 'object') return;
            if (Array.isArray(obj.video_versions)) {
              for (const v of obj.video_versions) {
                if (v.url) push(v.url, 'video', 'file');
              }
            }
            if (obj.image_versions2 && Array.isArray(obj.image_versions2.candidates)) {
              for (const img of obj.image_versions2.candidates) {
                if (img.url) push(img.url, 'image', 'file');
              }
            }
            if (obj.display_url) push(obj.display_url, 'image', 'file');
            if (obj.video_url) push(obj.video_url, 'video', 'file');
            for (const k of Object.keys(obj)) {
              findMedia(obj[k]);
            }
          };
          findMedia(json);
        }
      } catch (_) {}
    });
  }

  // Inline <video>/<audio> (Prioritize active viewport video first)
  if (activeVideoEl) {
    push(activeVideoEl.currentSrc || activeVideoEl.src, 'video');
    activeVideoEl.querySelectorAll('source').forEach((s) => push(s.src, 'video'));
    if (activeVideoEl.poster) push(activeVideoEl.poster, 'image');
  }
  document.querySelectorAll('video').forEach((v) => {
    if (v === activeVideoEl) return;
    push(v.currentSrc || v.src, 'video');
    v.querySelectorAll('source').forEach((s) => push(s.src, 'video'));
    if (v.poster) push(v.poster, 'image');
  });
  document.querySelectorAll('audio').forEach((a) => {
    push(a.currentSrc || a.src, 'audio');
    a.querySelectorAll('source').forEach((s) => push(s.src, 'audio'));
  });

  // Background images (CSS style attribute and computed styles on media components)
  document.querySelectorAll('[style*="background"], [class*="thumb"], [class*="card"], [class*="poster"], [class*="img"], [class*="media"], [class*="video"]').forEach((el) => {
    const styleAttr = el.getAttribute('style') || '';
    const bgMatch = styleAttr.match(/url\(['"]?([^'"()]+)['"]?\)/i);
    if (bgMatch) push(bgMatch[1], 'image');

    // Check data attributes
    ['data-src', 'data-bg', 'data-background', 'data-thumbnail', 'data-poster', 'data-image'].forEach(attr => {
      const val = el.getAttribute(attr);
      if (val) push(val, 'image');
    });
  });

  // Anchor links to files
  const R = {
    doc: /\.(pdf|docx?|pptx?|xlsx?|epub|rtf|csv|zip|rar|7z|apk|torrent)(\?|#|$)/i,
    video: /\.(mp4|webm|m4v|mkv|mov|flv|avi)(\?|#|$)/i,
    audio: /\.(mp3|m4a|aac|ogg|opus|wav|flac)(\?|#|$)/i,
    image: /\.(jpe?g|png|gif|webp|bmp|svg|avif)(\?|#|$)/i,
    hls: /\.m3u8(\?|#|$)/i, dash: /\.mpd(\?|#|$)/i,
  };
  document.querySelectorAll('a[href]').forEach((a) => {
    const h = a.href;
    const isPdfPath = /\/pdf\/[a-z0-9.-]+/i.test(h);
    if (R.hls.test(h)) push(h, 'video', 'hls');
    else if (R.dash.test(h)) push(h, 'video', 'dash');
    else if (R.video.test(h)) push(h, 'video');
    else if (R.audio.test(h)) push(h, 'audio');
    else if (R.image.test(h)) push(h, 'image');
    else if (R.doc.test(h) || isPdfPath) push(h, 'doc');
  });

  // Scrape all elements for custom data attributes that contain media URLs
  document.querySelectorAll('*').forEach((el) => {
    for (const attr of el.attributes) {
      const name = attr.name.toLowerCase();
      if (name.includes('src') || name.includes('url') || name.includes('video') || name.includes('stream') || name.includes('href')) {
        const val = attr.value;
        if (val && typeof val === 'string' && !val.startsWith('data:') && !val.startsWith('blob:')) {
          let absUrl;
          try { absUrl = new URL(val, location.href).href; } catch (_) { continue; }
          const isPdfPath = /\/pdf\/[a-z0-9.-]+/i.test(absUrl);
          if (R.hls.test(absUrl)) push(absUrl, 'video', 'hls');
          else if (R.dash.test(absUrl)) push(absUrl, 'video', 'dash');
          else if (R.video.test(absUrl)) push(absUrl, 'video');
          else if (R.audio.test(absUrl)) push(absUrl, 'audio');
          else if (R.image.test(absUrl)) push(absUrl, 'image');
          else if (R.doc.test(absUrl) || isPdfPath) push(absUrl, 'doc');
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
      if (R.hls.test(u)) push(u, 'video', 'hls');
      else if (R.dash.test(u)) push(u, 'video', 'dash');
      else if (R.video.test(u)) push(u, 'video');
      else if (R.audio.test(u)) push(u, 'audio');
      else if (R.image.test(u)) push(u, 'image');
      else if (R.doc.test(u)) push(u, 'doc');
    }

    const relUrlRegex = /(?:"|')([a-z0-9_\-\/\\.+]+?\.(?:mp4|webm|m4v|mkv|mov|flv|avi|mp3|m4a|aac|ogg|opus|wav|flac|pdf|docx?|pptx?|xlsx?|epub|rtf|csv|zip|rar|7z|apk|torrent|m3u8|mpd)(?:\?[^\s"'`<>]*)*)(?:"|')/gi;
    while ((m = relUrlRegex.exec(pageHtml)) !== null) {
      const rawUrl = m[1].replace(/\\/g, '');
      try {
        const u = new URL(rawUrl, location.href).href;
        if (R.hls.test(u)) push(u, 'video', 'hls');
        else if (R.dash.test(u)) push(u, 'video', 'dash');
        else if (R.video.test(u)) push(u, 'video');
        else if (R.audio.test(u)) push(u, 'audio');
        else if (R.image.test(u)) push(u, 'image');
        else if (R.doc.test(u)) push(u, 'doc');
      } catch (_) {}
    }
  } catch (_) {}

  return out;
}

// Ensure the offscreen muxer document exists (used for client-side HLS assembly).
let offscreenReady = null;
async function ensureOffscreen() {
  if (await chrome.offscreen.hasDocument()) return;
  if (!offscreenReady) {
    offscreenReady = chrome.offscreen.createDocument({
      url: 'offscreen/offscreen.html',
      reasons: ['BLOBS'],
      justification: 'Assemble HLS video segments into a downloadable file (no server).',
    }).finally(() => { offscreenReady = null; });
  }
  await offscreenReady;
}

// Dynamic rule ID bands. Keeping them disjoint stops the ad-block whitelist,
// the per-download header rules and the static ruleset (ids 1-20) from ever
// clobbering one another.
const RULE_BAND_DOMAIN_ALLOW = 100000; // 100000-899999, rebuilt wholesale
const RULE_BAND_HEADERS = 900000;      // 900000-999999, one per active download

let headerRuleCounter = 0;
function nextHeaderRuleId() {
  headerRuleCounter = (headerRuleCounter + 1) % 100000;
  return RULE_BAND_HEADERS + headerRuleCounter;
}

/**
 * Content length for a media URL. Tries HEAD first, then falls back to a
 * single-byte Range GET for servers that reject HEAD, reading the total out of
 * the Content-Range header.
 */
async function probeSize(url) {
  try {
    const res = await fetch(url, { method: 'HEAD', credentials: 'include' });
    if (res.ok) {
      const len = res.headers.get('content-length');
      if (len) return parseInt(len, 10) || 0;
    }
  } catch (_) {}

  try {
    const res = await fetch(url, { headers: { Range: 'bytes=0-0' }, credentials: 'include' });
    if (res.status === 206) {
      const cr = res.headers.get('content-range');
      const m = cr && cr.match(/\/(\d+)\s*$/);
      if (m) return parseInt(m[1], 10) || 0;
    }
  } catch (_) {}

  return 0;
}

/**
 * Referer/Origin for a media fetch: the page the media was found on, else the
 * media URL's own origin, else nothing at all. Returning empty strings tells
 * callers to skip the header rule entirely rather than send a fabricated value.
 */
function deriveReferer(pageUrl, mediaUrl) {
  for (const candidate of [pageUrl, mediaUrl]) {
    if (!candidate) continue;
    try {
      const u = new URL(candidate);
      if (!/^https?:$/.test(u.protocol)) continue;
      return { referer: u.origin + '/', origin: u.origin };
    } catch (_) {}
  }
  return { referer: '', origin: '' };
}

function normalizeDomain(urlOrHost) {
  if (!urlOrHost) return '';
  try {
    let host = urlOrHost;
    if (urlOrHost.includes('://')) {
      host = new URL(urlOrHost).hostname;
    }
    return host.toLowerCase().replace(/^www\./, '').split(':')[0].trim();
  } catch (_) {
    return urlOrHost.toLowerCase().replace(/^www\./, '').split(':')[0].trim();
  }
}

function isDomainInList(domain, list) {
  const norm = normalizeDomain(domain);
  if (!norm || !Array.isArray(list)) return false;
  return list.some(item => {
    const normItem = normalizeDomain(item);
    return norm === normItem || norm.endsWith('.' + normItem);
  });
}

async function syncDomainAllowRules(disabledDomains) {
  const existingRules = await chrome.declarativeNetRequest.getDynamicRules();
  const domainRuleIds = existingRules.filter(r => r.id >= 100000 && r.id < 900000).map(r => r.id);

  // These rules are rebuilt from scratch on every change, so IDs only need to
  // be unique within this batch — no hashing, and therefore no collisions.
  let nextId = RULE_BAND_DOMAIN_ALLOW;
  const addRules = [];

  for (const d of disabledDomains) {
    const cleanD = normalizeDomain(d);
    if (!cleanD) continue;

    // `allowAllRequests` accepts ONLY main_frame and sub_frame — passing any
    // other resource type makes Chrome reject the whole updateDynamicRules
    // batch, which is why the per-site whitelist silently never applied.
    // Matching the main_frame request by requestDomains covers every
    // subresource loaded into that document, including descendant frames.
    addRules.push({
      id: nextId++,
      priority: 100,
      action: { type: 'allowAllRequests' },
      condition: {
        requestDomains: [cleanD],
        resourceTypes: ['main_frame', 'sub_frame']
      }
    });

    // Belt and braces for subresources whose initiator is the paused site but
    // whose document did not itself match above.
    addRules.push({
      id: nextId++,
      priority: 100,
      action: { type: 'allow' },
      condition: {
        initiatorDomains: [cleanD],
        resourceTypes: ['script', 'image', 'stylesheet', 'font', 'media', 'xmlhttprequest', 'other']
      }
    });
  }

  await chrome.declarativeNetRequest.updateDynamicRules({
    removeRuleIds: domainRuleIds,
    addRules
  });
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  // Ad Blocker status & per-domain toggle
  if (message.type === 'GET_ADBLOCK_STATUS') {
    const targetDomain = normalizeDomain(message.domain || '');
    chrome.storage.local.get(['adBlockEnabled', 'adBlockDisabledDomains'], (res) => {
      const globalEnabled = typeof res.adBlockEnabled === 'boolean' ? res.adBlockEnabled : true;
      const disabledDomains = Array.isArray(res.adBlockDisabledDomains) ? res.adBlockDisabledDomains : [];
      const isDomainDisabled = targetDomain ? isDomainInList(targetDomain, disabledDomains) : false;
      const domainEnabled = globalEnabled && !isDomainDisabled;
      sendResponse({
        globalEnabled,
        domainEnabled,
        isDomainDisabled,
        disabledDomains,
        domain: targetDomain
      });
    });
    return true;
  }
  if (message.type === 'TOGGLE_ADBLOCK') {
    const { domain, enable, isGlobal } = message;
    if (isGlobal) {
      const globalEnable = !!enable;
      chrome.storage.local.set({ adBlockEnabled: globalEnable }, () => {
        syncAdBlockRuleset().then(() => {
          sendResponse({ ok: true, globalEnabled: globalEnable });
        });
      });
      return true;
    }

    const targetDomain = normalizeDomain(domain);
    if (!targetDomain) {
      sendResponse({ ok: false, error: 'Invalid domain' });
      return true;
    }

    chrome.storage.local.get(['adBlockDisabledDomains'], (res) => {
      let disabled = Array.isArray(res.adBlockDisabledDomains) ? [...res.adBlockDisabledDomains] : [];
      if (enable) {
        // Re-enable on domain -> remove from disabled list
        disabled = disabled.filter(d => normalizeDomain(d) !== targetDomain);
      } else {
        // Disable on domain -> add to disabled list
        if (!disabled.some(d => normalizeDomain(d) === targetDomain)) {
          disabled.push(targetDomain);
        }
      }

      chrome.storage.local.set({ adBlockDisabledDomains: disabled }, () => {
        syncDomainAllowRules(disabled).then(() => {
          sendResponse({ ok: true, domain: targetDomain, domainEnabled: !!enable, disabledDomains: disabled });
        }).catch(err => {
          sendResponse({ ok: false, error: err.message });
        });
      });
    });
    return true;
  }
  // Clear stored tab media
  if (message.type === 'CLEAR_TAB_MEDIA') {
    // Content scripts don't pass tabId explicitly (they don't know their own
    // tab id) — Chrome already attaches it to sender.tab for us. Extension
    // pages (popup/grabber) aren't tied to a tab that way, so they pass it
    // explicitly instead. Without this fallback, every content-script-driven
    // clear (including the SPA-navigation auto-clear below) silently no-oped.
    const tabId = message.tabId || sender.tab?.id;
    if (tabId && tabMediaStore[tabId]) {
      tabMediaStore[tabId] = { streams: [], title: '', url: '' };
    }
    updateTabBadge(tabId);
    sendResponse({ ok: true });
    return true;
  }

  // Fetch missing size. Credentials must match what the actual download sends
  // (offscreen/muxer.js uses credentials: 'include'), otherwise authenticated
  // media 403s here and the card shows no size for a file that downloads fine.
  if (message.type === 'FETCH_SIZE' && message.url) {
    probeSize(message.url)
      .then(size => sendResponse({ ok: size > 0, size }))
      .catch(() => sendResponse({ ok: false, size: 0 }));
    return true;
  }

  // NOTE: FETCH_BLOB_ARRAY was removed. It returned file bytes as
  // Array.from(new Uint8Array(buf)) — a ten-million-element JS number array for
  // a 10MB file — then serialized that across chrome.runtime, which caps around
  // 32MB and amplified memory roughly 8-20x. Bulk ZIP now runs entirely inside
  // the offscreen document; see BUILD_ZIP above.

  // Persistent Download State Helpers (Powered by IndexedDB)
  async function updateDownloadHistory(entry) {
    try {
      if (typeof DownloadDB !== 'undefined' && DownloadDB.saveDownload) {
        await DownloadDB.saveDownload(entry);
      }
      // Keep a small 30-item buffer in storage.local for quick fallback
      const res = await chrome.storage.local.get(['downloadHistory']);
      let history = Array.isArray(res.downloadHistory) ? res.downloadHistory : [];
      history = history.filter(h => h.id !== entry.id && (!entry.downloadId || h.downloadId !== entry.downloadId));
      history.unshift(entry);
      if (history.length > 30) history = history.slice(0, 30);
      await chrome.storage.local.set({ downloadHistory: history });

      chrome.runtime.sendMessage({ type: 'DOWNLOAD_HISTORY_UPDATED', history, item: entry }).catch(() => {});
    } catch (e) {
      console.error('Error updating download history:', e);
    }
  }

  async function updateActiveDownload(id, data) {
    try {
      const res = await chrome.storage.local.get(['activeDownloads']);
      const active = res.activeDownloads || {};
      if (data) {
        active[id] = { id, ...data, updatedAt: Date.now() };
      } else {
        delete active[id];
      }
      await chrome.storage.local.set({ activeDownloads: active });
      chrome.runtime.sendMessage({ type: 'ACTIVE_DOWNLOADS_UPDATED', active }).catch(() => {});
    } catch (_) {}
  }

  // A mux/parallel-download/zip job that failed before ever reaching chrome.downloads
  // (bad playlist, network error, cancel). Record it so it still shows up in history.
  if (message.type === 'MUX_FAILED') {
    updateDownloadHistory({
      id: message.id,
      filename: message.filename || 'media_file',
      completedAt: Date.now(),
      state: 'interrupted',
      error: message.error || 'Download failed',
      type: message.jobType || 'hls'
    });
    return false;
  }

  // Offscreen finished assembling -> SW saves the blob URL (offscreen lacks chrome.downloads).
  if (message.type === 'OFFSCREEN_DOWNLOAD') {
    withDownloadFolder(message.filename).then((targetFilename) => {
    chrome.downloads.download({ url: message.url, filename: targetFilename, saveAs: false }, async (downloadId) => {
      if (chrome.runtime.lastError) {
        // Release the offscreen scratch file even on failure.
        chrome.runtime.sendMessage({ type: 'DOWNLOAD_SAVED', id: message.id }).catch(() => {});
        chrome.runtime.sendMessage({ type: 'MUX_DONE', id: message.id, error: chrome.runtime.lastError.message }).catch(() => {});
        await updateActiveDownload(message.id, null);
        await updateDownloadHistory({
          id: message.id,
          filename: message.filename || 'media_file',
          completedAt: Date.now(),
          state: 'interrupted',
          error: chrome.runtime.lastError.message,
          type: message.container || 'hls'
        });
        return;
      }

      await updateActiveDownload(message.id, {
        downloadId,
        filename: message.filename,
        state: 'saving',
        percent: 100,
        type: message.container || 'hls',
        startTime: Date.now()
      });

      // Track download completion to update badge & notify user. History
      // persistence for this download is NOT done here — the module-level
      // chrome.downloads.onChanged listener below already records every real
      // chrome.downloads item generically (keyed by 'dl_' + downloadId), and
      // writing it again here under message.id produced a duplicate row for
      // every single HLS/mux download in the Completed list.
      const onChangedListener = async (delta) => {
        if (delta.id !== downloadId || !delta.state) return;
        const state = delta.state.current;
        if (state !== 'complete' && state !== 'interrupted') return;

        chrome.downloads.onChanged.removeListener(onChangedListener);

        // Only now is it safe to revoke the object URL and delete the scratch
        // file. Revoking on a fixed timer could fire mid-write on a slow disk.
        chrome.runtime.sendMessage({ type: 'DOWNLOAD_SAVED', id: message.id }).catch(() => {});
        await updateActiveDownload(message.id, null);

        if (state === 'complete') {
          chrome.action.setBadgeText({ text: '✓' });
          chrome.action.setBadgeBackgroundColor({ color: '#10b981' });
          setTimeout(() => {
            const activeTabId = sender.tab?.id;
            if (activeTabId) updateTabBadge(activeTabId);
            else chrome.action.setBadgeText({ text: '' });
          }, 4000);
        } else {
          chrome.runtime.sendMessage({ type: 'MUX_DONE', id: message.id, error: 'Download interrupted' }).catch(() => {});
        }
      };
      chrome.downloads.onChanged.addListener(onChangedListener);

      chrome.runtime.sendMessage({
        type: 'MUX_DONE',
        id: message.id,
        file: message.filename,
        segments: message.segments,
        container: message.container,
        downloadId
      }).catch(() => {});
    });
    });
    return false;
  }

  // Bulk ZIP: hand the list to the offscreen document, which fetches and packs
  // the bytes itself. Nothing binary crosses a message, and the blob is created
  // in a document that outlives the popup.
  if (message.type === 'BUILD_ZIP') {
    ensureOffscreen()
      .then(() => chrome.runtime.sendMessage({
        type: 'DO_ZIP',
        id: message.id,
        items: message.items,
        filename: message.filename
      }))
      .catch((err) => chrome.runtime.sendMessage({ type: 'MUX_DONE', id: message.id, error: err.message }));
    sendResponse({ ok: true });
    return true;
  }

  // Client-side HLS mux: hand the .m3u8 to the offscreen document.
  if (message.type === 'MUX_HLS') {
    ensureOffscreen()
      .then(() => chrome.runtime.sendMessage({
        type: 'DO_MUX',
        id: message.id,
        url: message.url,
        filename: message.filename || 'video.mp4',
        preferredQuality: message.preferredQuality
      }))
      .catch((err) => chrome.runtime.sendMessage({ type: 'MUX_DONE', id: message.id, error: err.message }));
    sendResponse({ ok: true });
    return true;
  }

  // Cancel active HLS or parallel download job
  if (message.type === 'CANCEL_MUX' || message.type === 'CANCEL_DOWNLOAD') {
    ensureOffscreen()
      .then(() => chrome.runtime.sendMessage(message))
      .catch(() => {});
    sendResponse({ ok: true });
    return true;
  }

  // Client-side parallel download: hand the URL to the offscreen document.
  if (message.type === 'DOWNLOAD_PARALLEL') {
    ensureOffscreen()
      .then(() => chrome.runtime.sendMessage({ type: 'DO_PARALLEL', id: message.id, url: message.url, filename: message.filename }))
      .catch((err) => chrome.runtime.sendMessage({ type: 'MUX_DONE', id: message.id, error: err.message }));
    sendResponse({ ok: true });
    return true;
  }

  // Prepare headers for direct extension preview playback (e.g. YouTube googlevideo, Instagram CDN)
  if (message.type === 'PREPARE_PREVIEW') {
    const targetUrl = message.url || '';
    let host = '';
    try { host = new URL(targetUrl).hostname; } catch (_) {}
    if (host) {
      const isYt = host.includes('googlevideo.com') || host.includes('youtube.com');
      const isInsta = host.includes('cdninstagram.com') || host.includes('fbcdn.net');
      const referer = isYt ? 'https://www.youtube.com/' : isInsta ? 'https://www.instagram.com/' : (message.pageUrl || `https://${host}/`);
      const origin = isYt ? 'https://www.youtube.com' : isInsta ? 'https://www.instagram.com' : ('https://' + host);

      const ruleId = 8888;
      chrome.declarativeNetRequest.updateDynamicRules({
        removeRuleIds: [ruleId],
        addRules: [{
          id: ruleId,
          priority: 99,
          action: {
            type: 'modifyHeaders',
            requestHeaders: [
              { header: 'Referer', operation: 'set', value: referer },
              { header: 'Origin', operation: 'set', value: origin }
            ]
          },
          condition: {
            urlFilter: `||${host}`,
            resourceTypes: ['media', 'xmlhttprequest', 'other']
          }
        }]
      }).then(() => sendResponse({ ok: true })).catch(() => sendResponse({ ok: false }));
      return true;
    }
    sendResponse({ ok: true });
    return true;
  }

  // Full page scan: DOM resources (all frames) + sniffed network streams, merged.
  if (message.type === 'SCAN_TAB') {
    const tabId = message.tabId;
    if (message.reset && tabMediaStore[tabId]) {
      tabMediaStore[tabId].streams = [];
    }
    chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      func: collectPageResources,
    }).then((results) => {
      const domItems = [];
      for (const r of results || []) if (r && r.result) domItems.push(...r.result);
      const sniffed = (tabMediaStore[tabId] && tabMediaStore[tabId].streams) || [];
      const seen = new Set();
      const items = [];
      for (const it of [...sniffed, ...domItems]) {
        if (!it.url || seen.has(it.url)) continue;
        seen.add(it.url);
        items.push(it);
      }
      sendResponse({ ok: true, items, title: (tabMediaStore[tabId] && tabMediaStore[tabId].title) || '' });
    }).catch((err) => sendResponse({ ok: false, error: err.message }));
    return true;
  }

  // Message from content script (page data)
  if (message.type === 'FROM_PAGE') {
    const tabId = sender.tab?.id;
    if (!tabId) { sendResponse({ ok: false, reason: 'no tabId' }); return true; }

    if (!tabMediaStore[tabId]) {
      tabMediaStore[tabId] = { streams: [], title: '', url: '' };
    }

    const payload = message.data?.payload;
    if (!payload) { sendResponse({ ok: false, reason: 'no payload' }); return true; }

    tabMediaStore[tabId].title = payload.title || tabMediaStore[tabId].title;
    tabMediaStore[tabId].url = payload.url || tabMediaStore[tabId].url;

    const existingMap = new Map(tabMediaStore[tabId].streams.map(s => [s.url, s]));
    let addedCount = 0;

    for (const rawStream of (payload.streams || [])) {
      if (!rawStream.url) continue;
      rawStream.url = normalizeSniffedUrl(rawStream.url);
      const c = classifyResource(rawStream.url, rawStream.mimeType || rawStream.codec || '');
      const normalized = {
        ...rawStream,
        type: rawStream.type || (c ? c.type : (rawStream.isVideo ? 'video' : rawStream.isAudio ? 'audio' : 'file')),
        kind: rawStream.kind || (c ? c.kind : (/\.m3u8/i.test(rawStream.url) ? 'hls' : /\.mpd/i.test(rawStream.url) ? 'dash' : 'file')),
        isVideo: rawStream.isVideo !== undefined ? rawStream.isVideo : (c ? c.type === 'video' : true),
        isAudio: rawStream.isAudio !== undefined ? rawStream.isAudio : (c ? c.type === 'audio' : false),
      };

      if (existingMap.has(rawStream.url)) {
        const existing = existingMap.get(rawStream.url);
        if (!existing.kind || existing.kind === 'file') existing.kind = normalized.kind;
        if (!existing.type) existing.type = normalized.type;
        if (!existing.quality && normalized.quality) existing.quality = normalized.quality;
        if (!existing.size && normalized.size) existing.size = normalized.size;
      } else {
        tabMediaStore[tabId].streams.push(normalized);
        existingMap.set(rawStream.url, normalized);
        addedCount++;
      }
    }

    updateTabBadge(tabId);

    // Notify any open DevTools panel for this tab (fire-and-forget)
    chrome.runtime.sendMessage({
      type: 'MEDIA_UPDATE',
      tabId,
      data: tabMediaStore[tabId]
    }).catch(() => {});

    sendResponse({ ok: true, added: addedCount });
    return true;
  }

  // DevTools panel requesting stored data
  if (message.type === 'GET_MEDIA') {
    sendResponse(tabMediaStore[message.tabId] || { streams: [], title: '', url: '' });
    return true;
  }

  // DevTools panel requesting re-extraction via scripting API
  if (message.type === 'INJECT_EXTRACTOR') {
    const tabId = message.tabId;
    tabMediaStore[tabId] = { streams: [], title: '', url: '' };

    // Inline the extractor as a function — avoids the files+world:MAIN issue
    chrome.scripting.executeScript({
      target: { tabId },
      world: 'MAIN',
      func: function () {
        let playerResponse =
          window.ytInitialPlayerResponse ||
          window.__ytInitialPlayerResponse ||
          (window.yt && window.yt.config_ && window.yt.config_.PLAYER_VARS && window.yt.config_.PLAYER_VARS.ytInitialPlayerResponse) ||
          null;

        if (!playerResponse && window.ytplayer && window.ytplayer.config && window.ytplayer.config.args) {
          const args = window.ytplayer.config.args;
          const raw = args.raw_player_response || args.player_response;
          if (typeof raw === 'string') {
            try { playerResponse = JSON.parse(raw); } catch (_) {}
          } else if (typeof raw === 'object') {
            playerResponse = raw;
          }
        }

        if (!playerResponse) {
          const scripts = document.querySelectorAll('script');
          for (const s of scripts) {
            const text = s.textContent || '';
            const idx = text.indexOf('ytInitialPlayerResponse');
            if (idx !== -1) {
              const startIdx = text.indexOf('{', idx);
              if (startIdx !== -1) {
                let braceCount = 0;
                let endIdx = -1;
                for (let i = startIdx; i < text.length; i++) {
                  if (text[i] === '{') braceCount++;
                  else if (text[i] === '}') {
                    braceCount--;
                    if (braceCount === 0) {
                      endIdx = i;
                      break;
                    }
                  }
                }
                if (endIdx !== -1) {
                  try {
                    playerResponse = JSON.parse(text.substring(startIdx, endIdx + 1));
                    break;
                  } catch (_) {}
                }
              }
            }
          }
        }

        const streams = [];

        if (playerResponse && playerResponse.streamingData) {
          const videoDetails = playerResponse.videoDetails || {};
          const title = videoDetails.title || document.title;
          const allFormats = [
            ...(playerResponse.streamingData.formats || []),
            ...(playerResponse.streamingData.adaptiveFormats || [])
          ];

          for (const fmt of allFormats) {
            const url = fmt.url;
            if (!url) continue;

            const mimeType = fmt.mimeType || '';
            const isVideo = mimeType.startsWith('video/');
            const isAudio = mimeType.startsWith('audio/');
            if (!isVideo && !isAudio) continue;

            const height = fmt.height || 0;
            const quality = fmt.qualityLabel || (height ? height + 'p' : fmt.audioQuality || 'audio');
            const codec = mimeType.split(';')[0];
            const bitrate = fmt.bitrate || 0;
            const isMuxed = isVideo && (fmt.audioChannels > 0 || fmt.audioQuality);

            streams.push({ url, quality, codec, mimeType: codec, width: fmt.width || 0, height, bitrate, isVideo, isAudio, isMuxed });
          }

          streams.sort((a, b) => {
            if (a.isMuxed && !b.isMuxed) return -1;
            if (!a.isMuxed && b.isMuxed) return 1;
            if (a.isVideo && b.isVideo) return b.height - a.height;
            if (a.isAudio && b.isAudio) return b.bitrate - a.bitrate;
            return a.isVideo ? -1 : 1;
          });

          window.postMessage({ source: 'media-extractor-pro', type: 'YT_STREAMS', payload: { title, streams, url: window.location.href } }, '*');
          return { found: streams.length, source: 'ytInitialPlayerResponse' };
        }

        // Fallback: scan DOM for generic media
        const domStreams = [];
        const seen = new Set();
        document.querySelectorAll('video source, video[src], audio source, audio[src]').forEach(el => {
          const src = el.src || el.getAttribute('src');
          if (src && !seen.has(src)) {
            seen.add(src);
            const tag = el.closest('video') ? 'video' : 'audio';
            domStreams.push({ url: src, quality: el.getAttribute('label') || tag, codec: el.type || '', mimeType: el.type || '', width: 0, height: 0, bitrate: 0, isVideo: tag === 'video', isAudio: tag === 'audio', isMuxed: tag === 'video' });
          }
        });

        if (domStreams.length > 0) {
          window.postMessage({ source: 'media-extractor-pro', type: 'DOM_MEDIA', payload: { title: document.title, streams: domStreams, url: window.location.href } }, '*');
          return { found: domStreams.length, source: 'DOM' };
        }

        return { found: 0, source: 'none' };
      }
    }).then((results) => {
      const result = results?.[0]?.result;
      sendResponse({ ok: true, result });
    }).catch(err => {
      sendResponse({ ok: false, error: err.message });
    });

    return true;
  }

  // Cookies
  if (message.type === 'GET_COOKIES' && message.url) {
    try {
      const urlObj = new URL(message.url);
      chrome.cookies.getAll({ domain: urlObj.hostname }).then(cookies => {
        sendResponse({ type: 'COOKIES_RESULT', cookies });
      });
    } catch (err) {
      sendResponse({ type: 'COOKIES_ERROR', error: err.message });
    }
    return true;
  }

  // Download a stream URL using chrome.downloads (sends real browser cookies + referer)
  if (message.type === 'DOWNLOAD_STREAM') {
    const { url, filename, pageUrl, mimeType } = message;

    // Safety Interceptor: If this is an HLS playlist (.m3u8), route to MUX_HLS instead of downloading a 2KB text file!
    const classification = classifyResource(url, mimeType || '');
    const isHls = (classification && classification.kind === 'hls') ||
                  /(\.m3u8|\/hls\/|\/master|\/manifest|format=hls|format=m3u8)/i.test(url) ||
                  (mimeType && /mpegurl/i.test(mimeType));

    if (isHls) {
      const id = 'mux_' + Math.random().toString(36).slice(2);
      let safeName = (filename || 'video').replace(/\.(m3u8|mpd|txt|htm|html|php|aspx|cgi)$/i, '');
      if (!/\.[a-z0-9]{2,5}$/i.test(safeName)) safeName += '.mp4';

      ensureOffscreen()
        .then(() => chrome.runtime.sendMessage({
          type: 'DO_MUX',
          id,
          url,
          filename: safeName,
          preferredQuality: message.preferredQuality
        }))
        .catch((err) => chrome.runtime.sendMessage({ type: 'MUX_DONE', id, error: err.message }));
      sendResponse({ ok: true, isHls: true, id });
      return true;
    }

    // Ensure direct files have a safe filename with an extension
    let safeDirectName = (filename || 'media').trim();
    if (!/\.[a-z0-9]{2,5}$/i.test(safeDirectName)) {
      const isAud = (classification && classification.type === 'audio') || (mimeType && mimeType.startsWith('audio/'));
      const isImg = (classification && classification.type === 'image') || (mimeType && mimeType.startsWith('image/'));
      const isDoc = (classification && classification.type === 'doc') || (mimeType && mimeType.includes('pdf'));
      safeDirectName += isAud ? '.mp3' : isImg ? '.jpg' : isDoc ? '.pdf' : '.mp4';
    }

    // Derive Referer/Origin from the page the media was found on
    const { referer, origin } = deriveReferer(pageUrl, url);

    // Register a temporary declarativeNetRequest rule to inject Referer & Origin headers
    const ruleId = nextHeaderRuleId();
    let urlHost = '';
    try {
      urlHost = new URL(url).hostname;
    } catch (_) {}

    if (urlHost) {
      const isInsta = urlHost.includes('cdninstagram.com') || urlHost.includes('fbcdn.net') || (pageUrl && pageUrl.includes('instagram.com'));
      const isYt = urlHost.includes('googlevideo.com') || urlHost.includes('youtube.com') || (pageUrl && pageUrl.includes('youtube.com'));

      const effectiveReferer = isInsta ? 'https://www.instagram.com/' : isYt ? 'https://www.youtube.com/' : (referer || `https://${urlHost}/`);
      const effectiveOrigin = isInsta ? 'https://www.instagram.com' : isYt ? 'https://www.youtube.com' : (origin || `https://${urlHost}`);

      const requestDomains = [urlHost];
      if (isInsta) {
        requestDomains.push('cdninstagram.com', 'fbcdn.net', 'instagram.com');
      }
      if (isYt) {
        requestDomains.push('googlevideo.com', 'youtube.com');
      }

      const rule = {
        id: ruleId,
        priority: 99,
        action: {
          type: 'modifyHeaders',
          requestHeaders: [
            { header: 'Referer', operation: 'set', value: effectiveReferer },
            { header: 'Origin', operation: 'set', value: effectiveOrigin },
            { header: 'Sec-Fetch-Site', operation: 'set', value: 'same-origin' },
            { header: 'Sec-Fetch-Mode', operation: 'set', value: 'no-cors' }
          ]
        },
        condition: {
          requestDomains,
          resourceTypes: ['main_frame', 'sub_frame', 'xmlhttprequest', 'media', 'other']
        }
      };

      chrome.declarativeNetRequest.updateDynamicRules({
        addRules: [rule],
        removeRuleIds: [ruleId]
      }).then(() => {
        triggerDownload();
      }).catch(err => {
        console.error('Failed to set headers rule:', err);
        triggerDownload();
      });
    } else {
      triggerDownload();
    }

    function scheduleRuleCleanup() {
      if (urlHost) {
        setTimeout(() => {
          chrome.declarativeNetRequest.updateDynamicRules({
            removeRuleIds: [ruleId]
          }).catch(() => {});
        }, 15000);
      }
    }

    function triggerDownload() {
      withDownloadFolder(safeDirectName || 'media.mp4').then((targetFilename) => {
        chrome.downloads.download({
          url,
          filename: targetFilename,
          saveAs: false
        }, (downloadId) => {
          scheduleRuleCleanup();

          if (chrome.runtime.lastError) {
            sendResponse({ ok: false, error: chrome.runtime.lastError.message });
          } else {
            sendResponse({ ok: true, downloadId });
          }
        });
      });
    }

    return true;
  }

  // Open URL in new tab (DevTools panel doesn't have direct chrome.tabs access)
  if (message.type === 'OPEN_TAB') {
    const { url, pageUrl } = message;

    const { referer, origin } = deriveReferer(pageUrl, url);

    const ruleId = nextHeaderRuleId();
    let urlHost = '';
    try {
      urlHost = new URL(url).hostname;
    } catch (_) {}

    if (urlHost && referer) {
      const rule = {
        id: ruleId,
        priority: 1,
        action: {
          type: 'modifyHeaders',
          requestHeaders: [
            { header: 'Referer', operation: 'set', value: referer },
            { header: 'Origin', operation: 'set', value: origin }
          ]
        },
        condition: {
          requestDomains: [urlHost],
          resourceTypes: ['xmlhttprequest', 'other', 'main_frame', 'sub_frame']
        }
      };

      chrome.declarativeNetRequest.updateDynamicRules({
        addRules: [rule],
        removeRuleIds: [ruleId]
      }).then(() => {
        triggerOpen();
      }).catch(err => {
        console.error('Failed to set headers rule for open tab:', err);
        triggerOpen();
      });
    } else {
      triggerOpen();
    }

    function triggerOpen() {
      chrome.tabs.create({ url, active: true }, (tab) => {
        // Schedule rule cleanup
        if (urlHost) {
          setTimeout(() => {
            chrome.declarativeNetRequest.updateDynamicRules({
              removeRuleIds: [ruleId]
            }).catch(() => {});
          }, 15000);
        }

        if (chrome.runtime.lastError) {
          sendResponse({ ok: false, error: chrome.runtime.lastError.message });
        } else {
          sendResponse({ ok: true, tabId: tab?.id });
        }
      });
    }

    return true;
  }

  // ── Redirect Blocker: intent recording from content/redirect-blocker.js ──

  if (message.type === 'NAV_INTENT') {
    const tabId = sender.tab?.id;
    if (tabId) recordNavIntent(tabId, message);
    return false;
  }

  if (message.type === 'CLAIM_REDIRECT_VERDICT') {
    const tabId = sender.tab?.id;
    const pending = tabId != null ? pendingVerdicts.get(tabId) : null;
    if (pending) pendingVerdicts.delete(tabId);
    sendResponse(pending ? { pending: true, ...pending } : { pending: false });
    return true;
  }

  if (message.type === 'REDIRECT_ALLOW_ONCE' && message.url) {
    allowOnce.add(message.url);
    setTimeout(() => allowOnce.delete(message.url), 30000);
    const tabId = sender.tab?.id;
    if (tabId) chrome.tabs.update(tabId, { url: message.url }).catch(() => {});
    sendResponse({ ok: true });
    return true;
  }

  if (message.type === 'REDIRECT_TRUST_SITE' && message.domain) {
    const domain = normalizeDomain(message.domain);
    chrome.storage.local.get(['redirectBlockerDisabledDomains'], (res) => {
      const list = Array.isArray(res.redirectBlockerDisabledDomains)
        ? [...res.redirectBlockerDisabledDomains] : [];
      if (domain && !list.some(d => normalizeDomain(d) === domain)) list.push(domain);
      chrome.storage.local.set({ redirectBlockerDisabledDomains: list }, () => sendResponse({ ok: true }));
    });
    return true;
  }

  if (message.type === 'REDIRECT_BLOCKED') {
    const tabId = sender.tab?.id;
    countBlock(tabId);
    sendResponse({ ok: true });
    return false;
  }

  if (message.type === 'GET_REDIRECT_STATS') {
    chrome.storage.local.get(['redirectBlockedCount', 'redirectBlockerEnabled', 'redirectBlockerDisabledDomains'], (res) => {
      sendResponse({
        blockedCount: res.redirectBlockedCount || 0,
        enabled: typeof res.redirectBlockerEnabled === 'boolean' ? res.redirectBlockerEnabled : true,
        disabledDomains: res.redirectBlockerDisabledDomains || []
      });
    });
    return true;
  }

  if (message.type === 'SET_REDIRECT_SETTINGS') {
    const update = {};
    if (typeof message.enabled === 'boolean') update.redirectBlockerEnabled = message.enabled;
    if (Array.isArray(message.disabledDomains)) update.redirectBlockerDisabledDomains = message.disabledDomains;
    chrome.storage.local.set(update, () => sendResponse({ ok: true }));
    return true;
  }

  if (message.type === 'RESET_REDIRECT_STATS') {
    chrome.storage.local.set({ redirectBlockedCount: 0 }, () => sendResponse({ ok: true }));
    return true;
  }

  // ── Downloads Manager Message Handlers ──
  if (message.type === 'GET_DOWNLOADS') {
    (async () => {
      try {
        const filter = message.filter || 'today';
        const date = message.date || '';
        const query = message.query || '';
        const limit = message.limit || 200;
        const offset = message.offset || 0;

        let dbResult = { items: [], stats: { totalCount: 0, totalBytes: 0, successCount: 0, errorCount: 0 } };
        if (typeof DownloadDB !== 'undefined' && DownloadDB.queryDownloads) {
          dbResult = await DownloadDB.queryDownloads({ filter, date, query, limit, offset });
        } else {
          const res = await chrome.storage.local.get(['downloadHistory']);
          dbResult.items = res.downloadHistory || [];
          dbResult.stats.totalCount = dbResult.items.length;
        }

        const res = await chrome.storage.local.get(['activeDownloads', 'activeDownloadJobs']);
        const activeDl = res.activeDownloads || {};
        const activeJobs = res.activeDownloadJobs || {};
        const mergedActive = { ...activeDl };

        for (const [k, v] of Object.entries(activeJobs)) {
          if (v && !mergedActive[k]) {
            mergedActive[k] = {
              id: k,
              filename: v.filename || 'Streaming Media',
              percent: v.percent || 0,
              status: v.status || '',
              speedMBs: v.speedMBs || 0,
              etaSeconds: v.etaSeconds || 0,
              type: k.startsWith('zip_') ? 'zip' : 'hls',
              startTime: v.updatedAt || Date.now()
            };
          }
        }

        sendResponse({
          ok: true,
          active: Object.values(mergedActive),
          history: dbResult.items || [],
          stats: dbResult.stats || { totalCount: 0, totalBytes: 0 }
        });
      } catch (err) {
        console.error('Error in GET_DOWNLOADS:', err);
        sendResponse({ ok: false, active: [], history: [], error: err.message });
      }
    })();
    return true;
  }

  if (message.type === 'CANCEL_DOWNLOAD_JOB') {
    const { id, downloadId } = message;
    if (downloadId) {
      chrome.downloads.cancel(downloadId, () => {
        void chrome.runtime.lastError;
      });
    }
    if (id) {
      updateActiveDownload(id, null);
      if (id.startsWith('mux_') || id.startsWith('zip_') || id.startsWith('dl_')) {
        ensureOffscreen()
          .then(() => chrome.runtime.sendMessage({ type: 'CANCEL_MUX', id }))
          .catch(() => {});
      }
    }
    sendResponse({ ok: true });
    return true;
  }

  if (message.type === 'SHOW_DOWNLOAD_ITEM') {
    if (message.downloadId) {
      try {
        chrome.downloads.show(message.downloadId);
        sendResponse({ ok: true });
      } catch (e) {
        sendResponse({ ok: false, error: e.message });
      }
    } else {
      sendResponse({ ok: false });
    }
    return true;
  }

  if (message.type === 'OPEN_DOWNLOAD_ITEM') {
    if (message.downloadId) {
      try {
        chrome.downloads.open(message.downloadId);
        sendResponse({ ok: true });
      } catch (e) {
        sendResponse({ ok: false, error: e.message });
      }
    } else {
      sendResponse({ ok: false });
    }
    return true;
  }

  if (message.type === 'CLEAR_DOWNLOAD_HISTORY') {
    (async () => {
      try {
        if (typeof DownloadDB !== 'undefined' && DownloadDB.clearAll) {
          await DownloadDB.clearAll();
        }
        await chrome.storage.local.set({ downloadHistory: [] });
        sendResponse({ ok: true });
      } catch (e) {
        sendResponse({ ok: false, error: e.message });
      }
    })();
    return true;
  }

  if (message.type === 'ERASE_DOWNLOAD_ITEM') {
    const { id, downloadId } = message;
    (async () => {
      try {
        if (typeof DownloadDB !== 'undefined' && DownloadDB.eraseDownload) {
          await DownloadDB.eraseDownload(id, downloadId);
        }
        const res = await chrome.storage.local.get(['downloadHistory']);
        let history = res.downloadHistory || [];
        history = history.filter(h => h.id !== id && (!downloadId || h.downloadId !== downloadId));
        await chrome.storage.local.set({ downloadHistory: history });

        if (downloadId) {
          chrome.downloads.erase({ id: downloadId }, () => {
            void chrome.runtime.lastError;
            sendResponse({ ok: true });
          });
        } else {
          sendResponse({ ok: true });
        }
      } catch (e) {
        sendResponse({ ok: false, error: e.message });
      }
    })();
    return true;
  }

  if (message.type === 'EXPORT_DOWNLOADS_FOR_CLOUD') {
    (async () => {
      try {
        const records = typeof DownloadDB !== 'undefined' && DownloadDB.exportAllForCloud
          ? await DownloadDB.exportAllForCloud()
          : [];
        sendResponse({ ok: true, records, count: records.length });
      } catch (e) {
        sendResponse({ ok: false, error: e.message });
      }
    })();
    return true;
  }
});

// ── Global Browser-Wide chrome.downloads Listeners ──
chrome.downloads.onCreated.addListener((downloadItem) => {
  if (!downloadItem || !downloadItem.id) return;
  const id = 'dl_' + downloadItem.id;
  const rawName = downloadItem.filename ? downloadItem.filename.split(/[\\/]/).pop() : (downloadItem.url ? downloadItem.url.split('/').pop().split('?')[0] : 'download');
  const type = EXT_VIDEO.test(rawName) ? 'video' : EXT_AUDIO.test(rawName) ? 'audio' : EXT_DOC.test(rawName) ? 'doc' : 'file';

  updateActiveDownload(id, {
    id,
    downloadId: downloadItem.id,
    filename: rawName || 'Downloading media…',
    savePath: downloadItem.filename || '',
    url: downloadItem.url || '',
    referrer: downloadItem.referrer || '',
    mime: downloadItem.mime || '',
    totalBytes: downloadItem.totalBytes > 0 ? downloadItem.totalBytes : 0,
    bytesReceived: downloadItem.bytesReceived || 0,
    percent: downloadItem.totalBytes > 0 ? Math.round((downloadItem.bytesReceived / downloadItem.totalBytes) * 100) : 0,
    state: downloadItem.state || 'in_progress',
    startTime: downloadItem.startTime ? new Date(downloadItem.startTime).getTime() : Date.now(),
    lastCheck: Date.now(),
    lastBytes: downloadItem.bytesReceived || 0,
    speedMBs: 0,
    etaSeconds: 0,
    type
  });
});

chrome.downloads.onChanged.addListener((delta) => {
  if (!delta || !delta.id) return;
  const id = 'dl_' + delta.id;
  chrome.storage.local.get(['activeDownloads'], async (res) => {
    const active = res.activeDownloads || {};
    const item = active[id] || {
      id,
      downloadId: delta.id,
      startTime: Date.now(),
      type: 'direct',
      lastCheck: Date.now(),
      lastBytes: 0
    };

    if (delta.filename) {
      item.savePath = delta.filename.current;
      item.filename = delta.filename.current.split(/[\\/]/).pop();
    }
    if (delta.totalBytes) item.totalBytes = delta.totalBytes.current;
    if (delta.bytesReceived) {
      const now = Date.now();
      const bytesNow = delta.bytesReceived.current;
      const timeDiff = (now - (item.lastCheck || now)) / 1000;
      if (timeDiff >= 0.5) {
        const bytesDiff = bytesNow - (item.lastBytes || 0);
        const speedBps = bytesDiff / timeDiff;
        item.speedMBs = Math.max(0, +(speedBps / (1024 * 1024)).toFixed(2));
        const total = item.totalBytes || (delta.totalBytes ? delta.totalBytes.current : 0);
        if (total > bytesNow && speedBps > 0) {
          item.etaSeconds = Math.round((total - bytesNow) / speedBps);
        }
        item.lastBytes = bytesNow;
        item.lastCheck = now;
      }
      item.bytesReceived = bytesNow;
    }
    if (item.totalBytes > 0 && item.bytesReceived !== undefined) {
      item.percent = Math.min(100, Math.round((item.bytesReceived / item.totalBytes) * 100));
    }
    if (delta.state) item.state = delta.state.current;

    if (delta.state && (delta.state.current === 'complete' || delta.state.current === 'interrupted')) {
      await updateActiveDownload(id, null);

      if (delta.state.current === 'complete') {
        chrome.downloads.search({ id: delta.id }, async (items) => {
          const fullItem = (items && items[0]) || {};
          const finalSavePath = fullItem.filename || item.savePath || '';
          const finalFilename = finalSavePath ? finalSavePath.split(/[\\/]/).pop() : (item.filename || 'Downloaded File');
          const finalTotalBytes = fullItem.fileSize || fullItem.totalBytes || item.totalBytes || item.bytesReceived || 0;
          const finalUrl = fullItem.url || item.url || '';
          const finalMime = fullItem.mime || item.mime || '';
          const finalStartTime = fullItem.startTime ? new Date(fullItem.startTime).getTime() : (item.startTime || Date.now());

          await updateDownloadHistory({
            id,
            downloadId: delta.id,
            filename: finalFilename,
            savePath: finalSavePath,
            url: finalUrl,
            mime: finalMime,
            totalBytes: finalTotalBytes,
            startTime: finalStartTime,
            completedAt: Date.now(),
            state: 'complete',
            type: item.type || 'direct'
          });

          chrome.action.setBadgeText({ text: '✓' });
          chrome.action.setBadgeBackgroundColor({ color: '#10b981' });
          setTimeout(() => {
            chrome.action.setBadgeText({ text: '' });
          }, 4000);
        });
      } else {
        await updateDownloadHistory({
          id,
          downloadId: delta.id,
          filename: item.filename || 'Downloaded File',
          savePath: item.savePath || '',
          url: item.url || '',
          totalBytes: item.totalBytes || item.bytesReceived || 0,
          completedAt: Date.now(),
          state: 'interrupted',
          error: delta.error ? delta.error.current : 'Download interrupted',
          type: item.type || 'direct'
        });
      }
    } else {
      await updateActiveDownload(id, item);
    }
  });
});

chrome.downloads.onErased.addListener((downloadId) => {
  updateActiveDownload('dl_' + downloadId, null);
});

// Startup initialization: sync DB and active in-progress downloads
async function initDownloadTracking() {
  try {
    if (typeof DownloadDB !== 'undefined' && DownloadDB.init) {
      await DownloadDB.init();

      // Check if DB is empty, backfill recent completed downloads from Chrome
      const existing = await DownloadDB.queryDownloads({ filter: 'all', limit: 1 });
      if (existing.stats && existing.stats.totalCount === 0) {
        chrome.downloads.search({ state: 'complete', limit: 100 }, async (items) => {
          if (Array.isArray(items)) {
            for (const it of items) {
              const filename = it.filename ? it.filename.split(/[\\/]/).pop() : 'download';
              const completedAt = it.endTime ? new Date(it.endTime).getTime() : (it.startTime ? new Date(it.startTime).getTime() : Date.now());
              const type = EXT_VIDEO.test(filename) ? 'video' : EXT_AUDIO.test(filename) ? 'audio' : EXT_DOC.test(filename) ? 'doc' : 'file';
              await DownloadDB.saveDownload({
                id: `dl_${it.id}`,
                downloadId: it.id,
                filename,
                savePath: it.filename || '',
                url: it.url || '',
                mime: it.mime || '',
                totalBytes: it.fileSize || it.totalBytes || 0,
                startTime: it.startTime ? new Date(it.startTime).getTime() : completedAt,
                completedAt,
                state: 'complete',
                type
              });
            }
          }
        });
      }
    }

    // Re-sync any active in-progress downloads
    chrome.downloads.search({ state: 'in_progress' }, (items) => {
      if (Array.isArray(items)) {
        chrome.storage.local.get(['activeDownloads'], (res) => {
          const active = res.activeDownloads || {};
          for (const item of items) {
            const id = 'dl_' + item.id;
            const filename = item.filename ? item.filename.split(/[\\/]/).pop() : 'Download';
            active[id] = {
              id,
              downloadId: item.id,
              filename,
              savePath: item.filename || '',
              url: item.url || '',
              totalBytes: item.totalBytes > 0 ? item.totalBytes : 0,
              bytesReceived: item.bytesReceived || 0,
              percent: item.totalBytes > 0 ? Math.round((item.bytesReceived / item.totalBytes) * 100) : 0,
              state: 'in_progress',
              startTime: item.startTime ? new Date(item.startTime).getTime() : Date.now(),
              type: 'direct'
            };
          }
          chrome.storage.local.set({ activeDownloads: active });
        });
      }
    });
  } catch (err) {
    console.error('initDownloadTracking error:', err);
  }
}
initDownloadTracking();

// Keep Service Worker alive while offscreen HLS/parallel download is active
chrome.runtime.onConnect.addListener((port) => {
  if (port.name === 'offscreen-keepalive') {
    port.onMessage.addListener(() => {
      // Acknowledges heartbeat to reset SW inactivity timer
    });
  }
});

chrome.tabs.onRemoved.addListener((tabId) => {
  delete tabMediaStore[tabId];
});

// Auto-reset media store when tab navigates to a new URL
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status === 'loading' || changeInfo.url) {
    if (tabMediaStore[tabId]) {
      tabMediaStore[tabId] = { streams: [], title: tab?.title || '', url: changeInfo.url || tab?.url || '' };
      updateTabBadge(tabId);
    }
  }
});

// Enforce stored Ad Blocker preference and domain allow rules
async function syncAdBlockRuleset() {
  const res = await chrome.storage.local.get(['adBlockEnabled', 'adBlockDisabledDomains']);
  const enabled = typeof res.adBlockEnabled === 'boolean' ? res.adBlockEnabled : true;
  const disabledDomains = Array.isArray(res.adBlockDisabledDomains) ? res.adBlockDisabledDomains : [];

  if (typeof res.adBlockEnabled !== 'boolean') {
    await chrome.storage.local.set({ adBlockEnabled: true });
  }

  await chrome.declarativeNetRequest.updateEnabledRulesets({
    enableRulesetIds: enabled ? ['ad_block_rules'] : [],
    disableRulesetIds: enabled ? [] : ['ad_block_rules']
  }).catch(() => {});

  if (enabled) {
    // Surfaced, not swallowed: a rejected batch means the per-site whitelist is
    // not in effect, and that needs to be visible in the worker console.
    await syncDomainAllowRules(disabledDomains).catch((err) => {
      console.error('[AdBlock] domain allow rules rejected:', err);
    });
  } else {
    // If global adblock is OFF, clear domain allow rules
    const existingRules = await chrome.declarativeNetRequest.getDynamicRules();
    const domainRuleIds = existingRules
      .filter(r => r.id >= RULE_BAND_DOMAIN_ALLOW && r.id < RULE_BAND_HEADERS)
      .map(r => r.id);
    if (domainRuleIds.length) {
      await chrome.declarativeNetRequest.updateDynamicRules({ removeRuleIds: domainRuleIds }).catch(() => {});
    }
  }
}

chrome.runtime.onInstalled.addListener(() => { syncAdBlockRuleset(); });
chrome.runtime.onStartup.addListener(() => { syncAdBlockRuleset(); });
syncAdBlockRuleset();


// ════════════════════════════════════════════════════════════════════════════
// REDIRECT ENGINE — intent vs. outcome
//
// The page records what the HTML said would happen when the user clicked (the
// INTENT). This worker watches chrome.webNavigation for what the browser
// actually did (the OUTCOME). A mismatch is a hijack.
//
// This replaces the old pattern-matching classifier, which asked "does this URL
// look like a redirect?" — a blocklist that fired on any URL carrying a ?q=
// parameter and missed every redirector not already on its list. Asking instead
// "did we land where the page said?" is an invariant: it cannot false-positive
// when the destination matches, and it catches redirectors nobody has seen.
//
// It also has to live here rather than in a content script, because Location's
// members are [LegacyUnforgeable] and cannot be patched from page JS at all.
// ════════════════════════════════════════════════════════════════════════════

const INTENT_TTL_MS = 2000;

const navIntents = new Map();     // tabId -> intent
const pendingVerdicts = new Map(); // tabId -> verdict awaiting a content script
const allowOnce = new Set();       // URLs the user explicitly approved

let redirectEnabled = true;
let redirectTrustedDomains = new Set();

function loadRedirectSettings() {
  chrome.storage.local.get(['redirectBlockerEnabled', 'redirectBlockerDisabledDomains'], (res) => {
    redirectEnabled = typeof res.redirectBlockerEnabled === 'boolean' ? res.redirectBlockerEnabled : true;
    redirectTrustedDomains = new Set(
      (Array.isArray(res.redirectBlockerDisabledDomains) ? res.redirectBlockerDisabledDomains : [])
        .map(normalizeDomain)
        .filter(Boolean)
    );
  });
}
loadRedirectSettings();

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  if (changes.redirectBlockerEnabled || changes.redirectBlockerDisabledDomains) loadRedirectSettings();
});

// ── Registrable domain (eTLD+1) ──
// Taking the last two labels is wrong for multi-part suffixes: it makes
// bbc.co.uk and evil.co.uk look like the same site. This covers the common
// public suffixes; a full Public Suffix List is the eventual upgrade.
const MULTI_PART_SUFFIXES = new Set([
  'co.uk', 'org.uk', 'me.uk', 'ac.uk', 'gov.uk', 'net.uk', 'sch.uk',
  'com.au', 'net.au', 'org.au', 'edu.au', 'gov.au', 'id.au',
  'co.in', 'net.in', 'org.in', 'gen.in', 'firm.in', 'ind.in',
  'co.jp', 'or.jp', 'ne.jp', 'ac.jp', 'go.jp',
  'co.nz', 'net.nz', 'org.nz', 'govt.nz', 'ac.nz',
  'co.za', 'org.za', 'net.za', 'gov.za',
  'com.br', 'net.br', 'org.br', 'gov.br',
  'com.cn', 'net.cn', 'org.cn', 'gov.cn', 'edu.cn',
  'com.mx', 'com.ar', 'com.tr', 'com.sg', 'com.hk', 'com.tw',
  'com.my', 'com.ph', 'com.vn', 'com.pk', 'com.eg', 'com.sa',
  'co.kr', 'or.kr', 'co.il', 'co.id', 'co.th', 'in.th',
  'github.io', 'gitlab.io', 'pages.dev', 'workers.dev', 'vercel.app',
  'netlify.app', 'herokuapp.com', 'firebaseapp.com', 'web.app',
  'blogspot.com', 'wordpress.com', 's3.amazonaws.com', 'cloudfront.net'
]);

function registrableDomain(hostname) {
  if (!hostname) return '';
  const host = hostname.replace(/^www\./, '').toLowerCase();
  const parts = host.split('.');
  if (parts.length <= 2) return host;

  const lastTwo = parts.slice(-2).join('.');
  if (MULTI_PART_SUFFIXES.has(lastTwo) && parts.length >= 3) {
    return parts.slice(-3).join('.');
  }
  return lastTwo;
}

function siteOf(url) {
  try { return registrableDomain(new URL(url).hostname); } catch (_) { return ''; }
}

function isTrusted(url) {
  const site = siteOf(url);
  if (!site) return false;
  for (const d of redirectTrustedDomains) {
    if (site === d || site.endsWith('.' + d)) return true;
  }
  return false;
}

function recordNavIntent(tabId, msg) {
  navIntents.set(tabId, {
    hadAnchor: !!msg.hadAnchor,
    resolvedHref: msg.resolvedHref || null,
    rawHref: msg.rawHref || null,
    userSubmitted: !!msg.userSubmitted,
    opensNewTab: !!msg.opensNewTab,
    frameUrl: msg.frameUrl || '',
    isTopFrame: msg.isTopFrame !== false,
    at: Date.now()
  });
}

function freshIntent(tabId) {
  const intent = navIntents.get(tabId);
  if (!intent) return null;
  if (Date.now() - intent.at > INTENT_TTL_MS) return null;
  return intent;
}

/**
 * Compare a starting navigation against the recorded intent.
 *
 * The comparison is deliberately made against where the navigation STARTS, not
 * where it finally lands. If the user clicks a bit.ly link, the navigation
 * starts at bit.ly — matching their intent — and whatever bit.ly redirects to
 * afterwards is a consequence of a link they chose. The hijack case is a
 * navigation that starts somewhere the user never clicked.
 *
 * Returns null to allow, or a verdict object to block.
 */
function judgeNavigation(tabId, url) {
  if (!redirectEnabled) return null;
  if (!/^https?:/i.test(url)) return null;
  if (allowOnce.has(url)) return null;

  const intent = freshIntent(tabId);

  // No recent click at all: a typed URL, a bookmark, a reload, a restored tab.
  // Nothing to compare against, so nothing to block.
  if (!intent) return null;

  // The user submitted a form. Cross-site posts are normal (search, checkout,
  // SSO), and there is no href to compare against.
  if (intent.userSubmitted) return null;

  if (isTrusted(intent.frameUrl) || isTrusted(url)) return null;

  const targetSite = siteOf(url);
  const sourceSite = siteOf(intent.frameUrl);

  // Staying on the same site is never a hijack.
  if (targetSite && targetSite === sourceSite) return null;

  if (intent.hadAnchor && intent.resolvedHref) {
    // The navigation begins where the link pointed. Honour it.
    if (siteOf(intent.resolvedHref) === targetSite) return null;

    // A link was clicked, but the browser is heading somewhere else entirely.
    return {
      hijackType: 'destination-changed',
      expected: intent.resolvedHref,
      actual: url,
      returnTo: intent.frameUrl
    };
  }

  // The click did not land on a link at all, yet a cross-site navigation
  // started within milliseconds. This is the transparent-overlay pattern —
  // the case no URL pattern list can describe, and the one behind
  // "anywhere I click moves me to another page".
  return {
    hijackType: 'overlay-click',
    expected: null,
    actual: url,
    returnTo: intent.frameUrl
  };
}

function countBlock(tabId) {
  chrome.storage.local.get(['redirectBlockedCount'], (res) => {
    chrome.storage.local.set({ redirectBlockedCount: (res.redirectBlockedCount || 0) + 1 });
  });
  if (tabId != null) {
    chrome.action.setBadgeText({ tabId, text: '🛡' }).catch(() => {});
    chrome.action.setBadgeBackgroundColor({ tabId, color: '#ef4444' }).catch(() => {});
    setTimeout(() => updateTabBadge(tabId), 3000);
  }
}

// ── Main-frame navigation guard ──
chrome.webNavigation.onBeforeNavigate.addListener((details) => {
  // Only the top frame. An ad iframe navigating itself is not the user's
  // problem; an ad iframe navigating the tab shows up here with frameId 0.
  if (details.frameId !== 0) return;

  const verdict = judgeNavigation(details.tabId, details.url);
  if (!verdict) return;

  // Intent is consumed: one click cannot justify a second navigation.
  navIntents.delete(details.tabId);

  // webRequest cannot cancel navigations under MV3, so supersede it by sending
  // the tab back where it was. Issued immediately, this pre-empts the hijack
  // before it commits in the common case.
  if (verdict.returnTo && /^https?:/i.test(verdict.returnTo)) {
    chrome.tabs.update(details.tabId, { url: verdict.returnTo }).catch(() => {});
  }

  countBlock(details.tabId);

  // Queue for whichever content script comes up next, and also try a direct
  // push in case the current document survives.
  pendingVerdicts.set(details.tabId, {
    hijackType: verdict.hijackType,
    expected: verdict.expected,
    actual: verdict.actual
  });
  setTimeout(() => {
    chrome.tabs.sendMessage(details.tabId, {
      type: 'REDIRECT_VERDICT',
      hijackType: verdict.hijackType,
      expected: verdict.expected,
      actual: verdict.actual
    }).then(() => pendingVerdicts.delete(details.tabId)).catch(() => {});
  }, 400);
});

// ── Popunder guard ──
// The MAIN-world window.open patch stops most of these synchronously. This
// catches what gets through by another route (injected target="_blank", etc).
chrome.tabs.onCreated.addListener((tab) => {
  if (!redirectEnabled) return;
  if (tab.openerTabId == null) return;

  const url = tab.pendingUrl || tab.url || '';
  if (!/^https?:/i.test(url)) return;
  if (allowOnce.has(url) || isTrusted(url)) return;

  const intent = freshIntent(tab.openerTabId);
  if (!intent) return;                      // not click-driven; leave it alone
  if (intent.userSubmitted) return;

  // A link the user clicked, opening where it said it would.
  if (intent.hadAnchor && intent.resolvedHref && siteOf(intent.resolvedHref) === siteOf(url)) return;

  // Same-site popups are ordinary app behaviour.
  if (siteOf(intent.frameUrl) === siteOf(url)) return;

  chrome.tabs.remove(tab.id).catch(() => {});
  countBlock(tab.openerTabId);
  pendingVerdicts.set(tab.openerTabId, {
    hijackType: 'popup',
    expected: intent.hadAnchor ? intent.resolvedHref : null,
    actual: url
  });
  chrome.tabs.sendMessage(tab.openerTabId, {
    type: 'REDIRECT_VERDICT',
    hijackType: 'popup',
    expected: intent.hadAnchor ? intent.resolvedHref : null,
    actual: url
  }).then(() => pendingVerdicts.delete(tab.openerTabId)).catch(() => {});
});

chrome.tabs.onRemoved.addListener((tabId) => {
  navIntents.delete(tabId);
  pendingVerdicts.delete(tabId);
});

