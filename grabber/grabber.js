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
  const j = m && m.id && muxJobs[m.id];
  if (!j) return;
  if (m.type === 'MUX_PROGRESS') {
    const prefix = m.id.startsWith('dl_') ? 'Fetching ' : 'Muxing ';
    if (j.btn) {
      j.btn.disabled = true;
      j.btn.textContent = prefix + Math.round(m.percent) + '%';
    }
    j.setMsg(prefix + Math.round(m.percent) + '%', true);
  } else if (m.type === 'MUX_DONE') {
    if (m.error) {
      j.setMsg(m.error, false);
      resetBtn(j.btn);
    } else {
      const details = m.segments ? ` (${m.segments} segs)` : '';
      j.setMsg(`✓ ${m.file || 'saved'}${details}`, true);
      if (j.btn) {
        j.btn.disabled = false;
        j.btn.textContent = '✓ Saved';
      }
    }
    delete muxJobs[m.id];
  }
});

const $ = (id) => document.getElementById(id);

document.addEventListener('DOMContentLoaded', init);

function init() {
  $('pageUrl').textContent = pageUrlParam;

  document.querySelectorAll('.tab').forEach((t) => {
    t.onclick = () => {
      document.querySelectorAll('.tab').forEach((x) => x.classList.remove('active'));
      t.classList.add('active');
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

  setupBulkModal();
  setupVideoModal();
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
  if (it.type) return it.type === 'image' ? 'image' : it.type === 'audio' ? 'audio' : it.type === 'doc' ? 'doc' : 'video';
  if (it.isAudio) return 'audio';
  if (it.isVideo) return 'video';
  return 'doc';
}

function updateCounts() {
  $('c-all').textContent = items.length;
  ['video', 'image', 'audio', 'doc'].forEach((c) => {
    $('c-' + c).textContent = items.filter((it) => catOf(it) === c).length;
  });
}

function populateFilterDropdown() {
  const select = $('filterType');
  const prevVal = select.value;
  select.innerHTML = '<option value="all">All Formats</option>';
  
  const list = items.filter((it) => activeCat === 'all' || catOf(it) === activeCat);
  const formats = new Set();
  list.forEach(it => {
    const f = it.kind === 'hls' ? 'm3u8' : it.kind === 'dash' ? 'mpd' : ext(it.url) || it.type;
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

function render() {
  const grid = $('grid');
  grid.innerHTML = '';
  
  let list = items.filter((it) => activeCat === 'all' || catOf(it) === activeCat);
  
  const filterVal = $('filterType').value;
  if (filterVal !== 'all') {
    list = list.filter(it => {
      const f = it.kind === 'hls' ? 'm3u8' : it.kind === 'dash' ? 'mpd' : ext(it.url) || it.type;
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
  
  const sortByVal = $('sortBy').value;
  const sortOrderVal = $('sortOrder').value;
  
  if (sortByVal !== 'default') {
    list.sort((a, b) => {
      let valA, valB;
      if (sortByVal === 'name') {
        valA = fileName(a).toLowerCase();
        valB = fileName(b).toLowerCase();
        return valA.localeCompare(valB);
      } else if (sortByVal === 'size') {
        valA = a.size || 0;
        valB = b.size || 0;
        return valA - valB;
      } else if (sortByVal === 'type') {
        valA = (a.kind === 'hls' ? 'm3u8' : a.kind === 'dash' ? 'mpd' : ext(a.url) || a.type).toLowerCase();
        valB = (b.kind === 'hls' ? 'm3u8' : b.kind === 'dash' ? 'mpd' : ext(b.url) || b.type).toLowerCase();
        return valA.localeCompare(valB);
      }
      return 0;
    });
    
    if (sortOrderVal === 'desc') {
      list.reverse();
    }
  }
  
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

  const badge = it.kind === 'hls' ? 'HLS' : it.kind === 'dash' ? 'DASH' : (ext(downloadUrl) || it.type).toUpperCase();
  const preview = it.type === 'image'
    ? `<img class="thumb" src="${esc(downloadUrl)}" loading="lazy" referrerpolicy="no-referrer">`
    : `<div class="thumb icon">${it.type === 'audio' ? '🎵' : it.type === 'doc' ? '📄' : '🎬'}</div>`;
  
  let sizeVal = it.size ? fmtSize(it.size) : '';
  if (!sizeVal && (it.type === 'video' || it.kind === 'hls' || it.isVideo)) {
    const px = it._pixelLabel || detectResolutionFromUrl(it.url) || '720p';
    const bw = BITRATE_MAP[px] || 1800000;
    const dur = it.duration || window._pageVideoDuration || 1800;
    const estBytes = Math.round((bw / 8) * dur);
    it.size = estBytes;
    sizeVal = fmtSize(estBytes);
  }
  const sizeText = sizeVal ? ` · ${sizeVal}` : '';
  const bufferLabel = (it.kind === 'hls' || it.kind === 'dash') ? ' · Buffered' : '';
  const pixelBadge = it._pixelLabel ? `<span class="kbadge" style="background:#065f46; color:#a7f3d0;">${esc(it._pixelLabel)}</span>` : '';

  div.innerHTML = `
    ${preview}
    <div class="info">
      <div class="name" title="Click to rename" data-idx="${idx}">${esc(name)}</div>
      <div class="sub">
        <span class="kbadge">${badge}</span>
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
      ${(it.type === 'video' || it.isVideo) ? '<button class="btn btn-ghost preview-btn" style="flex: initial;">👁 Preview</button>' : ''}
      <button class="btn btn-primary dl">⬇ Download</button>
      <button class="btn btn-ghost copy" style="flex: initial;">Copy URL</button>
    </div>
    <div class="cstatus"></div>`;

  // Parse HLS master playlists for resolution (pixels), variants, and estimated size
  if (it.kind === 'hls' && !it._parsedHls) {
    it._parsedHls = true;
    getHlsVariants(downloadUrl).then(variants => {
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

        const dur = it.duration || window._pageVideoDuration || 0;
        if (topVariant.bandwidth && dur > 0) {
          const estSize = Math.round((topVariant.bandwidth / 8) * dur);
          it.size = estSize;
          const sizeEl = div.querySelector('.res-size');
          if (sizeEl) sizeEl.textContent = ' · ~' + fmtSize(estSize);
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
            const vEst = (v.bandwidth && dur > 0) ? ` · ~${fmtSize(Math.round((v.bandwidth / 8) * dur))}` : '';
            opt.textContent = `${v.label} (${Math.round(v.bandwidth / 1000)}k${vEst})`;
            sel.appendChild(opt);
          });

          sel.onchange = () => {
            const chosen = variants.find(v => v.url === sel.value);
            if (chosen && chosen.bandwidth && dur > 0) {
              const estSize = Math.round((chosen.bandwidth / 8) * dur);
              it.size = estSize;
              const sizeEl = div.querySelector('.res-size');
              if (sizeEl) sizeEl.textContent = ' · ~' + fmtSize(estSize);
            }
          };
        }
      }
    });
  }

  // Fetch size asynchronously if missing
  if (!it.size && !it._fetchingSize && it.kind !== 'hls') {
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
  if (btn) { btn.disabled = true; btn.textContent = '⟳ …'; }
  const setMsg = (m, ok) => { if (statusEl) { statusEl.textContent = m; statusEl.className = 'cstatus ' + (ok ? 'ok' : 'err'); } };
  const filename = customFilename || fileName(it);

  if (it.kind === 'dash') { setMsg('DASH needs the backend (yt-dlp) helper', false); resetBtn(btn); return; }
  
  if (it.kind === 'hls') {
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
    pageUrl: pageUrlParam
  }, (res) => {
    if (chrome.runtime.lastError || !res || !res.ok) {
      const id = 'dl_' + Math.random().toString(36).slice(2);
      muxJobs[id] = { btn, setMsg };
      chrome.runtime.sendMessage({ type: 'DOWNLOAD_PARALLEL', id, url: it.url, filename });
    } else {
      setMsg('✓ Downloaded', true);
      if (btn) { btn.disabled = false; btn.textContent = '✓ Done'; }
    }
  });
}

// ── Inbuilt Video Preview Player Modal ──
function setupVideoModal() {
  $('closeVideoBtn').onclick = () => {
    const player = $('previewPlayer');
    player.pause();
    player.src = '';
    $('videoModal').classList.add('hidden');
  };
}

function openVideoPreview(it, url, title) {
  $('videoTitle').textContent = title || 'Video Preview';
  const player = $('previewPlayer');
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
      const f = it.kind === 'hls' ? 'm3u8' : it.kind === 'dash' ? 'mpd' : ext(it.url) || it.type;
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

  if (typeof ZipBuilder === 'undefined') {
    alert('ZIP builder library loading error. Falling back to individual downloads.');
    downloadAllInCatIndividual();
    btn.disabled = false;
    return;
  }

  const zip = new ZipBuilder();
  let completed = 0;

  for (let i = 0; i < list.length; i++) {
    const it = list[i];
    const targetUrl = it.type === 'image' ? getHighResImageUrl(it.url) : it.url;
    const fname = it._customName || fileName({ ...it, url: targetUrl }, i);

    btn.textContent = `Zipping ${i + 1}/${list.length}…`;

    try {
      const res = await new Promise((resolve) => {
        chrome.runtime.sendMessage({ type: 'FETCH_BLOB_ARRAY', url: targetUrl }, resolve);
      });

      if (res && res.ok && res.bytes) {
        const uint8 = new Uint8Array(res.bytes);
        zip.addFile(fname, uint8);
        completed++;
      }
    } catch (_) {}
  }

  if (completed === 0) {
    alert('Could not fetch media files for zipping. Downloading individually instead.');
    downloadAllInCatIndividual();
    btn.disabled = false;
    render();
    return;
  }

  btn.textContent = 'Generating ZIP…';
  const zipBlob = zip.build();
  const zipUrl = URL.createObjectURL(zipBlob);

  const cleanTitle = (pageTitleVal || 'Media_Collection').replace(/[^a-zA-Z0-9_\-]/g, '_').slice(0, 40);
  const zipFilename = `${cleanTitle}_Media_Collection.zip`;

  chrome.downloads.download({
    url: zipUrl,
    filename: zipFilename,
    saveAs: false
  }, () => {
    btn.disabled = false;
    btn.textContent = '✓ ZIP Saved';
    setTimeout(() => { render(); }, 3000);
    setTimeout(() => URL.revokeObjectURL(zipUrl), 60000);
  });
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
function ext(u) { const m = (u.split('?')[0].match(/\.([a-z0-9]{2,5})$/i)); return m ? m[1].toLowerCase() : ''; }

const GENERIC_FILENAME_RE = /^(manifest|master|playlist|index|stream|video|audio|init|output|file|media|segment|chunk|download|[a-z0-9]{4,14})$/i;

function cleanStringForFilename(str) {
  if (!str) return '';
  return str
    .replace(/\s*-\s*(Dailymotion|YouTube|Vimeo|Twitter|Instagram|TikTok|X)$/i, '')
    .replace(/[\\/:*?"<>|]/g, '_')
    .replace(/\s+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 100);
}

function fileName(it, index = 0) {
  if (it._customName) return it._customName;

  const e = (it.kind === 'hls' || it.kind === 'dash')
    ? 'mp4'
    : (ext(it.url) || (it.type === 'image' ? 'jpg' : it.type === 'audio' ? 'mp3' : 'mp4'));

  // 1. Try item metadata title if present
  if (it.metaTitle || it.title) {
    const cleaned = cleanStringForFilename(it.metaTitle || it.title);
    if (cleaned && cleaned.length > 3 && !GENERIC_FILENAME_RE.test(cleaned)) {
      return `${cleaned}.${e}`;
    }
  }

  // 2. Try page title for video/audio streams or main media
  if (pageTitleVal) {
    const cleaned = cleanStringForFilename(pageTitleVal);
    if (cleaned && cleaned.length > 3) {
      if (it.type === 'video' || it.kind === 'hls' || it.kind === 'dash' || it.isVideo) {
        return `${cleaned}.${e}`;
      }
      return `${cleaned}_${it.type || 'item'}_${index + 1}.${e}`;
    }
  }

  // 3. Fallback to URL pathname if not generic
  try {
    const base = decodeURIComponent(new URL(it.url).pathname.split('/').pop() || '');
    const baseWithoutExt = base.replace(/\.[^/.]+$/, '');
    if (baseWithoutExt && !GENERIC_FILENAME_RE.test(baseWithoutExt) && !/^[a-f0-9]{16,}$/i.test(baseWithoutExt)) {
      return base;
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
