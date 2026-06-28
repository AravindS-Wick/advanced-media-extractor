// This script runs IN the page's own JS context (world: MAIN) at document_start.
// It intercepts YouTube player variables, and hooks fetch/XHR to extract streams
// from YouTube, Instagram, TikTok, Twitter/X, and generic media sites.
(function initPageExtractor() {
  // Prevent duplicate runs
  if (window.__mediaExtractorInitialized) return;
  window.__mediaExtractorInitialized = true;

  // ── 1. Intercept ytInitialPlayerResponse via Setter/Getter ─────────────────
  let playerResponseVal = null;
  function processPlayerResponse(val) {
    if (!val || !val.streamingData) return;
    try {
      const videoDetails = val.videoDetails || {};
      const title = videoDetails.title || document.title;
      const allFormats = [
        ...(val.streamingData.formats || []),
        ...(val.streamingData.adaptiveFormats || [])
      ];

      const streams = [];
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

        streams.push({
          url,
          quality,
          codec,
          mimeType: codec,
          width: fmt.width || 0,
          height,
          bitrate,
          isVideo,
          isAudio,
          isMuxed
        });
      }

      // Sort: muxed first, then video by height desc, then audio by bitrate desc
      streams.sort((a, b) => {
        if (a.isMuxed && !b.isMuxed) return -1;
        if (!a.isMuxed && b.isMuxed) return 1;
        if (a.isVideo && b.isVideo) return b.height - a.height;
        if (a.isAudio && b.isAudio) return b.bitrate - a.bitrate;
        return a.isVideo ? -1 : 1;
      });

      if (streams.length > 0) {
        window.postMessage({
          source: 'media-extractor-pro',
          type: 'YT_STREAMS',
          payload: { title, streams, url: window.location.href }
        }, '*');
      }
    } catch (e) {
      console.error('[Media Extractor] Error processing player response:', e);
    }
  }

  // Intercept the property on window
  try {
    Object.defineProperty(window, 'ytInitialPlayerResponse', {
      get() {
        return playerResponseVal;
      },
      set(val) {
        playerResponseVal = val;
        processPlayerResponse(val);
      },
      configurable: true
    });
  } catch (e) {
    console.warn('[Media Extractor] Could not define ytInitialPlayerResponse setter:', e);
  }

  // ── 2. Intercept Fetch & XHR to capture media stream URLs ────────────────────
  function extractMediaFromUrl(url, contentType = '') {
    if (!url || typeof url !== 'string') return;
    if (url.startsWith('blob:') || url.startsWith('data:')) return;

    // Skip YouTube segment URLs to avoid spamming (handled by player response)
    if (url.includes('googlevideo.com') || url.includes('youtube.com/videoplayback')) {
      return;
    }

    const isVideo = contentType ? contentType.startsWith('video/') : /\.(mp4|webm|mkv|avi|mov|m4v|m3u8|mpd)(\?.*)?$/i.test(url);
    const isAudio = contentType ? contentType.startsWith('audio/') : /\.(mp3|m4a|ogg|wav|flac|aac)(\?.*)?$/i.test(url);

    if (!isVideo && !isAudio) return;

    let quality = 'Stream';
    if (isVideo) {
      if (url.includes('.m3u8')) quality = 'HLS Playlist (m3u8)';
      else if (url.includes('.mpd')) quality = 'DASH Playlist (mpd)';
      else {
        // Try to parse height from resolution params if visible in URL
        const resMatch = url.match(/_(\d{3,4})p(_|$)/) || url.match(/[_\-/](\d{3,4})[xX]/);
        quality = resMatch ? `${resMatch[1]}p` : 'Video Stream';
      }
    } else {
      quality = 'Audio Stream';
    }

    const stream = {
      url,
      quality,
      codec: contentType || '',
      mimeType: contentType || '',
      width: 0,
      height: 0,
      bitrate: 0,
      isVideo,
      isAudio,
      isMuxed: isVideo // Default generic streams as muxed
    };

    window.postMessage({
      source: 'media-extractor-pro',
      type: 'NETWORK_STREAM',
      payload: {
        title: document.title || 'Extracted Streams',
        streams: [stream],
        url: window.location.href
      }
    }, '*');
  }

  // Hook fetch
  try {
    const origFetch = window.fetch;
    window.fetch = async function(...args) {
      const response = await origFetch.apply(this, args);
      try {
        const url = response.url;
        const contentType = response.headers.get('content-type') || '';
        extractMediaFromUrl(url, contentType);
      } catch (e) {}
      return response;
    };
  } catch (e) {
    console.warn('[Media Extractor] Could not hook fetch:', e);
  }

  // Hook XHR
  try {
    const origOpen = XMLHttpRequest.prototype.open;
    XMLHttpRequest.prototype.open = function(method, url, ...args) {
      this._url = url;
      return origOpen.apply(this, [method, url, ...args]);
    };

    const origSend = XMLHttpRequest.prototype.send;
    XMLHttpRequest.prototype.send = function(...args) {
      this.addEventListener('load', () => {
        try {
          const contentType = this.getResponseHeader('Content-Type') || '';
          extractMediaFromUrl(this._url, contentType);
        } catch (e) {}
      });
      return origSend.apply(this, args);
    };
  } catch (e) {
    console.warn('[Media Extractor] Could not hook XHR:', e);
  }

  // ── 3. DOM Poller and fallbacks ───────────────────────────────────────────
  function checkDomAndGlobals() {
    // If ytInitialPlayerResponse was already set before our script loaded
    if (window.ytInitialPlayerResponse) {
      processPlayerResponse(window.ytInitialPlayerResponse);
    }
    
    // Check script tags for ytInitialPlayerResponse fallback
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
              const parsed = JSON.parse(text.substring(startIdx, endIdx + 1));
              processPlayerResponse(parsed);
              break;
            } catch (_) {}
          }
        }
      }
    }
  }

  // Periodically check or check on events
  if (document.readyState === 'complete') {
    checkDomAndGlobals();
  } else {
    window.addEventListener('DOMContentLoaded', checkDomAndGlobals);
    window.addEventListener('load', checkDomAndGlobals);
  }
  
  // Also poll a few times just in case of lazy dynamic loads
  setTimeout(checkDomAndGlobals, 1000);
  setTimeout(checkDomAndGlobals, 3000);
})();
