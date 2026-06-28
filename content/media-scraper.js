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

  function add(url, type, quality = '', codec = '') {
    if (!url || seen.has(url)) return;
    seen.add(url);
    found.push({ url, type, quality, codec, mimeType: '', isVideo: type === 'video', isAudio: type === 'audio' });
  }

  // <video> and <audio> elements
  document.querySelectorAll('video, audio').forEach(el => {
    if (el.src) add(el.src, el.tagName.toLowerCase());
    el.querySelectorAll('source').forEach(s => add(s.src, el.tagName.toLowerCase(), '', s.type));
  });

  // <a> links to media files
  const mediaExtensions = /\.(mp4|webm|mkv|avi|mov|m4v|mp3|m4a|ogg|wav|flac|aac|pdf|docx?|pptx?|xlsx?|torrent|m3u8|mpd)(\?.*)?$/i;
  document.querySelectorAll('a[href]').forEach(a => {
    const isPdfPath = /\/pdf\/[a-z0-9.-]+/i.test(a.href);
    if (mediaExtensions.test(a.href) || isPdfPath) {
      const ext = a.href.match(/\.(mp4|webm|mkv|avi|mov|mp3|m4a|ogg|wav|flac|aac|pdf|torrent|m3u8|mpd)/i);
      const type = ext ? (['mp4','webm','mkv','avi','mov','m4v'].includes(ext[1]) ? 'video' : ['mp3','m4a','ogg','wav','flac','aac'].includes(ext[1]) ? 'audio' : 'doc') : 'doc';
      add(a.href, type, '', '');
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
            const type = extMatch ? (['mp4','webm','mkv','avi','mov','m4v'].includes(extMatch[1]) ? 'video' : ['mp3','m4a','ogg','wav','flac','aac'].includes(extMatch[1]) ? 'audio' : 'doc') : 'doc';
            add(absUrl, type, '', '');
          } else if (/\/pdf\/[a-z0-9.-]+/i.test(absUrl)) {
            add(absUrl, 'doc', '', '');
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
      const extMatch = u.match(/\.(mp4|webm|mkv|avi|mov|m4v|mp3|m4a|ogg|wav|flac|aac|pdf|torrent|m3u8|mpd)/i);
      const type = extMatch ? (['mp4','webm','mkv','avi','mov','m4v'].includes(extMatch[1]) ? 'video' : ['mp3','m4a','ogg','wav','flac','aac'].includes(extMatch[1]) ? 'audio' : 'doc') : 'doc';
      add(u, type, '', '');
    }

    const relUrlRegex = /(?:"|')([a-z0-9_\-\/\\.+]+?\.(?:mp4|webm|m4v|mkv|mov|flv|avi|mp3|m4a|aac|ogg|opus|wav|flac|pdf|docx?|pptx?|xlsx?|epub|rtf|csv|zip|rar|7z|apk|torrent|m3u8|mpd)(?:\?[^\s"'`<>]*)*)(?:"|')/gi;
    while ((m = relUrlRegex.exec(pageHtml)) !== null) {
      const rawUrl = m[1].replace(/\\/g, '');
      try {
        const u = new URL(rawUrl, window.location.href).href;
        const extMatch = u.match(/\.(mp4|webm|mkv|avi|mov|m4v|mp3|m4a|ogg|wav|flac|aac|pdf|torrent|m3u8|mpd)/i);
        const type = extMatch ? (['mp4','webm','mkv','avi','mov','m4v'].includes(extMatch[1]) ? 'video' : ['mp3','m4a','ogg','wav','flac','aac'].includes(extMatch[1]) ? 'audio' : 'doc') : 'doc';
        add(u, type, '', '');
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
