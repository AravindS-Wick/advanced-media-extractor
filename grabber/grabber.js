// Standalone Page Grabber Script
const params = new URLSearchParams(location.search);
const tabId = parseInt(params.get('tabId'), 10);
const pageUrlParam = params.get('url') || '';

let items = [];
let activeCat = 'all';
let pageTitleVal = '';
let searchQuery = '';
const muxJobs = {};

// Progress/result from the offscreen HLS muxer
chrome.runtime.onMessage.addListener((m) => {
  if (!m) return;

  if (m.type === 'DOWNLOAD_HISTORY_UPDATED' || m.type === 'ACTIVE_DOWNLOADS_UPDATED' || m.type === 'DOWNLOAD_COMPLETE' || m.type === 'MUX_PROGRESS' || m.type === 'MUX_DONE') {
    if (typeof refreshDownloadsList === 'function' && !$('downloadsView').classList.contains('hidden')) refreshDownloadsList();
  }

  const j = m && m.id && muxJobs[m.id];
  if (!j) return;
  if (m.type === 'MUX_PROGRESS') {
    const text = m.status || `${m.id.startsWith('dl_') ? 'Fetching' : 'Muxing'} ${Math.round(m.percent)}%`;
    if (j.btn) {
      j.btn.disabled = true;
      j.btn.textContent = text;
    }
    j.setMsg(text, true);
  } else if (m.type === 'MUX_DONE') {
    if (m.error) {
      const isCancel = m.error.includes('aborted') || m.error.includes('Cancelled');
      j.setMsg(isCancel ? 'Cancelled' : m.error, false);
      resetBtn(j.btn);
    } else {
      const details = m.segments ? ` (${m.segments} segs)` : '';
      j.setMsg(`✓ ${m.file || 'saved'}${details}`, true);
      if (j.btn) {
        j.btn.disabled = false;
        j.btn.textContent = '✓ Saved';
        setTimeout(() => resetBtn(j.btn), 3500);
      }
    }
    delete muxJobs[m.id];
  }
});

const $ = (id) => document.getElementById(id);

document.addEventListener('DOMContentLoaded', init);

