// This script runs IN the page's own JS context (world: MAIN) at document_start.
// It intercepts YouTube player variables, Dailymotion player metadata, and hooks
// fetch/XHR to extract streams from YouTube, Dailymotion, Instagram, TikTok, Twitter/X, and generic media sites.
(function initPageExtractor() {
  // Prevent duplicate runs
  if (window.__mediaExtractorInitialized) return;
  window.__mediaExtractorInitialized = true;

  // ── 1. Intercept YouTube ytInitialPlayerResponse ───────────────────────────
  let playerResponseVal = null;
  function processPlayerResponse(val) {
    if (!val || !val.streamingData) return;
    try {
      const videoDetails = val.videoDetails || {};
      const title = videoDetails.title || document.title;
      const duration = parseInt(videoDetails.lengthSeconds, 10) || 0;
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
          type: isVideo ? 'video' : 'audio',
          kind: 'file',
          quality,
          codec,
          mimeType: codec,
          width: fmt.width || 0,
          height,
          bitrate,
          duration,
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
          payload: { title, streams, url: window.location.href, duration }
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

  // ── 2. Deep Dailymotion Metadata Extractor ────────────────────────────────
  async function checkDailymotion() {
    if (!location.hostname.includes('dailymotion.com')) return;
    const match = location.pathname.match(/\/video\/([a-zA-Z0-9]+)/);
    if (!match) return;
    const videoId = match[1];

    try {
      const metaUrl = `https://www.dailymotion.com/player/metadata/video/${videoId}`;
      const res = await fetch(metaUrl);
      if (!res.ok) return;
      const data = await res.json();

      const title = data.title || document.title;
      const duration = data.duration || 0;
      const poster = (data.thumbnails && (data.thumbnails['1080'] || data.thumbnails['720'] || data.thumbnails['480'] || data.thumbnails['60'])) || '';
      const streams = [];

      if (data.qualities) {
        for (const [qName, qList] of Object.entries(data.qualities)) {
          for (const item of qList) {
            if (item.url) {
              const isHls = item.type === 'application/x-mpegURL' || item.url.includes('.m3u8');
              streams.push({
                url: item.url,
                type: 'video',
                kind: isHls ? 'hls' : 'file',
                quality: qName === 'auto' ? 'HLS Master (Auto)' : `${qName}p`,
                codec: item.type || '',
                mimeType: item.type || '',
                width: 0,
                height: parseInt(qName, 10) || 0,
                bitrate: 0,
                duration,
                isVideo: true,
                isAudio: false,
                isMuxed: true
              });
            }
          }
        }
      }

      if (streams.length > 0) {
        window.postMessage({
          source: 'media-extractor-pro',
          type: 'DAILYMOTION_STREAMS',
          payload: { title, streams, url: window.location.href, poster, duration }
        }, '*');
      }
    } catch (_) {}
  }

  // ── 3. Intercept Fetch & XHR to capture media stream URLs ────────────────────
  function inspectInstagramJson(data) {
    if (!data || typeof data !== 'object') return;
    const streams = [];
    const seenUrls = new Set();

    function walk(obj) {
      if (!obj || typeof obj !== 'object') return;
      if (Array.isArray(obj.video_versions)) {
        for (const v of obj.video_versions) {
          if (v.url && !seenUrls.has(v.url)) {
            seenUrls.add(v.url);
            let u = v.url;
            try {
              const parsed = new URL(u);
              parsed.searchParams.delete('bytestart');
              parsed.searchParams.delete('byteend');
              u = parsed.toString();
            } catch (_) {}
            const h = v.height || 0;
            const posterUrl = obj.display_url || obj.thumbnail_src || (obj.image_versions2?.candidates?.[0]?.url) || '';
            let caption = '';
            if (obj.caption && typeof obj.caption === 'object' && obj.caption.text) caption = obj.caption.text;
            else if (typeof obj.caption === 'string') caption = obj.caption;
            else if (obj.edge_media_to_caption?.edges?.[0]?.node?.text) caption = obj.edge_media_to_caption.edges[0].node.text;

            streams.push({
              url: u,
              type: 'video',
              kind: 'file',
              quality: h ? `${h}p` : 'Instagram Video',
              width: v.width || 0,
              height: h,
              duration: obj.video_duration || 0,
              poster: posterUrl,
              metaTitle: caption ? caption.slice(0, 80) : '',
              isVideo: true,
              isAudio: false,
              isMuxed: true
            });

            // Surface audio track separately so user can download audio independently
            streams.push({
              url: u,
              type: 'audio',
              kind: 'file',
              quality: 'Instagram Audio (MP3/M4A)',
              width: 0,
              height: 0,
              duration: obj.video_duration || 0,
              poster: posterUrl,
              metaTitle: (caption ? caption.slice(0, 80) : '') + ' (Audio)',
              isVideo: false,
              isAudio: true
            });
          }
        }
      }
      if (obj.video_url && typeof obj.video_url === 'string' && !seenUrls.has(obj.video_url)) {
        seenUrls.add(obj.video_url);
        const posterUrl = obj.display_url || obj.thumbnail_src || (obj.image_versions2?.candidates?.[0]?.url) || '';
        let caption = '';
        if (obj.caption && typeof obj.caption === 'object' && obj.caption.text) caption = obj.caption.text;
        else if (typeof obj.caption === 'string') caption = obj.caption;
        else if (obj.edge_media_to_caption?.edges?.[0]?.node?.text) caption = obj.edge_media_to_caption.edges[0].node.text;

        streams.push({
          url: obj.video_url,
          type: 'video',
          kind: 'file',
          quality: 'Instagram Video',
          width: 0,
          height: 0,
          duration: obj.video_duration || 0,
          poster: posterUrl,
          metaTitle: caption ? caption.slice(0, 80) : '',
          isVideo: true,
          isAudio: false,
          isMuxed: true
        });

        streams.push({
          url: obj.video_url,
          type: 'audio',
          kind: 'file',
          quality: 'Instagram Audio (MP3/M4A)',
          width: 0,
          height: 0,
          duration: obj.video_duration || 0,
          poster: posterUrl,
          metaTitle: (caption ? caption.slice(0, 80) : '') + ' (Audio)',
          isVideo: false,
          isAudio: true
        });
      }
      for (const k of Object.keys(obj)) {
        walk(obj[k]);
      }
    }

    try {
      walk(data);
      if (streams.length > 0) {
        const firstWithPoster = streams.find(s => s.poster);
        const firstWithTitle = streams.find(s => s.metaTitle);
        window.postMessage({
          source: 'media-extractor-pro',
          type: 'INSTAGRAM_STREAMS',
          payload: {
            title: firstWithTitle?.metaTitle || document.title || 'Instagram Media',
            poster: firstWithPoster?.poster || '',
            streams,
            url: window.location.href
          }
        }, '*');
      }
    } catch (_) {}
  }

  function extractMediaFromUrl(url, contentType = '') {
    if (!url || typeof url !== 'string') return;
    if (url.startsWith('blob:') || url.startsWith('data:')) return;

    // Skip YouTube segment URLs to avoid spamming (handled by player response)
    if (url.includes('googlevideo.com') || url.includes('youtube.com/videoplayback')) {
      return;
    }

    // Normalize Instagram / Facebook CDN URLs by stripping byte-range chunk parameters
    if (/(\.cdninstagram\.com|\.fbcdn\.net)/i.test(url)) {
      try {
        const u = new URL(url);
        if (u.searchParams.has('bytestart') || u.searchParams.has('byteend')) {
          u.searchParams.delete('bytestart');
          u.searchParams.delete('byteend');
          url = u.toString();
        }
      } catch (_) {}
    }

    const ct = (contentType || '').toLowerCase();
    const isHls = /\.m3u8/i.test(url) || ct.includes('mpegurl') || ct.includes('vnd.apple.mpegurl');
    const isDash = /\.mpd/i.test(url) || ct.includes('dash+xml');
    const isExplicitAudio = ct.startsWith('audio/') || (/audio/i.test(url) && !/video/i.test(url)) || /\.(mp3|m4a|ogg|wav|flac|aac|opus)(\?.*)?$/i.test(url);
    const isVideo = !isExplicitAudio && (isHls || isDash || ct.startsWith('video/') || /\.(mp4|webm|mkv|avi|mov|m4v)(\?.*)?$/i.test(url));
    const isAudio = isExplicitAudio;

    if (!isVideo && !isAudio) return;

    let quality = 'Stream';
    if (isHls) {
      quality = 'HLS Playlist (m3u8)';
    } else if (isDash) {
      quality = 'DASH Playlist (mpd)';
    } else if (isAudio) {
      quality = 'Audio Stream';
    } else {
      const resMatch = url.match(/_(\d{3,4})p(_|$)/) || url.match(/[_\-/](\d{3,4})[xX]/);
      quality = resMatch ? `${resMatch[1]}p` : 'Video Stream';
    }

    const type = isVideo ? 'video' : 'audio';
    const kind = isHls ? 'hls' : isDash ? 'dash' : 'file';

    const stream = {
      url,
      type,
      kind,
      quality,
      codec: contentType || '',
      mimeType: contentType || '',
      width: 0,
      height: 0,
      bitrate: 0,
      isVideo,
      isAudio,
      isMuxed: isVideo
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
        if (location.hostname.includes('instagram.com') && (contentType.includes('json') || (url && (url.includes('/graphql/') || url.includes('/api/v1/'))))) {
          response.clone().json().then(data => inspectInstagramJson(data)).catch(() => {});
        }
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
          if (location.hostname.includes('instagram.com') && (contentType.includes('json') || (this._url && (this._url.includes('/graphql/') || this._url.includes('/api/v1/'))))) {
            try {
              const data = JSON.parse(this.responseText);
              inspectInstagramJson(data);
            } catch (_) {}
          }
        } catch (e) {}
      });
      return origSend.apply(this, args);
    };
  } catch (e) {
    console.warn('[Media Extractor] Could not hook XHR:', e);
  }

  // ── 4. DOM Poller and fallbacks ───────────────────────────────────────────
  function checkInstagram() {
    if (!location.hostname.includes('instagram.com')) return;
    const ogVideo = document.querySelector('meta[property="og:video"], meta[property="og:video:secure_url"], meta[property="og:video:url"]');
    if (ogVideo && ogVideo.content) {
      extractMediaFromUrl(ogVideo.content, 'video/mp4');
    }
    document.querySelectorAll('script[type="application/json"]').forEach(s => {
      try {
        const text = s.textContent || '';
        if (text.includes('video_versions') || text.includes('video_url')) {
          inspectInstagramJson(JSON.parse(text));
        }
      } catch (_) {}
    });

    // Inspect React Fiber properties on video elements to extract progressive muxed video_versions
    try {
      const videos = document.querySelectorAll('video');
      for (const v of videos) {
        let node = v;
        let depth = 0;
        while (node && depth < 8) {
          const k = Object.keys(node).find(key => key.startsWith('__reactFiber') || key.startsWith('__reactProps') || key.startsWith('__reactInternalInstance'));
          if (k && node[k]) {
            let fiber = node[k];
            let fDepth = 0;
            while (fiber && fDepth < 20) {
              const props = fiber.memoizedProps || fiber.pendingProps;
              if (props) {
                if (Array.isArray(props.video_versions)) inspectInstagramJson(props);
                if (props.post && Array.isArray(props.post.video_versions)) inspectInstagramJson(props.post);
                if (props.item && Array.isArray(props.item.video_versions)) inspectInstagramJson(props.item);
                if (props.media && Array.isArray(props.media.video_versions)) inspectInstagramJson(props.media);
              }
              fiber = fiber.return;
              fDepth++;
            }
            break;
          }
          node = node.parentElement;
          depth++;
        }
      }
    } catch (_) {}
  }

  function checkDomAndGlobals() {
    if (window.ytInitialPlayerResponse) {
      processPlayerResponse(window.ytInitialPlayerResponse);
    }
    
    // Check Dailymotion
    checkDailymotion();

    // Check Instagram
    checkInstagram();

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

  if (document.readyState === 'complete') {
    checkDomAndGlobals();
  } else {
    window.addEventListener('DOMContentLoaded', checkDomAndGlobals);
    window.addEventListener('load', checkDomAndGlobals);
  }
  
  setTimeout(checkDomAndGlobals, 1000);
  setTimeout(checkDomAndGlobals, 3000);
})();
