// Service worker: bridges content scripts <-> DevTools panels

// Store media found per tab
const tabMediaStore = {};

// ── Universal network sniffer (1DM-style): catch downloadable resources on ANY
// site/iframe by watching response content-types and URL extensions. Observational
// only (no blocking). Populates tabMediaStore so the grabber/panel can show them. ──
const EXT_VIDEO = /\.(mp4|webm|m4v|mkv|mov|flv|avi)(\?|#|$)/i;
const EXT_AUDIO = /\.(mp3|m4a|aac|ogg|opus|wav|flac)(\?|#|$)/i;
const EXT_DOC = /\.(pdf|docx?|pptx?|xlsx?|epub|rtf|csv|zip|rar|7z|apk|torrent)(\?|#|$)/i;
const EXT_HLS = /\.m3u8(\?|#|$)/i;
const EXT_DASH = /\.mpd(\?|#|$)/i;

function classifyResource(url, contentType = '') {
  const ct = contentType.toLowerCase();
  if (EXT_HLS.test(url) || ct.includes('mpegurl')) return { type: 'video', kind: 'hls' };
  if (EXT_DASH.test(url) || ct.includes('dash+xml')) return { type: 'video', kind: 'dash' };
  if (EXT_VIDEO.test(url) || ct.startsWith('video/')) return { type: 'video', kind: 'file' };
  if (EXT_AUDIO.test(url) || ct.startsWith('audio/')) return { type: 'audio', kind: 'file' };
  if (EXT_DOC.test(url) || ct.includes('pdf') || ct.includes('officedocument') ||
      ct.includes('msword') || ct.includes('zip') || ct.includes('epub')) return { type: 'doc', kind: 'file' };
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

function addSniffed(tabId, url, contentType, size = 0) {
  if (tabId < 0 || !/^https?:/i.test(url)) return;
  // Skip noisy segment spam (.m4s, fragment chunks, googlevideo)
  if (url.includes('googlevideo.com/videoplayback') || /\.m4s(\?|#|$)/i.test(url) || /\/frag\(\d+\)/i.test(url)) return;
  const c = classifyResource(url, contentType);
  if (!c) return;
  if (!tabMediaStore[tabId]) tabMediaStore[tabId] = { streams: [], title: '', url: '' };
  if (tabMediaStore[tabId].streams.some((s) => s.url === url)) return;
  tabMediaStore[tabId].streams.push({
    url, type: c.type, kind: c.kind, source: 'network',
    isVideo: c.type === 'video', isAudio: c.type === 'audio',
    mimeType: contentType || '', quality: c.kind === 'hls' ? 'HLS' : c.kind === 'dash' ? 'DASH' : '',
    size: size || 0,
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
  try {
    const vEl = document.querySelector('video');
    if (vEl && vEl.duration && !isNaN(vEl.duration) && isFinite(vEl.duration)) {
      pageVideoDuration = Math.round(vEl.duration);
    }
  } catch (_) {}

  const push = (raw, type, kind = 'file') => {
    if (!raw) return;
    let url;
    try { url = new URL(raw, location.href).href; } catch { return; }
    if (!/^https?:/i.test(url)) return;

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

  // Inline <video>/<audio>
  document.querySelectorAll('video').forEach((v) => {
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

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  // Ad Blocker status & toggle
  if (message.type === 'GET_ADBLOCK_STATUS') {
    chrome.storage.local.get(['adBlockEnabled'], (res) => {
      const enabled = typeof res.adBlockEnabled === 'boolean' ? res.adBlockEnabled : true;
      sendResponse({ enabled });
    });
    return true;
  }
  if (message.type === 'TOGGLE_ADBLOCK') {
    const enable = !!message.enable;
    chrome.storage.local.set({ adBlockEnabled: enable }, () => {
      chrome.declarativeNetRequest.updateEnabledRulesets({
        enableRulesetIds: enable ? ['ad_block_rules'] : [],
        disableRulesetIds: enable ? [] : ['ad_block_rules']
      }).then(() => {
        sendResponse({ ok: true, enabled: enable });
      }).catch(err => {
        sendResponse({ ok: false, error: err.message });
      });
    });
    return true;
  }
  // Clear stored tab media
  if (message.type === 'CLEAR_TAB_MEDIA') {
    const tabId = message.tabId;
    if (tabId && tabMediaStore[tabId]) {
      tabMediaStore[tabId] = { streams: [], title: '', url: '' };
    }
    updateTabBadge(tabId);
    sendResponse({ ok: true });
    return true;
  }

  // Fetch missing size via HEAD request
  if (message.type === 'FETCH_SIZE' && message.url) {
    fetch(message.url, { method: 'HEAD' })
      .then(res => {
        const len = res.headers.get('content-length');
        const size = len ? parseInt(len, 10) : 0;
        sendResponse({ ok: true, size });
      })
      .catch(() => sendResponse({ ok: false, size: 0 }));
    return true;
  }

  // Fetch ArrayBuffer for client-side ZIP packaging
  if (message.type === 'FETCH_BLOB_ARRAY' && message.url) {
    fetch(message.url)
      .then(res => {
        if (!res.ok) throw new Error('HTTP ' + res.status);
        return res.arrayBuffer();
      })
      .then(buf => {
        const bytes = Array.from(new Uint8Array(buf));
        sendResponse({ ok: true, bytes });
      })
      .catch(err => sendResponse({ ok: false, error: err.message }));
    return true;
  }

  // Offscreen finished assembling -> SW saves the blob URL (offscreen lacks chrome.downloads).
  if (message.type === 'OFFSCREEN_DOWNLOAD') {
    chrome.downloads.download({ url: message.url, filename: message.filename, saveAs: false }, (downloadId) => {
      if (chrome.runtime.lastError) {
        chrome.runtime.sendMessage({ type: 'MUX_DONE', id: message.id, error: chrome.runtime.lastError.message }).catch(() => {});
      } else {
        chrome.runtime.sendMessage({ type: 'MUX_DONE', id: message.id, file: message.filename, segments: message.segments, container: message.container, downloadId }).catch(() => {});
      }
    });
    return false;
  }

  // Client-side HLS mux: hand the .m3u8 to the offscreen document.
  if (message.type === 'MUX_HLS') {
    ensureOffscreen()
      .then(() => chrome.runtime.sendMessage({ type: 'DO_MUX', id: message.id, url: message.url, filename: message.filename }))
      .catch((err) => chrome.runtime.sendMessage({ type: 'MUX_DONE', id: message.id, error: err.message }));
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

  // Full page scan: DOM resources (all frames) + sniffed network streams, merged.
  if (message.type === 'SCAN_TAB') {
    const tabId = message.tabId;
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

    const existingUrls = new Set(tabMediaStore[tabId].streams.map(s => s.url));
    const newStreams = (payload.streams || []).filter(s => s.url && !existingUrls.has(s.url));
    tabMediaStore[tabId].streams.push(...newStreams);

    updateTabBadge(tabId);

    // Notify any open DevTools panel for this tab (fire-and-forget)
    chrome.runtime.sendMessage({
      type: 'MEDIA_UPDATE',
      tabId,
      data: tabMediaStore[tabId]
    }).catch(() => {});

    sendResponse({ ok: true, added: newStreams.length });
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
    const { url, filename, pageUrl } = message;

    // Determine the referer and origin from the page URL
    let referer = 'https://www.youtube.com/';
    let origin = 'https://www.youtube.com';
    try {
      const u = new URL(pageUrl || url);
      referer = u.origin + '/';
      origin = u.origin;
    } catch (_) {}

    // Register a temporary declarativeNetRequest rule to inject Referer & Origin headers
    const ruleId = Math.floor(Math.random() * 100000) + 1;
    let urlHost = '';
    try {
      urlHost = new URL(url).hostname;
    } catch (_) {}

    if (urlHost) {
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
        triggerDownload();
      }).catch(err => {
        console.error('Failed to set headers rule:', err);
        triggerDownload();
      });
    } else {
      triggerDownload();
    }

    function triggerDownload() {
      chrome.downloads.download({
        url,
        filename: filename || 'media.mp4',
        saveAs: false
      }, (downloadId) => {
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
          sendResponse({ ok: true, downloadId });
        }
      });
    }

    return true;
  }

  // Open URL in new tab (DevTools panel doesn't have direct chrome.tabs access)
  if (message.type === 'OPEN_TAB') {
    const { url, pageUrl } = message;

    // Determine the referer and origin from the page URL
    let referer = 'https://www.youtube.com/';
    let origin = 'https://www.youtube.com';
    try {
      const u = new URL(pageUrl || url);
      referer = u.origin + '/';
      origin = u.origin;
    } catch (_) {}

    const ruleId = Math.floor(Math.random() * 100000) + 1;
    let urlHost = '';
    try {
      urlHost = new URL(url).hostname;
    } catch (_) {}

    if (urlHost) {
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

// Enforce stored Ad Blocker preference across extension reloads, browser restarts, and SW startup
function syncAdBlockRuleset() {
  chrome.storage.local.get(['adBlockEnabled'], (res) => {
    const enabled = typeof res.adBlockEnabled === 'boolean' ? res.adBlockEnabled : true;
    if (typeof res.adBlockEnabled !== 'boolean') {
      chrome.storage.local.set({ adBlockEnabled: true });
    }
    chrome.declarativeNetRequest.updateEnabledRulesets({
      enableRulesetIds: enabled ? ['ad_block_rules'] : [],
      disableRulesetIds: enabled ? [] : ['ad_block_rules']
    }).catch(() => {});
  });
}

chrome.runtime.onInstalled.addListener(syncAdBlockRuleset);
chrome.runtime.onStartup.addListener(syncAdBlockRuleset);
syncAdBlockRuleset();