function init() {
  $('pageUrl').textContent = pageUrlParam;
  setupVideoModal();

  document.querySelectorAll('.tab').forEach((t) => {
    t.onclick = () => {
      document.querySelectorAll('.tab').forEach((x) => x.classList.remove('active'));
      t.classList.add('active');

      if (t.dataset.view === 'downloads') {
        document.querySelector('.controls-bar').classList.add('hidden');
        $('status').classList.add('hidden');
        document.querySelector('main').classList.add('hidden');
        $('downloadsView').classList.remove('hidden');
        refreshDownloadsList();
        return;
      }

      document.querySelector('.controls-bar').classList.remove('hidden');
      $('status').classList.remove('hidden');
      document.querySelector('main').classList.remove('hidden');
      $('downloadsView').classList.add('hidden');

      activeCat = t.dataset.cat;
      populateFilterDropdown();
      render();
    };
  });

  // Search input handler
  $('searchInput').oninput = (e) => {
    searchQuery = e.target.value.toLowerCase().trim();
    render();
  };

  $('rescan').onclick = scan;
  $('clearList').onclick = clearList;
  $('dlAll').onclick = triggerBulkDownloadModal;
  $('filterType').onchange = render;
  $('sortBy').onchange = render;
  $('sortOrder').onchange = render;

  const expTxt = $('exportTxtBtn');
  if (expTxt) {
    expTxt.onclick = () => {
      const list = getFilteredAndSortedItems();
      const urls = list.map(it => it.url).join('\n');
      const blob = new Blob([urls], { type: 'text/plain;charset=utf-8' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `media_links_${Date.now()}.txt`;
      a.click();
    };
  }

  const expJson = $('exportJsonBtn');
  if (expJson) {
    expJson.onclick = () => {
      const list = getFilteredAndSortedItems();
      const exportData = list.map(it => ({
        name: it._customName || it.title || 'media',
        url: it.url,
        type: it.type,
        kind: it.kind,
        size: it.size,
        resolution: it._pixelLabel || '',
        duration: it.duration || 0
      }));
      const blob = new Blob([JSON.stringify(exportData, null, 2)], { type: 'application/json;charset=utf-8' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `media_metadata_${Date.now()}.json`;
      a.click();
    };
  }

  setupBulkModal();
  setupVideoModal();
  setupDownloadsTab();
  scan();
}

function clearList() {
  items = [];
  if (tabId) {
    chrome.runtime.sendMessage({ type: 'CLEAR_TAB_MEDIA', tabId });
  }
  updateCounts();
  populateFilterDropdown();
  render();
}

async function scan() {
  $('status').textContent = 'Scanning this page…';
  $('grid').innerHTML = '';

  if (tabId) {
    try {
      const res = await chrome.scripting.executeScript({
        target: { tabId },
        func: () => {
          function parseIso(s) {
            if (!s) return 0;
            const m = s.match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/i);
            if (!m) return 0;
            return parseInt(m[1]||'0', 10)*3600 + parseInt(m[2]||'0', 10)*60 + parseInt(m[3]||'0', 10);
          }
          const v = document.querySelector('video');
          if (v && v.duration && !isNaN(v.duration) && isFinite(v.duration) && v.duration > 0) return Math.round(v.duration);

          const mDur = document.querySelector('meta[property="og:video:duration"], meta[itemprop="duration"], meta[name="duration"]');
          if (mDur && mDur.content) {
            if (/^\d+$/.test(mDur.content)) return parseInt(mDur.content, 10);
            const p = parseIso(mDur.content);
            if (p > 0) return p;
          }

          const scripts = document.querySelectorAll('script[type="application/ld+json"]');
          for (const s of scripts) {
            try {
              const data = JSON.parse(s.textContent);
              const dur = data.duration || (data['@graph'] && data['@graph'].find(x => x.duration)?.duration);
              if (dur) {
                const p = parseIso(dur);
                if (p > 0) return p;
              }
            } catch (_) {}
          }
          try {
            if (window.__PLAYER_CONFIG__ && window.__PLAYER_CONFIG__.metadata && window.__PLAYER_CONFIG__.metadata.duration) {
              return parseInt(window.__PLAYER_CONFIG__.metadata.duration, 10);
            }
          } catch (_) {}
          return 1800; // 30 min default fallback for page video streams
        }
      });
      if (res && res[0] && res[0].result) {
        window._pageVideoDuration = res[0].result;
      }
    } catch (_) {}
  }

  chrome.runtime.sendMessage({ type: 'SCAN_TAB', tabId }, async (resp) => {
    if (chrome.runtime.lastError || !resp || !resp.ok) {
      $('status').textContent = 'Scan failed: ' + (chrome.runtime.lastError?.message || resp?.error || 'unknown') + ' — is the tab still open?';
      return;
    }
    // Filter out raw .m4s segment spam
    const rawItems = (resp.items || []).filter(it => !/\.m4s(\?|#|$)/i.test(it.url) && !/\/frag\(\d+\)/i.test(it.url));
    pageTitleVal = resp.title || '';

    // Expand HLS streams into separate resolution cards (1080p, 720p, 480p, 360p) with estimated sizes
    items = await expandHlsStreams(rawItems);
    updateCounts();
    populateFilterDropdown();
    const total = items.length;
    $('status').textContent = total ? `Found ${total} resource${total === 1 ? '' : 's'} on this page.` : 'No downloadable resources detected. Try playing the video, then Rescan.';
    render();
  });
}

function catOf(it) {
  if (it.isAudio || it.type === 'audio' || (it.mimeType && it.mimeType.startsWith('audio/'))) return 'audio';
  if (it.type === 'image' || it.isImage) return 'image';
  if (it.type === 'doc' || it.isDoc) return 'doc';
  const s = it.size || it.estimatedBytes || 0;
  if (s > 0 && s < 1200000 && /audio/i.test(it.url)) return 'audio';
  if (it.isVideo || it.type === 'video') return 'video';
  return 'doc';
}

// HLS master playlists can declare subtitle/CC renditions (#EXT-X-MEDIA:TYPE=SUBTITLES)
// separately from the video variants. Surface each one as its own downloadable item.
function injectSubtitleItems(subs, parentIt) {
  let added = false;
  subs.forEach((s) => {
    if (!s.url || items.some((x) => x.url === s.url)) return;
    const parentName = parentIt._customName || parentIt.title || parentIt.metaTitle || 'Subtitle';
    items.push({
      url: s.url,
      type: 'doc',
      kind: 'subtitle',
      quality: s.label || 'CC',
      title: `${parentName} — ${s.label || 'CC'}`,
      isVideo: false,
      isAudio: false,
      isSubtitle: true
    });
    added = true;
  });
  if (added) {
    updateCounts();
    populateFilterDropdown();
    render();
  }
}

function updateCounts() {
  $('c-all').textContent = items.length;
  const videoCount = items.filter((it) => catOf(it) === 'video' && it.isMuxed !== false).length;
  const audioCount = items.filter((it) => catOf(it) === 'audio' || it.isAudio).length;
  const imageCount = items.filter((it) => catOf(it) === 'image').length;
  const docCount = items.filter((it) => catOf(it) === 'doc').length;

  if ($('c-video')) $('c-video').textContent = videoCount;
  if ($('c-audio')) $('c-audio').textContent = audioCount;
  if ($('c-image')) $('c-image').textContent = imageCount;
  if ($('c-doc')) $('c-doc').textContent = docCount;
}

function populateFilterDropdown() {
  const select = $('filterType');
  const prevVal = select.value;
  select.innerHTML = '<option value="all">All Formats</option>';
  
  const list = items.filter((it) => {
    if (activeCat === 'all') return true;
    if (activeCat === 'video') return catOf(it) === 'video' && it.isMuxed !== false;
    if (activeCat === 'audio') return catOf(it) === 'audio' || it.isAudio;
    return catOf(it) === activeCat;
  });
  const formats = new Set();
  list.forEach(it => {
    const f = it.kind === 'hls' ? 'm3u8' : it.kind === 'dash' ? 'mpd' : it.kind === 'subtitle' ? 'vtt' : ext(it.url) || it.type;
    if (f) formats.add(f.toLowerCase());
  });
  
  [...formats].sort().forEach(f => {
    const opt = document.createElement('option');
    opt.value = f;
    opt.textContent = f.toUpperCase();
    select.appendChild(opt);
  });
  
  if ([...select.options].some(o => o.value === prevVal)) {
    select.value = prevVal;
  } else {
    select.value = 'all';
  }
}

function getFilteredAndSortedItems() {
  let list = items.filter((it) => {
    if (activeCat === 'all') return true;
    if (activeCat === 'video') {
      // In the Videos tab, only show complete videos with audio!
      return catOf(it) === 'video' && it.isMuxed !== false;
    }
    if (activeCat === 'audio') {
      return catOf(it) === 'audio' || it.isAudio;
    }
    return catOf(it) === activeCat;
  });
  
  const filterVal = $('filterType') ? $('filterType').value : 'all';
  if (filterVal !== 'all') {
    list = list.filter(it => {
      const f = it.kind === 'hls' ? 'm3u8' : it.kind === 'dash' ? 'mpd' : it.kind === 'subtitle' ? 'vtt' : ext(it.url) || it.type;
      return f.toLowerCase() === filterVal;
    });
  }

  // Filter by Live Search Query
  if (searchQuery) {
    list = list.filter((it) => {
      const name = (it._customName || fileName(it)).toLowerCase();
      const url = (it.url || '').toLowerCase();
      const format = (it.kind || it.type || '').toLowerCase();
      const pixels = (it._pixelLabel || '').toLowerCase();
      return name.includes(searchQuery) || url.includes(searchQuery) || format.includes(searchQuery) || pixels.includes(searchQuery);
    });
  }
  
  const sortByVal = $('sortBy') ? $('sortBy').value : 'default';
  const sortOrderVal = $('sortOrder') ? $('sortOrder').value : 'asc';
  
  if (sortByVal !== 'default') {
    list.sort((a, b) => {
      if (sortByVal === 'quality') {
        const parseQ = (it) => {
          if (it._pixelLabel) {
            const m = it._pixelLabel.match(/(\d+)p/i);
            if (m) return parseInt(m[1], 10);
            if (/4k|uhd/i.test(it._pixelLabel)) return 2160;
          }
          if (it.height) return it.height;
          if (it.bandwidth) return Math.round(it.bandwidth / 1000);
          if (it.width) return it.width;
          if (it.isVideo || it.kind === 'hls' || it.kind === 'dash') return 500;
          if (it.type === 'image') return 300;
          if (it.isAudio || it.type === 'audio') return 100;
          return 0;
        };
        const qA = parseQ(a);
        const qB = parseQ(b);
        return qA - qB;
      } else if (sortByVal === 'name') {
        const valA = fileName(a).toLowerCase();
        const valB = fileName(b).toLowerCase();
        return valA.localeCompare(valB, undefined, { numeric: true, sensitivity: 'base' });
      } else if (sortByVal === 'size') {
        const valA = a.size || a.estimatedBytes || 0;
        const valB = b.size || b.estimatedBytes || 0;
        return valA - valB;
      } else if (sortByVal === 'type') {
        const valA = (a.kind === 'hls' ? 'm3u8' : a.kind === 'dash' ? 'mpd' : ext(a.url) || a.type || '').toLowerCase();
        const valB = (b.kind === 'hls' ? 'm3u8' : b.kind === 'dash' ? 'mpd' : ext(b.url) || b.type || '').toLowerCase();
        return valA.localeCompare(valB);
      }
      return 0;
    });
    
    if (sortOrderVal === 'desc') {
      list.reverse();
    }
  }

  return list;
}

function render() {
  const grid = $('grid');
  grid.innerHTML = '';
  
  const list = getFilteredAndSortedItems();
  
  $('dlAll').textContent = `⬇ Download all in this view (${list.length})`;
  $('dlAll').style.display = list.length ? '' : 'none';
  
  if (!list.length) {
    grid.innerHTML = '<p class="empty">No matching resources found.</p>';
    return;
  }
  list.forEach((it, idx) => grid.appendChild(card(it, idx)));
}

function card(it, idx) {
  const div = document.createElement('div');
  div.className = 'card ' + catOf(it);
  
  let downloadUrl = it.url;
  if (it.type === 'image') {
    downloadUrl = getHighResImageUrl(it.url);
  }

  // Smart Metadata Naming
  const name = it._customName || fileName({ ...it, url: downloadUrl }, idx);
  it._customName = name;

  const thumbUrl = it.poster || it.thumbnail || (it.type === 'image' ? downloadUrl : null);
  let preview = '';
  if (thumbUrl) {
    preview = `
      <div style="position: relative; width: 64px; height: 64px; flex-shrink: 0;">
        <img class="thumb" src="${esc(thumbUrl)}" loading="lazy" referrerpolicy="no-referrer" onerror="this.style.display='none';this.nextElementSibling.style.display='flex'">
        <div class="thumb icon" style="display:none">${it.isSubtitle ? '💬' : it.type === 'audio' ? '🎵' : it.type === 'doc' ? '📄' : '🎬'}</div>
      </div>
    `;
  } else if (it.type === 'video' || it.isVideo) {
    preview = `
      <div style="position: relative; width: 64px; height: 64px; flex-shrink: 0;">
        <video class="thumb" src="${esc(downloadUrl)}#t=0.1" preload="metadata" muted playsinline></video>
      </div>
    `;
  } else {
    preview = `<div class="thumb icon">${it.isSubtitle ? '💬' : it.type === 'audio' ? '🎵' : it.type === 'doc' ? '📄' : '🎬'}</div>`;
  }
  
  const sizeVal = it.size ? fmtSize(it.size) : '';
  const sizeText = sizeVal ? ` · ${sizeVal}` : '';
  const bufferLabel = (it.kind === 'hls' || it.kind === 'dash') ? ' · Stream' : '';
  let streamAudioBadge = '';
  if (it.isVideo && it.isMuxed) {
    streamAudioBadge = `<span class="kbadge" style="background:rgba(16,185,129,0.2); color:#34d399;" title="Full stream with Audio & Video combined">🔊 Video + Audio</span>`;
  } else if (it.isVideo && it.isMuxed === false) {
    streamAudioBadge = `<span class="kbadge" style="background:rgba(245,158,11,0.2); color:#fbbf24;" title="Video-only stream without sound. For 1080p/4K with sound, use 🎬 1-Click Engine">🔇 Video Only</span>`;
  } else if (it.isAudio || it.type === 'audio') {
    streamAudioBadge = `<span class="kbadge" style="background:rgba(59,130,246,0.2); color:#60a5fa;" title="Audio stream (MP3/M4A)">🎵 Audio Only</span>`;
  }

  div.innerHTML = `
    ${preview}
    <div class="info">
      <div class="name" title="Click to rename" data-idx="${idx}">${esc(name)}</div>
      <div class="sub">
        <span class="kbadge">${badge}</span>
        ${streamAudioBadge}
        ${pixelBadge}
        <span class="src">${esc(it.source || 'page')}</span>
        <span class="res-size">${sizeText}${bufferLabel}</span>
      </div>
      <div class="url" title="${esc(downloadUrl)}">${esc(downloadUrl)}</div>
    </div>
    <div class="row" style="flex-wrap: wrap; gap: 6px;">
      <div class="selector-wrap hidden" style="width: 100%; margin-bottom: 6px;">
        <select class="res-select" style="width: 100%; padding: 6px; border-radius: 4px; background: #1d2128; color: #fff; border: 1px solid #2d3139; font-size: 11px;"></select>
      </div>
      <button class="btn btn-ghost preview-btn" style="flex: initial;">👁 Preview</button>
      <button class="btn btn-ghost play-tab-btn" style="flex: initial; color: #a5b4fc;" title="Open in dedicated preview tab">↗ Tab</button>
      <button class="btn btn-primary dl">⬇ Download</button>
      <button class="btn btn-ghost copy" style="flex: initial;">Copy URL</button>
    </div>
    <div class="cstatus"></div>`;

  // Parse HLS master playlists for resolution (pixels), variants, and accurate segment-summed size
  if (it.kind === 'hls' && !it._parsedHls) {
    it._parsedHls = true;
    const inspectFn = typeof inspectHlsStream === 'function' ? inspectHlsStream : getHlsVariants;
    inspectFn(downloadUrl).then(result => {
      const variants = Array.isArray(result) ? result : (result?.variants || []);
      const segmentsCount = result?.segmentsCount || 0;

      if (variants && variants.length > 0) {
        it._variants = variants;
        const topVariant = variants[0];
        if (topVariant && topVariant.label) {
          it._pixelLabel = topVariant.label.includes('p') ? topVariant.label : topVariant.label + 'p';
          const subDiv = div.querySelector('.sub');
          if (subDiv && !subDiv.querySelector('.kbadge[style*="#065f46"]')) {
            const span = document.createElement('span');
            span.className = 'kbadge';
            span.style.cssText = 'background:#065f46; color:#a7f3d0;';
            span.textContent = it._pixelLabel;
            subDiv.appendChild(span);
          }
        }

        const sizeEl = div.querySelector('.res-size');
        if (topVariant.estimatedBytes > 0) {
          it.size = topVariant.estimatedBytes;
          const segInfo = segmentsCount ? ` (${segmentsCount} segs)` : '';
          if (sizeEl) sizeEl.textContent = ` · ~${fmtSize(topVariant.estimatedBytes)}${segInfo}`;
        } else if (topVariant.bandwidth) {
          if (sizeEl) sizeEl.textContent = ` · ${Math.round(topVariant.bandwidth / 1000)} kbps`;
        }

        // Show dropdown ONLY if multiple variants exist
        const wrap = div.querySelector('.selector-wrap');
        const sel = div.querySelector('.res-select');
        if (wrap && sel && variants.length > 1) {
          wrap.classList.remove('hidden');
          sel.innerHTML = '';
          variants.forEach(v => {
            const opt = document.createElement('option');
            opt.value = v.url;
            const vEst = v.estimatedBytes > 0 ? ` · ~${fmtSize(v.estimatedBytes)}` : '';
            const icon = v.isAudioOnly ? '🎵 ' : '';
            opt.textContent = `${icon}${v.label} (${Math.round(v.bandwidth / 1000)}k${vEst})`;
            sel.appendChild(opt);
          });

          sel.onchange = () => {
            const chosen = variants.find(v => v.url === sel.value);
            if (chosen && chosen.estimatedBytes > 0) {
              it.size = chosen.estimatedBytes;
              if (sizeEl) sizeEl.textContent = ` · ~${fmtSize(chosen.estimatedBytes)}`;
            }
          };
        }
      }

      if (result && result.subtitles && result.subtitles.length) {
        injectSubtitleItems(result.subtitles, it);
      }
    });
  }

  // Fetch real size asynchronously if missing for direct files
  if (!it.size && !it._fetchingSize && it.kind !== 'hls' && it.kind !== 'dash') {
    it._fetchingSize = true;
    chrome.runtime.sendMessage({ type: 'FETCH_SIZE', url: downloadUrl }, (res) => {
      if (res && res.ok && res.size > 0) {
        it.size = res.size;
        const sizeEl = div.querySelector('.res-size');
        if (sizeEl) sizeEl.textContent = ' · ' + fmtSize(res.size);
      }
    });
  }

  // Editable filename click handler
  const nameEl = div.querySelector('.name');
  nameEl.onclick = () => {
    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'res-name-input';
    input.value = it._customName;
    nameEl.replaceWith(input);
    input.focus();

    const saveName = () => {
      const val = input.value.trim() || name;
      it._customName = val;
      render();
    };

    input.onblur = saveName;
    input.onkeydown = (e) => { if (e.key === 'Enter') saveName(); };
  };

  // Preview button click
  const previewBtn = div.querySelector('.preview-btn');
  if (previewBtn) {
    previewBtn.onclick = () => openVideoPreview(it, downloadUrl, name);
  }

  const playTabBtn = div.querySelector('.play-tab-btn');
  if (playTabBtn) {
    playTabBtn.onclick = () => {
      const sel = div.querySelector('.res-select');
      let targetUrl = downloadUrl;
      if (sel && sel.value) targetUrl = sel.value;
      openStandalonePlayer(targetUrl, name, it.type || 'video');
    };
  }

  div.querySelector('.copy').onclick = () => navigator.clipboard.writeText(downloadUrl);
  const dlBtn = div.querySelector('.dl');
  const statusEl = div.querySelector('.cstatus');

  dlBtn.onclick = () => {
    const sel = div.querySelector('.res-select');
    let targetUrl = downloadUrl;
    if (sel && sel.value) targetUrl = sel.value;
    download({ ...it, url: targetUrl }, dlBtn, statusEl, it._customName);
  };

  return div;
}

function download(it, btn, statusEl, customFilename) {
  if (btn) { btn.disabled = true; btn.textContent = '⟳ Starting…'; }
  const setMsg = (m, ok) => { if (statusEl) { statusEl.textContent = m; statusEl.className = 'cstatus ' + (ok ? 'ok' : 'err'); } };

  // A subtitle URL from an HLS master playlist is frequently itself an .m3u8
  // wrapper, not a video stream — resolve it to the real .vtt first so it
  // doesn't get routed into the video mux pipeline.
  if (it.kind === 'subtitle') {
    downloadSubtitle(it, btn, setMsg, customFilename);
    return;
  }

  let filename = customFilename || fileName(it);

  // Ensure filename has a valid extension
  if (!/\.[a-z0-9]{2,5}$/i.test(filename)) {
    const isVid = it.kind === 'hls' || it.kind === 'dash' || it.isVideo || it.type === 'video';
    const isAud = it.type === 'audio' || it.isAudio;
    const isImg = it.type === 'image';
    filename += isVid ? '.mp4' : isAud ? '.mp3' : isImg ? '.jpg' : '.mp4';
  }

  if (it.kind === 'dash') { setMsg('DASH needs the backend (yt-dlp) helper', false); resetBtn(btn); return; }
  
  const isHls = it.kind === 'hls' ||
                /(\.m3u8|manifest\.m3u8|\/manifest\/video\/|\/hls\/|\.m3u8\?|type=hls|format=m3u8|format=hls)/i.test(it.url) ||
                (it.mimeType && /mpegurl/i.test(it.mimeType));

  if (isHls) {
    const id = 'mux_' + Math.random().toString(36).slice(2);
    muxJobs[id] = { btn, setMsg };
    setMsg('Fetching 0%…', true);
    if (btn) btn.textContent = 'Fetching 0%…';
    chrome.runtime.sendMessage({ type: 'MUX_HLS', id, url: it.url, filename });
    return;
  }

  // Direct files (images, audio, docs, mp4 files): use browser download engine via service worker
  setMsg('Downloading…', true);
  chrome.runtime.sendMessage({
    type: 'DOWNLOAD_STREAM',
    url: it.url,
    filename: filename,
    pageUrl: pageUrlParam,
    mimeType: it.mimeType || ''
  }, (res) => {
    if (res && res.isHls && res.id) {
      muxJobs[res.id] = { btn, setMsg };
      setMsg('Fetching 0%…', true);
      if (btn) btn.textContent = 'Fetching 0%…';
      return;
    }

    if (chrome.runtime.lastError || !res || !res.ok) {
      const id = 'dl_' + Math.random().toString(36).slice(2);
      muxJobs[id] = { btn, setMsg };
      chrome.runtime.sendMessage({ type: 'DOWNLOAD_PARALLEL', id, url: it.url, filename });
    } else {
      setMsg('✓ Downloaded', true);
      if (btn) {
        btn.disabled = false;
        btn.textContent = '✓ Done';
        setTimeout(() => resetBtn(btn), 3000);
      }
    }
  });
}

async function downloadSubtitle(it, btn, setMsg, customFilename) {
  setMsg('Resolving subtitle…', true);
  const resolveFn = typeof resolveSubtitleUrl === 'function' ? resolveSubtitleUrl : async (u) => u;
  let targetUrl = it.url;
  try {
    targetUrl = await resolveFn(it.url);
  } catch (_) {}

  const filename = customFilename || fileName(it);
  setMsg('Downloading…', true);
  chrome.runtime.sendMessage({
    type: 'DOWNLOAD_STREAM',
    url: targetUrl,
    filename,
    pageUrl: pageUrlParam,
    mimeType: 'text/vtt'
  }, (res) => {
    if (chrome.runtime.lastError || !res || !res.ok) {
      const id = 'dl_' + Math.random().toString(36).slice(2);
      muxJobs[id] = { btn, setMsg };
      chrome.runtime.sendMessage({ type: 'DOWNLOAD_PARALLEL', id, url: targetUrl, filename });
    } else {
      setMsg('✓ Downloaded', true);
      if (btn) {
        btn.disabled = false;
        btn.textContent = '✓ Done';
        setTimeout(() => resetBtn(btn), 3000);
      }
    }
  });
}

// ── Inbuilt Video Preview Player Modal ──
let currentPreviewItem = null;
let currentPreviewUrl = '';
let currentPreviewFilename = '';

function setupVideoModal() {
  const closeBtn = $('closeVideoBtn');
  if (closeBtn) {
    closeBtn.onclick = () => {
      const player = $('previewPlayer');
      player.pause();
      player.src = '';
      $('videoModal').classList.add('hidden');
    };
  }

  const playerDlBtn = $('playerDownloadBtn');
  if (playerDlBtn) {
    playerDlBtn.onclick = (e) => {
      e.stopPropagation();
      if (!currentPreviewItem || !currentPreviewUrl) return;
      download({ ...currentPreviewItem, url: currentPreviewUrl }, playerDlBtn, null, currentPreviewFilename);
    };
  }
}

function openVideoPreview(it, url, title) {
  $('videoTitle').textContent = title || 'Video Preview';
  currentPreviewItem = it;
  currentPreviewUrl = url;
  currentPreviewFilename = title || (it ? it._customName || fileName(it) : 'video.mp4');

  const player = $('previewPlayer');
  const playerDlBtn = $('playerDownloadBtn');
  if (playerDlBtn) {
    playerDlBtn.disabled = false;
    playerDlBtn.textContent = '⬇ Download';
  }

  player.src = url;
  $('videoModal').classList.remove('hidden');
  player.play().catch(() => {});
}

// ── Bulk Download Modal & ZIP Generator ──
function setupBulkModal() {
  $('cancelModalBtn').onclick = () => {
    $('bulkModal').classList.add('hidden');
  };

  $('dlZipBtn').onclick = () => {
    $('bulkModal').classList.add('hidden');
    startZipBulkDownload();
  };

  $('dlIndivBtn').onclick = () => {
    $('bulkModal').classList.add('hidden');
    downloadAllInCatIndividual();
  };
}

function getVisibleList() {
  let list = items.filter((it) => activeCat === 'all' || catOf(it) === activeCat);
  const filterVal = $('filterType').value;
  if (filterVal !== 'all') {
    list = list.filter(it => {
      const f = it.kind === 'hls' ? 'm3u8' : it.kind === 'dash' ? 'mpd' : it.kind === 'subtitle' ? 'vtt' : ext(it.url) || it.type;
      return f.toLowerCase() === filterVal;
    });
  }
  if (searchQuery) {
    list = list.filter((it) => {
      const name = (it._customName || fileName(it)).toLowerCase();
      const url = (it.url || '').toLowerCase();
      return name.includes(searchQuery) || url.includes(searchQuery);
    });
  }
  return list;
}

function triggerBulkDownloadModal() {
  const visibleList = getVisibleList();
  if (!visibleList.length) return;
  $('bulkCount').textContent = visibleList.length;
  $('bulkModal').classList.remove('hidden');
}

async function startZipBulkDownload() {
  const list = getVisibleList();
  if (!list.length) return;

  const btn = $('dlAll');
  btn.disabled = true;

  // Fetching, packing and blob creation all happen in the offscreen document —
  // file bytes no longer cross a chrome.runtime message, which is what capped
  // this at roughly 32MB before.
  const items = list.map((it, i) => {
    const targetUrl = it.type === 'image' ? getHighResImageUrl(it.url) : it.url;
    return {
      url: targetUrl,
      name: it._customName || fileName({ ...it, url: targetUrl }, i)
    };
  });

  const cleanTitle = (pageTitleVal || 'Media_Collection').replace(/[^a-zA-Z0-9_\-]/g, '_').slice(0, 40);
  const id = 'zip_' + Math.random().toString(36).slice(2);

  muxJobs[id] = {
    btn,
    setMsg: (m) => { btn.textContent = m; }
  };

  chrome.runtime.sendMessage({
    type: 'BUILD_ZIP',
    id,
    items,
    filename: `${cleanTitle}_Media_Collection.zip`
  });

  btn.textContent = 'Zipping 0%…';
}

let bulkBusy = false;
async function downloadAllInCatIndividual() {
  if (bulkBusy) return;
  bulkBusy = true;
  const cards = [...document.querySelectorAll('#grid .card')];
  for (const c of cards) {
    c.querySelector('.dl').click();
    await new Promise((r) => setTimeout(r, 400));
  }
  bulkBusy = false;
}

// helpers
function resetBtn(btn) { if (btn) { btn.disabled = false; btn.textContent = '⬇ Download'; } }
function ext(u) {
  if (!u) return '';
  try {
    const clean = u.split('?')[0].split('#')[0];
    const m = clean.match(/\.([a-z0-9]{2,5})$/i);
    if (!m) return '';
    const extension = m[1].toLowerCase();
    if (['php', 'aspx', 'asp', 'jsp', 'cgi', 'm3u8', 'mpd', 'ts', 'm4s', 'html', 'htm', 'txt', 'json', 'xml'].includes(extension)) {
      return '';
    }
    return extension;
  } catch (_) {
    return '';
  }
}

const GENERIC_FILENAME_RE = /^(instagram|facebook|manifest|master|playlist|index|stream|video|audio|init|output|file|media|segment|chunk|download|[a-z0-9]{4,14})$/i;

function cleanStringForFilename(str) {
  if (!str) return '';
  return str
    .replace(/^\s*\(\d+\)\s*•?\s*/i, '')
    .replace(/\s*-\s*(Dailymotion|YouTube|Vimeo|Twitter|Instagram|TikTok|X)$/i, '')
    .replace(/\s*•\s*(Instagram|Facebook)$/i, '')
    .replace(/[\\/:*?"<>|]/g, '_')
    .replace(/\s+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 100);
}

function fileName(it, index = 0) {
  const isAudio = it.type === 'audio' || it.isAudio || /(\.mp3|\.m4a|\.aac|\.wav|\.ogg|\.flac)/i.test(it.url) || (/audio/i.test(it.url) && !/video/i.test(it.url));
  const isVideo = !isAudio && (it.kind === 'hls' || it.kind === 'dash' || it.isVideo || it.type === 'video' || /(\.m3u8|\.mpd|\.mp4|\.webm|\.mkv|\.mov)/i.test(it.url));
  const isImage = !isAudio && !isVideo && (it.type === 'image' || /(\.jpg|\.jpeg|\.png|\.webp|\.gif|\.svg|\.avif)/i.test(it.url));

  let e = ext(it.url);
  if (it.kind === 'subtitle') e = 'vtt'; // Always saved as the resolved .vtt, regardless of the source playlist URL
  else if (isAudio) {
    if (!e || e === 'mp4') e = 'mp3';
  } else if (!e) {
    if (isVideo) e = 'mp4';
    else if (isImage) e = 'jpg';
    else if (it.type === 'doc') e = 'pdf';
    else e = 'mp4';
  }

  if (it._customName) {
    let custom = it._customName.trim();
    if (!/\.[a-z0-9]{2,5}$/i.test(custom)) {
      custom += `.${e}`;
    }
    return custom;
  }

  // 1. Try item metadata title if present
  if (it.metaTitle || it.title) {
    const cleaned = cleanStringForFilename(it.metaTitle || it.title);
    if (cleaned && cleaned.length > 3 && !GENERIC_FILENAME_RE.test(cleaned)) {
      return isAudio && !/audio/i.test(cleaned) ? `${cleaned}_Audio.${e}` : `${cleaned}.${e}`;
    }
  }

  // 1.5. If Instagram Reel/Post, try extracting reel code
  if (tabUrl && tabUrl.includes('instagram.com')) {
    const reelMatch = tabUrl.match(/\/(?:reels?|p)\/([A-Za-z0-9_-]+)/);
    if (reelMatch) {
      return isAudio ? `Instagram_Reel_${reelMatch[1]}_Audio.${e}` : `Instagram_Reel_${reelMatch[1]}.${e}`;
    }
  }

  // 2. Try page title for video/audio streams or main media
  if (pageTitleVal) {
    const cleaned = cleanStringForFilename(pageTitleVal);
    if (cleaned && cleaned.length > 3) {
      if (isVideo) {
        return `${cleaned}.${e}`;
      }
      return `${cleaned}_${it.type || 'item'}_${index + 1}.${e}`;
    }
  }

  // 3. Fallback to URL pathname if clean and not generic
  try {
    const rawBase = decodeURIComponent(new URL(it.url).pathname.split('/').pop() || '');
    const cleanBase = cleanStringForFilename(rawBase.replace(/\.[^/.]+$/, ''));
    if (cleanBase && cleanBase.length > 3 && !GENERIC_FILENAME_RE.test(cleanBase) && !/^[a-f0-9]{16,}$/i.test(cleanBase)) {
      return `${cleanBase}.${e}`;
    }
  } catch (_) {}

  // 4. Default fallback
  const fallbackTitle = cleanStringForFilename(pageTitleVal) || 'Media';
  return `${fallbackTitle}_${it.type || 'item'}_${index + 1}.${e}`;
}

function fmtSize(bytes) {
  if (!bytes) return '';
  const k = 1024;
  const sizes = ['Bytes', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
}

function esc(s) { return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }

// Parse HLS master playlist variants
async function getHlsVariants(masterUrl) {
  try {
    const response = await fetch(masterUrl);
    if (!response.ok) return [];
    const text = await response.text();
    if (!text.includes('#EXT-X-STREAM-INF')) return [];
    
    if (typeof parseMasterPlaylist === 'function') {
      return parseMasterPlaylist(text, masterUrl);
    }

    const lines = text.split(/\r?\n/);
    const variants = [];
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].startsWith('#EXT-X-STREAM-INF')) {
        const bw = parseInt((lines[i].match(/BANDWIDTH=(\d+)/) || [])[1] || '0', 10);
        const resMatch = lines[i].match(/RESOLUTION=(\d+x\d+)/);
        const resolution = resMatch ? resMatch[1] : '';
        const height = resolution ? resolution.split('x')[1] + 'p' : '';
        const uri = (lines[i + 1] || '').trim();
        if (uri && !uri.startsWith('#')) {
          const variantUrl = new URL(uri, masterUrl).href;
          variants.push({
            url: variantUrl,
            bandwidth: bw,
            label: height || (bw ? `${Math.round(bw / 1000)}k` : 'Stream')
          });
        }
      }
    }
    variants.sort((a, b) => b.bandwidth - a.bandwidth);
    return variants;
  } catch (e) {
    console.error('Failed to parse HLS variants:', e);
    return [];
  }
}

// Enhance image URLs to higher resolutions where possible
function getHighResImageUrl(url) {
  try {
    const u = new URL(url);
    if (u.hostname.includes('dmcdn.net') && u.pathname.includes('/v/')) {
      u.pathname = u.pathname.replace(/\/x(160|240|360|480|720)(\?|$)/, '/x1080$2');
      return u.href;
    }
    if (u.hostname.includes('ytimg.com')) {
      return u.href.replace(/(hqdefault|mqdefault|sddefault)\.jpg/, 'maxresdefault.jpg');
    }
    if (u.hostname.includes('wikimedia.org') && u.pathname.includes('/thumb/')) {
      const parts = u.pathname.split('/');
      const thumbIndex = parts.indexOf('thumb');
      if (thumbIndex !== -1) {
        parts.splice(thumbIndex, 1);
        parts.pop();
        u.pathname = parts.join('/');
        return u.href;
      }
    }
    if (u.hostname.includes('unsplash.com')) {
      u.searchParams.delete('w');
      u.searchParams.delete('h');
      u.searchParams.delete('crop');
      u.searchParams.delete('fit');
      u.searchParams.set('q', '100');
      return u.href;
    }
    if (u.hostname.includes('pexels.com')) {
      u.searchParams.delete('w');
      u.searchParams.delete('h');
      u.searchParams.delete('dpr');
      return u.href;
    }
  } catch (_) {}
  return url;
}

const BITRATE_MAP = {
  '2160p': 12000000,
  '1080p': 3500000,
  '720p': 2145000,
  '480p': 1050000,
  '360p': 600000,
  '240p': 350000,
};

function detectResolutionFromUrl(url) {
  const m = url.match(/(?:x|hd|_|-|\/)(2160|1080|720|480|360|240)(?:p|\/|\.|\?|_|-|$)/i);
  return m ? m[1] + 'p' : '';
}

async function expandHlsStreams(itemsList) {
  const expanded = [];
  const seenUrls = new Set();
  const dur = window._pageVideoDuration || 0;

  for (const it of itemsList) {
    if (it.kind !== 'hls') {
      if (!seenUrls.has(it.url)) {
        seenUrls.add(it.url);
        expanded.push(it);
      }
      continue;
    }

    // Try parsing master variants
    const variants = await getHlsVariants(it.url);
    if (variants && variants.length > 0) {
      for (const v of variants) {
        if (seenUrls.has(v.url)) continue;
        seenUrls.add(v.url);

        const pxLabel = v.label.includes('p') ? v.label : v.label + 'p';
        const estBytes = (v.bandwidth && dur > 0) ? Math.round((v.bandwidth / 8) * dur) : (BITRATE_MAP[pxLabel] && dur > 0 ? Math.round((BITRATE_MAP[pxLabel] / 8) * dur) : 0);

        const baseTitle = cleanStringForFilename(pageTitleVal) || 'Video';
        const customName = `${baseTitle}_${pxLabel}.mp4`;

        expanded.push({
          url: v.url,
          type: 'video',
          kind: 'hls',
          source: it.source || 'network',
          isVideo: true,
          _pixelLabel: pxLabel,
          _customName: customName,
          size: estBytes,
          duration: dur
        });
      }
    } else {
      // Direct variant playlist or master parse fallback
      if (seenUrls.has(it.url)) continue;
      seenUrls.add(it.url);

      let pxLabel = it._pixelLabel || detectResolutionFromUrl(it.url);
      if (!pxLabel && it.url.includes('x1080')) pxLabel = '1080p';
      if (!pxLabel && it.url.includes('x720')) pxLabel = '720p';
      if (!pxLabel && it.url.includes('x480')) pxLabel = '480p';
      if (!pxLabel && it.url.includes('x360')) pxLabel = '360p';
      if (!pxLabel) pxLabel = '720p';

      const bw = BITRATE_MAP[pxLabel] || 1500000;
      const estBytes = (dur > 0) ? Math.round((bw / 8) * dur) : 0;

      const baseTitle = cleanStringForFilename(pageTitleVal) || 'Video';
      const customName = `${baseTitle}_${pxLabel}.mp4`;

      expanded.push({
        ...it,
        _pixelLabel: pxLabel,
        _customName: it._customName || customName,
        size: it.size || estBytes,
        duration: dur
      });
    }
  }

  // Deduplicate items by resolution label if names match
  const finalItems = [];
  const seenPx = new Set();
  for (const item of expanded) {
    if (item.kind === 'hls' && item._pixelLabel) {
      const key = `${item._pixelLabel}_${item._customName}`;
      if (seenPx.has(key)) continue;
      seenPx.add(key);
    }
    finalItems.push(item);
  }

  return finalItems;
}

// ── Inbuilt Custom Video Preview Player Modal ──
let isPlayerSeeking = false;
let playerToastTimer = null;

function showPlayerToast(text) {
  const toast = $('playerToast');
  if (!toast) return;
  toast.textContent = text;
  toast.classList.remove('hidden');
  clearTimeout(playerToastTimer);
  playerToastTimer = setTimeout(() => {
    toast.classList.add('hidden');
  }, 1200);
}

function updateVolumeUI(player) {
  const volBtn = $('playerVolumeBtn');
  const slider = $('playerVolumeSlider');
  if (slider) slider.value = player.muted ? 0 : player.volume;
  if (volBtn) {
    if (player.muted || player.volume === 0) volBtn.textContent = '🔇';
    else if (player.volume < 0.5) volBtn.textContent = '🔉';
    else volBtn.textContent = '🔊';
  }
}

function formatPlayerTime(seconds) {
  if (!seconds || isNaN(seconds) || !isFinite(seconds) || seconds < 0) return '00:00';
  seconds = Math.floor(seconds);
  const hrs = Math.floor(seconds / 3600);
  const mins = Math.floor((seconds % 3600) / 60);
  const secs = seconds % 60;
  if (hrs > 0) {
    return `${hrs}:${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
  }
  return `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
}

function setupVideoModal() {
  const player = $('previewPlayer');
  const videoModal = $('videoModal');
  const closeBtn = $('closeVideoBtn');
  const playPauseBtn = $('playerPlayPauseBtn');
  const bigPlayBtn = $('playerBigPlayBtn');
  const rewindBtn = $('playerRewind20Btn');
  const forwardBtn = $('playerForward20Btn');
  const seekSlider = $('playerSeekSlider');
  const progressBar = $('playerProgressBar');
  const bufferBar = $('playerBufferBar');
  const timeDisplay = $('playerTimeDisplay');
  const volumeBtn = $('playerVolumeBtn');
  const volumeSlider = $('playerVolumeSlider');
  const speedSelect = $('playerSpeedSelect');
  const pipBtn = $('playerPipBtn');
  const fullscreenBtn = $('playerFullscreenBtn');
  const spinner = $('playerSpinner');
  const container = $('videoContainer');

  let lastVolume = 1;

  function closePlayer() {
    if (player) {
      player.pause();
      player.src = '';
    }
    const imgEl = $('previewImage');
    if (imgEl) { imgEl.src = ''; }
    const docEl = $('previewDoc');
    if (docEl) { docEl.src = ''; }
    if (videoModal) videoModal.classList.add('hidden');
  }

  if (closeBtn) closeBtn.onclick = closePlayer;

  const popoutBtn = $('popoutPlayerBtn');
  if (popoutBtn) {
    popoutBtn.onclick = () => {
      const cur = player ? player.currentTime || 0 : 0;
      closePlayer();
      openStandalonePlayer(currentPreviewUrl, currentPreviewFilename, currentPreviewItem?.type || 'video', cur);
    };
  }

  if (videoModal) {
    videoModal.onclick = (e) => {
      if (e.target === videoModal) closePlayer();
    };
  }

  function togglePlay() {
    if (!player) return;
    if (player.paused || player.ended) {
      player.play().catch(() => {});
    } else {
      player.pause();
    }
  }

  if (playPauseBtn) playPauseBtn.onclick = togglePlay;
  if (bigPlayBtn) bigPlayBtn.onclick = togglePlay;
  if (container) {
    container.onclick = (e) => {
      if (e.target === player || e.target === container || e.target === bigPlayBtn) {
        togglePlay();
      }
    };
    container.ondblclick = (e) => {
      if (e.target === player || e.target === container) {
        toggleFullscreen();
      }
    };
  }

  // Quick Seek buttons (+/- 20s)
  if (rewindBtn) {
    rewindBtn.onclick = (e) => {
      e.stopPropagation();
      player.currentTime = Math.max(0, player.currentTime - 20);
      showPlayerToast('⏪ -20s');
    };
  }

  if (forwardBtn) {
    forwardBtn.onclick = (e) => {
      e.stopPropagation();
      const dur = player.duration || 0;
      player.currentTime = Math.min(dur, player.currentTime + 20);
      showPlayerToast('+20s ⏩');
    };
  }

  // Timeline Scrubber
  if (seekSlider) {
    seekSlider.oninput = (e) => {
      isPlayerSeeking = true;
      const pct = parseFloat(e.target.value);
      if (progressBar) progressBar.style.width = pct + '%';
      if (player.duration) {
        const cur = (pct / 100) * player.duration;
        if (timeDisplay) timeDisplay.textContent = `${formatPlayerTime(cur)} / ${formatPlayerTime(player.duration)}`;
      }
    };

    seekSlider.onchange = (e) => {
      if (player.duration) {
        player.currentTime = (parseFloat(e.target.value) / 100) * player.duration;
      }
      isPlayerSeeking = false;
    };
  }

  // Volume & Mute
  if (volumeBtn) {
    volumeBtn.onclick = (e) => {
      e.stopPropagation();
      if (player.muted || player.volume === 0) {
        player.muted = false;
        player.volume = lastVolume > 0 ? lastVolume : 1;
        showPlayerToast(`Volume: ${Math.round(player.volume * 100)}%`);
      } else {
        lastVolume = player.volume;
        player.muted = true;
        showPlayerToast('Muted');
      }
      updateVolumeUI(player);
    };
  }

  if (volumeSlider) {
    volumeSlider.oninput = (e) => {
      const val = parseFloat(e.target.value);
      player.volume = val;
      player.muted = val === 0;
      if (val > 0) lastVolume = val;
      updateVolumeUI(player);
    };
  }

  // Playback Speed
  if (speedSelect) {
    speedSelect.onchange = (e) => {
      player.playbackRate = parseFloat(e.target.value);
      showPlayerToast(`Speed: ${e.target.value}x`);
    };
  }

  // Picture in picture
  if (pipBtn) {
    pipBtn.onclick = async (e) => {
      e.stopPropagation();
      try {
        if (document.pictureInPictureElement) {
          await document.exitPictureInPicture();
        } else if (document.pictureInPictureEnabled && player.readyState >= 1) {
          await player.requestPictureInPicture();
        }
      } catch (_) {}
    };
  }

  // Fullscreen
  function toggleFullscreen() {
    if (!document.fullscreenElement) {
      container.requestFullscreen?.().catch(() => {});
    } else {
      document.exitFullscreen?.().catch(() => {});
    }
  }

  if (fullscreenBtn) {
    fullscreenBtn.onclick = (e) => {
      e.stopPropagation();
      toggleFullscreen();
    };
  }

  // Video element events
  if (player) {
    player.onplay = () => {
      if (playPauseBtn) playPauseBtn.textContent = '⏸';
      if (bigPlayBtn) bigPlayBtn.classList.add('hidden');
    };

    player.onpause = () => {
      if (playPauseBtn) playPauseBtn.textContent = '▶';
      if (bigPlayBtn) bigPlayBtn.classList.remove('hidden');
    };

    player.onwaiting = () => {
      if (spinner) spinner.classList.remove('hidden');
    };

    player.onplaying = () => {
      if (spinner) spinner.classList.add('hidden');
    };

    player.oncanplay = () => {
      if (spinner) spinner.classList.add('hidden');
    };

    player.onseeking = () => {
      if (spinner) spinner.classList.remove('hidden');
    };

    player.onseeked = () => {
      if (spinner) spinner.classList.add('hidden');
    };

    player.ontimeupdate = () => {
      if (isPlayerSeeking) return;
      const cur = player.currentTime || 0;
      const dur = player.duration || 0;
      const pct = dur > 0 ? (cur / dur) * 100 : 0;
      if (progressBar) progressBar.style.width = pct + '%';
      if (seekSlider) seekSlider.value = pct;
      if (timeDisplay) {
        timeDisplay.textContent = `${formatPlayerTime(cur)} / ${formatPlayerTime(dur)}`;
      }

      if (bufferBar && player.buffered && player.buffered.length > 0 && dur > 0) {
        try {
          const bufferedEnd = player.buffered.end(player.buffered.length - 1);
          const bufPct = Math.min(100, (bufferedEnd / dur) * 100);
          bufferBar.style.width = bufPct + '%';
        } catch (_) {}
      }
    };

    player.onloadedmetadata = () => {
      if (timeDisplay) {
        timeDisplay.textContent = `${formatPlayerTime(player.currentTime)} / ${formatPlayerTime(player.duration)}`;
      }
    };

    player.onended = () => {
      if (playPauseBtn) playPauseBtn.textContent = '▶';
      if (bigPlayBtn) bigPlayBtn.classList.remove('hidden');
      if (progressBar) progressBar.style.width = '100%';
      if (seekSlider) seekSlider.value = 100;
    };
  }

  // Keyboard controls
  window.addEventListener('keydown', (e) => {
    if (!videoModal || videoModal.classList.contains('hidden')) return;
    if (e.target.tagName === 'INPUT' && e.target.type === 'text') return;

    if (e.code === 'Space') {
      e.preventDefault();
      togglePlay();
    } else if (e.code === 'ArrowLeft') {
      e.preventDefault();
      player.currentTime = Math.max(0, player.currentTime - (e.shiftKey ? 5 : 20));
      showPlayerToast(e.shiftKey ? '⏪ -5s' : '⏪ -20s');
    } else if (e.code === 'ArrowRight') {
      e.preventDefault();
      player.currentTime = Math.min(player.duration || 0, player.currentTime + (e.shiftKey ? 5 : 20));
      showPlayerToast(e.shiftKey ? '+5s ⏩' : '+20s ⏩');
    } else if (e.code === 'ArrowUp') {
      e.preventDefault();
      player.volume = Math.min(1, player.volume + 0.1);
      player.muted = false;
      updateVolumeUI(player);
      showPlayerToast(`Volume: ${Math.round(player.volume * 100)}%`);
    } else if (e.code === 'ArrowDown') {
      e.preventDefault();
      player.volume = Math.max(0, player.volume - 0.1);
      updateVolumeUI(player);
      showPlayerToast(`Volume: ${Math.round(player.volume * 100)}%`);
    } else if (e.key === 'm' || e.key === 'M') {
      e.preventDefault();
      player.muted = !player.muted;
      updateVolumeUI(player);
      showPlayerToast(player.muted ? 'Muted' : 'Unmuted');
    } else if (e.key === 'f' || e.key === 'F') {
      e.preventDefault();
      toggleFullscreen();
    } else if (e.key === 'Escape') {
      closePlayer();
    }
  });
}

function openMediaPreview(it, url, title) {
  currentPreviewItem = it;
  currentPreviewUrl = url;
  currentPreviewFilename = title || (it ? it._customName || fileName(it) : 'media');

  const type = it?.type || 'video';
  const isVideo = type === 'video' || it?.isVideo;
  const isAudio = type === 'audio' || it?.isAudio;
  const isImage = type === 'image';
  const isDoc = type === 'doc';

  const badgeIcon = isImage ? '🖼️' : isDoc ? '📄' : isAudio ? '🎵' : '🎬';
  const badgeDefaultTitle = isImage ? 'Image Preview' : isDoc ? 'Document Preview' : isAudio ? 'Audio Preview' : 'Video Preview';

  const iconBadge = document.querySelector('.video-icon-badge');
  if (iconBadge) iconBadge.textContent = badgeIcon;
  const videoTitleEl = $('videoTitle');
  if (videoTitleEl) videoTitleEl.textContent = title || badgeDefaultTitle;

  const player = $('previewPlayer');
  const videoModal = $('videoModal');
  const videoContainer = $('videoContainer');
  const imageContainer = $('imageContainer');
  const previewImage = $('previewImage');
  const docContainer = $('docContainer');
  const previewDoc = $('previewDoc');
  const previewDocFallback = $('previewDocFallback');
  const previewDocFallbackName = $('previewDocFallbackName');
  const controlsBar = document.querySelector('.player-controls-bar');
  const playerDlBtn = $('playerDownloadBtn');

  if (playerDlBtn) {
    playerDlBtn.disabled = false;
    playerDlBtn.textContent = '⬇ Download';
  }

  // Reset video player
  if (player) {
    player.pause();
    player.src = '';
  }

  if (isImage) {
    if (videoContainer) videoContainer.classList.add('hidden');
    if (controlsBar) controlsBar.classList.add('hidden');
    if (docContainer) docContainer.classList.add('hidden');
    if (imageContainer) imageContainer.classList.remove('hidden');
    if (previewImage) {
      previewImage.src = url;
    }
  } else if (isDoc) {
    if (videoContainer) videoContainer.classList.add('hidden');
    if (controlsBar) controlsBar.classList.add('hidden');
    if (imageContainer) imageContainer.classList.add('hidden');
    if (docContainer) docContainer.classList.remove('hidden');

    const isPdf = /\.pdf(\?|#|$)/i.test(url);
    if (isPdf && previewDoc) {
      previewDoc.src = url;
      previewDoc.classList.remove('hidden');
      if (previewDocFallback) previewDocFallback.classList.add('hidden');
    } else {
      if (previewDoc) previewDoc.classList.add('hidden');
      if (previewDocFallback) {
        previewDocFallback.classList.remove('hidden');
        if (previewDocFallbackName) previewDocFallbackName.textContent = currentPreviewFilename;
      }
    }
  } else {
    // Video or Audio
    if (imageContainer) imageContainer.classList.add('hidden');
    if (docContainer) docContainer.classList.add('hidden');
    if (videoContainer) videoContainer.classList.remove('hidden');
    if (controlsBar) controlsBar.classList.remove('hidden');

    const speedSelect = $('playerSpeedSelect');
    const timeDisplay = $('playerTimeDisplay');
    const progressBar = $('playerProgressBar');
    const bufferBar = $('playerBufferBar');
    const seekSlider = $('playerSeekSlider');

    if (speedSelect) speedSelect.value = '1';
    if (player) {
      player.playbackRate = 1;
      updateVolumeUI(player);
    }
    if (progressBar) progressBar.style.width = '0%';
    if (bufferBar) bufferBar.style.width = '0%';
    if (seekSlider) seekSlider.value = 0;
    if (player) {
      player.poster = it?.poster || it?.thumbnail || '';
      player.onerror = () => {
        const toast = $('playerToast');
        if (toast) {
          toast.textContent = '⚠️ Direct preview restricted. Use ↗ Tab or ⬇ Download.';
          toast.classList.remove('hidden');
          setTimeout(() => toast.classList.add('hidden'), 4000);
        }
      };

      chrome.runtime.sendMessage({
        type: 'PREPARE_PREVIEW',
        url,
        pageUrl: tabUrl || ''
      }).catch(() => {});

      player.src = url;
      player.play().catch(() => {});
    }
  }

  if (videoModal) videoModal.classList.remove('hidden');
}

const openVideoPreview = openMediaPreview;

function openStandalonePlayer(url, title, type = 'video', currentTime = 0) {
  if (!url) return;
  const playerUrl = chrome.runtime.getURL('player/player.html') +
    '?url=' + encodeURIComponent(url) +
    '&title=' + encodeURIComponent(title || 'Media Stream') +
    '&type=' + encodeURIComponent(type) +
    '&source=' + encodeURIComponent(tabUrl || '') +
    (currentTime > 0 ? '&t=' + encodeURIComponent(currentTime) : '');
  window.open(playerUrl, '_blank');
}

// ── Downloads Manager (ported from popup.js) ──
let currentDlFilter = 'today';
let currentDlCustomDate = '';
let currentDlQuery = '';
let dlSearchDebounce = null;

function setupDownloadsTab() {
  const clearBtn = $('clearDlHistoryBtn');
  if (clearBtn) {
    clearBtn.onclick = () => {
      if (confirm('Are you sure you want to clear your download history? This will erase historical records from the internal database.')) {
        chrome.runtime.sendMessage({ type: 'CLEAR_DOWNLOAD_HISTORY' }, () => {
          refreshDownloadsList();
        });
      }
    };
  }

  const exportBtn = $('exportDlHistoryBtn');
  if (exportBtn) {
    exportBtn.onclick = () => {
      chrome.runtime.sendMessage({ type: 'EXPORT_DOWNLOADS_FOR_CLOUD' }, (resp) => {
        if (!resp || !resp.records) {
          alert('No records available to export.');
          return;
        }
        const blob = new Blob([JSON.stringify(resp.records, null, 2)], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `media_extractor_downloads_export_${typeof DownloadDB !== 'undefined' && DownloadDB.getLocalIsoDate ? DownloadDB.getLocalIsoDate() : 'db'}.json`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        setTimeout(() => URL.revokeObjectURL(url), 10000);
      });
    };
  }

  // Setup Date Filter Pills
  const pills = document.querySelectorAll('.dl-filter-pill');
  const datePicker = $('dlCustomDateInput');

  pills.forEach((pill) => {
    pill.onclick = () => {
      pills.forEach(p => p.classList.remove('active'));
      pill.classList.add('active');

      const filter = pill.getAttribute('data-filter');
      currentDlFilter = filter;

      if (filter === 'custom') {
        if (datePicker) {
          datePicker.classList.remove('hidden');
          if (!datePicker.value) {
            const today = new Date().toISOString().split('T')[0];
            datePicker.value = today;
            currentDlCustomDate = today;
          } else {
            currentDlCustomDate = datePicker.value;
          }
        }
      } else {
        if (datePicker) datePicker.classList.add('hidden');
        currentDlCustomDate = '';
      }

      refreshDownloadsList();
    };
  });

  if (datePicker) {
    datePicker.onchange = (e) => {
      currentDlCustomDate = e.target.value;
      refreshDownloadsList();
    };
  }

  // Search input with debounce
  const searchInput = $('dlSearchInput');
  if (searchInput) {
    searchInput.oninput = (e) => {
      clearTimeout(dlSearchDebounce);
      dlSearchDebounce = setTimeout(() => {
        currentDlQuery = e.target.value;
        refreshDownloadsList();
      }, 200);
    };
  }
}

function formatTimeAgo(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  const now = Date.now();
  const diff = Math.floor((now - ts) / 1000);

  if (diff < 60) return 'Just now';
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;

  const timeStr = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const dateStr = d.toLocaleDateString([], { month: 'short', day: 'numeric', year: d.getFullYear() !== new Date().getFullYear() ? 'numeric' : undefined });
  return `${dateStr} · ${timeStr}`;
}

function refreshDownloadsList() {
  chrome.runtime.sendMessage({
    type: 'GET_DOWNLOADS',
    filter: currentDlFilter,
    date: currentDlCustomDate,
    query: currentDlQuery
  }, (resp) => {
    if (chrome.runtime.lastError || !resp) return;
    renderDownloadsUI(resp.active || [], resp.history || [], resp.stats || {});
  });
}

function renderDownloadsUI(activeList = [], historyList = [], stats = {}) {
  const activeWrap = $('activeDownloadsList');
  const completedWrap = $('completedDownloadsList');
  const activeBadge = $('activeDlCountBadge');
  const activeCountEl = $('activeDlCount');
  const completedCountEl = $('completedDlCount');
  const statsCountEl = $('dlStatsCount');
  const statsSizeEl = $('dlStatsSize');

  if (activeCountEl) activeCountEl.textContent = activeList.length;
  if (completedCountEl) completedCountEl.textContent = stats.totalCount !== undefined ? stats.totalCount : historyList.length;

  if (statsCountEl) {
    const count = stats.totalCount !== undefined ? stats.totalCount : historyList.length;
    statsCountEl.textContent = `Showing ${count} ${count === 1 ? 'file' : 'files'}`;
  }
  if (statsSizeEl) {
    const bytes = stats.totalBytes || historyList.reduce((acc, h) => acc + (h.totalBytes || 0), 0);
    statsSizeEl.textContent = bytes > 0 ? fmtSize(bytes) + ' total' : '0 MB total';
  }

  if (activeBadge) {
    if (activeList.length > 0) {
      activeBadge.textContent = activeList.length;
      activeBadge.classList.remove('hidden');
    } else {
      activeBadge.classList.add('hidden');
    }
  }

  // Render Active Downloads
  if (activeWrap) {
    if (!activeList.length) {
      activeWrap.innerHTML = '<div class="empty-dl-sub">No downloads currently in progress.</div>';
    } else {
      activeWrap.innerHTML = '';
      activeList.forEach((job) => {
        const card = document.createElement('div');
        card.className = 'dl-card active-job';
        const percent = Math.min(100, Math.max(0, Math.round(job.percent || 0)));
        const statusText = job.status || (job.state === 'saving' ? 'Saving file…' : `Downloading ${percent}%…`);
        const speedText = job.speedMBs ? `${job.speedMBs} MB/s` : '';
        const etaText = job.etaSeconds ? ` · ETA ${job.etaSeconds}s` : '';
        const typeBadge = (job.type || 'FILE').toUpperCase();

        card.innerHTML = `
          <div class="dl-card-head">
            <div class="dl-card-name-wrap">
              <span class="dl-card-icon">⚡</span>
              <span class="dl-card-name" title="${esc(job.filename)}">${esc(job.filename || 'Downloading media…')}</span>
            </div>
            <span class="badge-tag">${typeBadge}</span>
          </div>
          <div class="dl-card-bar-track">
            <div class="dl-card-bar-fill" style="width: ${percent}%"></div>
          </div>
          <div class="dl-card-meta">
            <div class="dl-meta-left">
              <span>${esc(statusText)}</span>
              <span>${speedText ? '· ' + speedText + etaText : ''}</span>
            </div>
            <div class="dl-card-actions">
              <button class="btn-dl-action danger cancel-job-btn" data-id="${job.id || ''}" data-dlid="${job.downloadId || ''}">✕ Cancel</button>
            </div>
          </div>
        `;

        card.querySelector('.cancel-job-btn').onclick = () => {
          chrome.runtime.sendMessage({
            type: 'CANCEL_DOWNLOAD_JOB',
            id: job.id,
            downloadId: job.downloadId
          }, () => {
            refreshDownloadsList();
          });
        };

        activeWrap.appendChild(card);
      });
    }
  }

  // Render Completed History
  if (completedWrap) {
    if (!historyList.length) {
      const filterLabel = currentDlFilter === 'today' ? 'today' : currentDlFilter === 'yesterday' ? 'yesterday' : 'the selected filter';
      completedWrap.innerHTML = `<div class="empty-dl-sub">No completed downloads found for ${filterLabel}.</div>`;
    } else {
      completedWrap.innerHTML = '';
      historyList.forEach((item) => {
        const card = document.createElement('div');
        card.className = 'dl-card';
        const isInterrupted = item.state === 'interrupted' || item.error;
        const icon = isInterrupted ? '⚠️' : '✓';
        const statusBadge = isInterrupted
          ? `<span class="status-msg err" style="margin:0;font-size:10px">${esc(item.error || 'Interrupted')}</span>`
          : `<span class="status-msg ok" style="margin:0;font-size:10px">Completed ${item.totalBytes ? '· ' + fmtSize(item.totalBytes) : ''}</span>`;
        const timeAgo = formatTimeAgo(item.completedAt || item.startTime);
        const savePathDisplay = item.savePath || ('Saved to Downloads: ' + item.filename);

        card.innerHTML = `
          <div class="dl-card-head">
            <div class="dl-card-name-wrap">
              <span class="dl-card-icon">${icon}</span>
              <span class="dl-card-name" title="${esc(item.filename)}">${esc(item.filename)}</span>
            </div>
            <span class="badge-tag">${(item.type || 'FILE').toUpperCase()}</span>
          </div>
          <div class="dl-card-meta">
            <div class="dl-meta-left">
              ${statusBadge}
              <span>· ${timeAgo}</span>
            </div>
            <div class="dl-card-actions">
              ${!isInterrupted && item.downloadId ? `<button class="btn-dl-action folder-btn" title="Open Location (Show in folder)">📁 Open Location</button>` : ''}
              ${!isInterrupted && item.downloadId ? `<button class="btn-dl-action open-btn" title="Open downloaded file directly">▶ Open</button>` : ''}
              <button class="btn-dl-action erase-btn" title="Remove from history">🗑</button>
            </div>
          </div>
          <!-- Saved Location Footer -->
          <div class="dl-location-bar" title="Exact save location on disk: ${esc(savePathDisplay)}">
            <div class="dl-location-left">
              <span class="dl-location-icon">📂</span>
              <span class="dl-location-text">${esc(savePathDisplay)}</span>
            </div>
            <button class="dl-location-copy-btn copy-path-btn" title="Copy file path to clipboard">📋</button>
          </div>
        `;

        if (!isInterrupted && item.downloadId) {
          const folderBtn = card.querySelector('.folder-btn');
          if (folderBtn) {
            folderBtn.onclick = () => {
              chrome.runtime.sendMessage({ type: 'SHOW_DOWNLOAD_ITEM', downloadId: item.downloadId }, (resp) => {
                if (resp && resp.error) alert('Could not show file: ' + resp.error);
              });
            };
          }

          const openBtn = card.querySelector('.open-btn');
          if (openBtn) {
            openBtn.onclick = () => {
              chrome.runtime.sendMessage({ type: 'OPEN_DOWNLOAD_ITEM', downloadId: item.downloadId }, (resp) => {
                if (resp && resp.error) alert('Could not open file: ' + resp.error);
              });
            };
          }
        }

        const copyBtn = card.querySelector('.copy-path-btn');
        if (copyBtn) {
          copyBtn.onclick = () => {
            const pathToCopy = item.savePath || item.filename;
            navigator.clipboard.writeText(pathToCopy).then(() => {
              copyBtn.textContent = '✓';
              setTimeout(() => { copyBtn.textContent = '📋'; }, 1500);
            }).catch(() => {
              prompt('Copy file location:', pathToCopy);
            });
          };
        }

        const eraseBtn = card.querySelector('.erase-btn');
        if (eraseBtn) {
          eraseBtn.onclick = () => {
            chrome.runtime.sendMessage({ type: 'ERASE_DOWNLOAD_ITEM', id: item.id, downloadId: item.downloadId }, () => {
              refreshDownloadsList();
            });
          };
        }

        completedWrap.appendChild(card);
      });
    }
  }
}
