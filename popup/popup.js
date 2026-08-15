// Popup logic for Media Extractor PRO
let SERVER = 'http://127.0.0.1:8787';
let API_KEY = '';
let ENGINE_MODEL = 'auto'; // 'auto' | 'browser' | 'backend'
let CONFIRM_NAME = false;
let activeTabId = null;
let pageUrl = '';
let pageTitleVal = '';
let activeCat = 'all';
let fetchedItems = [];
let searchQuery = '';
let pollTimer = null;
const activeMuxJobs = {}; // job_id -> { btn, card }

const $ = (id) => document.getElementById(id);

// Real-time HLS Muxing Progress Listener from Offscreen Muxer
chrome.runtime.onMessage.addListener((m) => {
  if (!m || !m.id || !activeMuxJobs[m.id]) return;
  const j = activeMuxJobs[m.id];
  if (m.type === 'MUX_PROGRESS') {
    const prefix = m.id.startsWith('dl_') ? 'Fetching ' : 'Muxing ';
    if (j.btn) {
      j.btn.disabled = true;
      j.btn.textContent = prefix + Math.round(m.percent) + '%';
    }
  } else if (m.type === 'MUX_DONE') {
    if (m.error) {
      if (j.btn) { j.btn.disabled = false; j.btn.textContent = 'Err'; }
    } else {
      if (j.btn) { j.btn.disabled = false; j.btn.textContent = '✓ Saved'; }
    }
    delete activeMuxJobs[m.id];
  }
});

document.addEventListener('DOMContentLoaded', init);

async function init() {
  // Load settings from storage
  const stored = await chrome.storage.local.get(['backendUrl', 'apiKey', 'engineModel', 'confirmName']);
  if (stored.backendUrl) SERVER = stored.backendUrl;
  if (stored.apiKey) API_KEY = stored.apiKey;
  if (stored.engineModel) ENGINE_MODEL = stored.engineModel;
  if (typeof stored.confirmName === 'boolean') CONFIRM_NAME = stored.confirmName;

  $('serverUrlInput').value = SERVER;
  $('apiKeyInput').value = API_KEY;
  $('engineModelSelect').value = ENGINE_MODEL;
  $('confirmNameToggle').checked = CONFIRM_NAME;

  setupNavTabs();
  setupAdBlockerToggle();
  setupSettingsHandlers();
  setupPopoutButton();
  setupBulkModal();
  setupVideoModal();

  // Search input handler
  $('searchInput').oninput = (e) => {
    searchQuery = e.target.value.toLowerCase().trim();
    renderResourceGrid();
  };

  // Query active tab
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab) {
    activeTabId = tab.id;
    pageUrl = tab.url || '';
    pageTitleVal = tab.title || pageUrl;
    $('pageTitle').textContent = pageTitleVal;
    $('pageTitle').title = pageUrl;
  }

  const isWeb = /^https?:\/\//i.test(pageUrl);
  if (!isWeb) {
    $('badPage').classList.remove('hidden');
    $('resourceGrid').innerHTML = '<div class="empty-state">Open a web page to extract media.</div>';
  } else {
    // Start in-popup scan immediately
    scanCurrentPage();
  }

  // Check helper server health
  checkServerHealth(isWeb);

  $('refreshScan').onclick = scanCurrentPage;
  $('clearList').onclick = clearCurrentList;
  $('formatFilter').onchange = renderResourceGrid;
}

// ── Nav Tabs Switcher ──
function setupNavTabs() {
  document.querySelectorAll('.nav-tab').forEach((tabBtn) => {
    tabBtn.onclick = () => {
      document.querySelectorAll('.nav-tab').forEach((t) => t.classList.remove('active'));
      document.querySelectorAll('.tab-content').forEach((c) => c.classList.remove('active'));
      tabBtn.classList.add('active');
      const targetId = tabBtn.dataset.tab;
      const targetContent = $(targetId);
      if (targetContent) targetContent.classList.add('active');
    };
  });

  document.querySelectorAll('.cat-btn').forEach((btn) => {
    btn.onclick = () => {
      document.querySelectorAll('.cat-btn').forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      activeCat = btn.dataset.cat;
      populateFormatDropdown();
      renderResourceGrid();
    };
  });
}

// ── In-Popup Scanner ──
async function scanCurrentPage() {
  if (!activeTabId) return;
  $('resourceGrid').innerHTML = '<div class="loading-state">Scanning current tab...</div>';

  // Probe active page video duration to calculate HLS stream size accurately
  try {
    const res = await chrome.scripting.executeScript({
      target: { tabId: activeTabId },
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

  chrome.runtime.sendMessage({ type: 'SCAN_TAB', tabId: activeTabId }, async (resp) => {
    if (chrome.runtime.lastError || !resp || !resp.ok) {
      $('resourceGrid').innerHTML = '<div class="empty-state">Could not scan this page. Try reloading the tab.</div>';
      return;
    }

    // Filter out raw .m4s segment spam
    const rawItems = (resp.items || []).filter(it => !/\.m4s(\?|#|$)/i.test(it.url) && !/\/frag\(\d+\)/i.test(it.url));
    
    // Expand HLS streams into separate resolution cards (1080p, 720p, 480p, 360p) with estimated sizes
    fetchedItems = await expandHlsStreams(rawItems);
    updateCategoryCounts();
    populateFormatDropdown();
    renderResourceGrid();
  });
}

function clearCurrentList() {
  fetchedItems = [];
  if (activeTabId) {
    chrome.runtime.sendMessage({ type: 'CLEAR_TAB_MEDIA', tabId: activeTabId });
  }
  updateCategoryCounts();
  populateFormatDropdown();
  renderResourceGrid();
}

function catOf(it) {
  if (it.type) return it.type === 'image' ? 'image' : it.type === 'audio' ? 'audio' : it.type === 'doc' ? 'doc' : 'video';
  if (it.isAudio) return 'audio';
  if (it.isVideo) return 'video';
  return 'doc';
}

function updateCategoryCounts() {
  $('c-all').textContent = fetchedItems.length;
  const badgeEl = $('headerCountBadge');
  if (badgeEl) badgeEl.textContent = `${fetchedItems.length} Found`;
  ['video', 'image', 'audio', 'doc'].forEach((c) => {
    const el = $('c-' + c);
    if (el) el.textContent = fetchedItems.filter((it) => catOf(it) === c).length;
  });
}

function populateFormatDropdown() {
  const select = $('formatFilter');
  const prevVal = select.value;
  select.innerHTML = '<option value="all">All Formats</option>';

  const filteredList = fetchedItems.filter((it) => activeCat === 'all' || catOf(it) === activeCat);
  const formats = new Set();
  filteredList.forEach((it) => {
    const f = it.kind === 'hls' ? 'm3u8' : it.kind === 'dash' ? 'mpd' : getExt(it.url) || it.type;
    if (f) formats.add(f.toLowerCase());
  });

  [...formats].sort().forEach((f) => {
    const opt = document.createElement('option');
    opt.value = f;
    opt.textContent = f.toUpperCase();
    select.appendChild(opt);
  });

  if ([...select.options].some((o) => o.value === prevVal)) {
    select.value = prevVal;
  } else {
    select.value = 'all';
  }
}

function renderResourceGrid() {
  const grid = $('resourceGrid');
  grid.innerHTML = '';

  let list = fetchedItems.filter((it) => activeCat === 'all' || catOf(it) === activeCat);

  const selectedFormat = $('formatFilter').value;
  if (selectedFormat !== 'all') {
    list = list.filter((it) => {
      const f = it.kind === 'hls' ? 'm3u8' : it.kind === 'dash' ? 'mpd' : getExt(it.url) || it.type;
      return f.toLowerCase() === selectedFormat;
    });
  }

  // Filter by Live Search Query
  if (searchQuery) {
    list = list.filter((it) => {
      const name = (it._customName || getItemFileName(it)).toLowerCase();
      const url = (it.url || '').toLowerCase();
      const format = (it.kind || it.type || '').toLowerCase();
      const pixels = (it._pixelLabel || '').toLowerCase();
      return name.includes(searchQuery) || url.includes(searchQuery) || format.includes(searchQuery) || pixels.includes(searchQuery);
    });
  }

  if (!list.length) {
    grid.innerHTML = '<div class="empty-state">No matching media resources found.</div>';
    return;
  }

  list.forEach((it, idx) => {
    grid.appendChild(createResourceCard(it, idx));
  });
}

function createResourceCard(it, idx) {
  const card = document.createElement('div');
  card.className = 'resource-card';

  let downloadUrl = it.url;
  if (it.type === 'image') {
    downloadUrl = getHighResUrl(it.url);
  }

  // Smart Metadata Naming
  const filename = it._customName || getItemFileName({ ...it, url: downloadUrl }, idx);
  it._customName = filename;

  const formatBadge = it.kind === 'hls' ? 'HLS' : it.kind === 'dash' ? 'DASH' : (getExt(downloadUrl) || it.type).toUpperCase();
  
  let sizeBadge = it.size ? fmtSize(it.size) : '';
  if (!sizeBadge && (it.type === 'video' || it.kind === 'hls' || it.isVideo)) {
    const px = it._pixelLabel || detectResolutionFromUrl(it.url) || '720p';
    const bw = BITRATE_MAP[px] || 1800000;
    const dur = it.duration || window._pageVideoDuration || 1800;
    const estBytes = Math.round((bw / 8) * dur);
    it.size = estBytes;
    sizeBadge = fmtSize(estBytes);
  }

  const preview = it.type === 'image'
    ? `<img class="res-thumb" src="${escUrl(downloadUrl)}" loading="lazy" referrerpolicy="no-referrer">`
    : `<div class="res-thumb">${it.type === 'audio' ? '🎵' : it.type === 'doc' ? '📄' : '🎬'}</div>`;

  const pixelBadge = it._pixelLabel ? `<span class="badge-pixel">${escUrl(it._pixelLabel)}</span>` : '';

  card.innerHTML = `
    ${preview}
    <div class="res-info">
      <div class="res-name" title="Click to rename" data-idx="${idx}">${escUrl(filename)}</div>
      <div class="res-sub">
        <span class="badge-tag">${formatBadge}</span>
        ${pixelBadge}
        <span class="res-size">${sizeBadge ? '· ' + sizeBadge : ''}</span>
      </div>
      <div class="selector-wrap hidden mt-1" style="width: 100%;">
        <select class="res-select form-select" style="padding: 2px 4px; font-size: 10px;"></select>
      </div>
    </div>
    <div class="res-actions">
      ${(it.type === 'video' || it.isVideo) ? '<button class="btn-preview-mini preview-btn">👁 Preview</button>' : ''}
      <button class="btn-dl-mini dl-btn">⬇ Download</button>
    </div>
  `;

  // Parse HLS master playlists for resolution (pixels), variants, and estimated size
  if (it.kind === 'hls' && !it._parsedHls) {
    it._parsedHls = true;
    getHlsVariants(downloadUrl).then(variants => {
      if (variants && variants.length > 0) {
        it._variants = variants;
        const topVariant = variants[0];
        if (topVariant && topVariant.label) {
          it._pixelLabel = topVariant.label.includes('p') ? topVariant.label : topVariant.label + 'p';
          const subDiv = card.querySelector('.res-sub');
          if (subDiv && !subDiv.querySelector('.badge-pixel')) {
            const span = document.createElement('span');
            span.className = 'badge-pixel';
            span.textContent = it._pixelLabel;
            subDiv.appendChild(span);
          }
        }

        const dur = it.duration || window._pageVideoDuration || 0;
        if (topVariant.bandwidth && dur > 0) {
          const estSize = Math.round((topVariant.bandwidth / 8) * dur);
          it.size = estSize;
          const sizeEl = card.querySelector('.res-size');
          if (sizeEl) sizeEl.textContent = '· ~' + fmtSize(estSize);
        }

        // Show dropdown ONLY if multiple variants exist
        const wrap = card.querySelector('.selector-wrap');
        const sel = card.querySelector('.res-select');
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
              const sizeEl = card.querySelector('.res-size');
              if (sizeEl) sizeEl.textContent = '· ~' + fmtSize(estSize);
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
        const sizeEl = card.querySelector('.res-size');
        if (sizeEl) sizeEl.textContent = '· ' + fmtSize(res.size);
      }
    });
  }

  // Editable filename click handler
  const nameEl = card.querySelector('.res-name');
  nameEl.onclick = () => {
    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'res-name-input';
    input.value = it._customName;
    nameEl.replaceWith(input);
    input.focus();

    const saveName = () => {
      const val = input.value.trim() || filename;
      it._customName = val;
      renderResourceGrid();
    };

    input.onblur = saveName;
    input.onkeydown = (e) => { if (e.key === 'Enter') saveName(); };
  };

  // Preview button click
  const previewBtn = card.querySelector('.preview-btn');
  if (previewBtn) {
    previewBtn.onclick = () => openVideoPreview(it, downloadUrl, filename);
  }

  const dlBtn = card.querySelector('.dl-btn');
  dlBtn.onclick = () => {
    const sel = card.querySelector('.res-select');
    let targetUrl = downloadUrl;
    if (sel && sel.value) targetUrl = sel.value;
    downloadItem(it, targetUrl, it._customName, dlBtn);
  };

  return card;
}

function downloadItem(it, downloadUrl, filename, btn) {
  if (CONFIRM_NAME) {
    const prompted = prompt('Confirm file name before download:', filename);
    if (prompted === null) return;
    if (prompted.trim()) filename = prompted.trim();
  }

  btn.disabled = true;
  btn.textContent = '⟳ …';

  if (it.kind === 'hls') {
    const id = 'mux_' + Math.random().toString(36).slice(2);
    activeMuxJobs[id] = { btn };
    btn.textContent = 'Fetching 0%…';
    chrome.runtime.sendMessage({ type: 'MUX_HLS', id, url: downloadUrl, filename });
    return;
  }

  // Direct download via SW
  chrome.runtime.sendMessage({
    type: 'DOWNLOAD_STREAM',
    url: downloadUrl,
    filename: filename,
    pageUrl: pageUrl
  }, (resp) => {
    btn.disabled = false;
    if (resp && resp.ok) {
      btn.textContent = '✓ Saved';
    } else {
      btn.textContent = 'Err';
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
  $('bulkDownload').onclick = () => {
    const visibleList = getVisibleList();
    if (!visibleList.length) return;
    $('bulkCount').textContent = visibleList.length;
    $('bulkModal').classList.remove('hidden');
  };

  $('cancelModalBtn').onclick = () => {
    $('bulkModal').classList.add('hidden');
  };

  $('dlZipBtn').onclick = () => {
    $('bulkModal').classList.add('hidden');
    startZipBulkDownload();
  };

  $('dlIndivBtn').onclick = () => {
    $('bulkModal').classList.add('hidden');
    downloadAllInViewIndividual();
  };
}

function getVisibleList() {
  let list = fetchedItems.filter((it) => activeCat === 'all' || catOf(it) === activeCat);
  const selectedFormat = $('formatFilter').value;
  if (selectedFormat !== 'all') {
    list = list.filter((it) => {
      const f = it.kind === 'hls' ? 'm3u8' : it.kind === 'dash' ? 'mpd' : getExt(it.url) || it.type;
      return f.toLowerCase() === selectedFormat;
    });
  }
  if (searchQuery) {
    list = list.filter((it) => {
      const name = (it._customName || getItemFileName(it)).toLowerCase();
      const url = (it.url || '').toLowerCase();
      return name.includes(searchQuery) || url.includes(searchQuery);
    });
  }
  return list;
}

async function startZipBulkDownload() {
  const list = getVisibleList();
  if (!list.length) return;

  const btn = $('bulkDownload');
  btn.disabled = true;

  if (typeof ZipBuilder === 'undefined') {
    alert('ZIP builder library loading error. Falling back to individual downloads.');
    downloadAllInViewIndividual();
    btn.disabled = false;
    return;
  }

  const zip = new ZipBuilder();
  let completed = 0;

  for (let i = 0; i < list.length; i++) {
    const it = list[i];
    const targetUrl = it.type === 'image' ? getHighResUrl(it.url) : it.url;
    const fname = it._customName || getItemFileName({ ...it, url: targetUrl }, i);

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
    downloadAllInViewIndividual();
    btn.disabled = false;
    btn.textContent = '⬇ Download View';
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
    setTimeout(() => { btn.textContent = '⬇ Download View'; }, 3000);
    setTimeout(() => URL.revokeObjectURL(zipUrl), 60000);
  });
}

async function downloadAllInViewIndividual() {
  const buttons = document.querySelectorAll('#resourceGrid .dl-btn');
  for (const btn of buttons) {
    btn.click();
    await new Promise((r) => setTimeout(r, 300));
  }
}

// ── 1-Click Engine (yt-dlp helper) ──
async function checkServerHealth(isWeb) {
  const health = isWeb ? await fetchJSON('/health').catch(() => null) : null;
  if (health && health.ok) {
    $('serverSection').classList.remove('hidden');
    $('serverHint').classList.add('hidden');
    $('serverState').textContent = health.ffmpeg ? '● helper connected' : '● helper (no ffmpeg)';
    $('serverState').className = 'server-state-pill ok';
    resolvePageVideo();
  } else {
    $('serverSection').classList.add('hidden');
    $('serverHint').classList.remove('hidden');
    $('serverState').textContent = '● in-browser mode';
    $('serverState').className = 'server-state-pill ok';
  }
}

async function resolvePageVideo() {
  $('mediaTitle').textContent = 'Reading page video formats…';
  $('presets').innerHTML = '';
  try {
    const info = await fetchJSON('/resolve?url=' + encodeURIComponent(pageUrl));
    if (info.error) throw new Error(info.error);
    $('mediaTitle').textContent = info.title || 'Video Stream';
    const subBits = [];
    if (info.extractor) subBits.push(info.extractor);
    if (info.duration) subBits.push(fmtDuration(info.duration));
    $('mediaSub').textContent = subBits.join(' · ');
    if (info.thumbnail) {
      $('thumb').src = info.thumbnail;
      $('thumb').classList.remove('hidden');
    }
    renderPresetButtons(info);
  } catch (e) {
    $('mediaTitle').textContent = "Couldn't extract stream details";
    $('mediaSub').textContent = String(e.message || e).slice(0, 100);
  }
}

function renderPresetButtons(info) {
  const wrap = $('presets');
  wrap.innerHTML = '';
  const heights = info.heights || [];
  const opts = [];
  if (info.hasVideo) {
    opts.push({ preset: 'best', label: '⬇ Best Quality', primary: true });
    const uniqueHeights = [...new Set(heights)].sort((a, b) => b - a);
    uniqueHeights.forEach((h) => {
      let label = h + 'p';
      if (h >= 2160) label = h + 'p (4K)';
      else if (h >= 1080) label = h + 'p (HD)';
      opts.push({ preset: String(h), label });
    });
  }
  if (info.hasAudio) opts.push({ preset: 'audio', label: '🎵 Audio MP3' });
  if (!opts.length) opts.push({ preset: 'best', label: '⬇ Download' });

  opts.forEach((o) => {
    const b = document.createElement('button');
    b.className = 'btn-sm ' + (o.primary ? 'btn-primary' : 'mini-btn');
    b.textContent = o.label;
    b.onclick = () => triggerBackendDownload(o.preset);
    wrap.appendChild(b);
  });
}

async function triggerBackendDownload(preset) {
  $('status').textContent = '';
  $('progressWrap').classList.remove('hidden');
  setProgressBar(0, 'Starting download…');

  try {
    const res = await postJSON('/download', { url: pageUrl, preset });
    if (res.error) throw new Error(res.error);
    pollJobProgress(res.job_id);
  } catch (e) {
    $('progressWrap').classList.add('hidden');
    $('status').className = 'status-msg err';
    $('status').textContent = 'Error: ' + String(e.message || e);
  }
}

function pollJobProgress(jobId) {
  clearInterval(pollTimer);
  pollTimer = setInterval(async () => {
    const job = await fetchJSON('/progress?id=' + jobId).catch(() => null);
    if (!job) return;

    if (job.status === 'running') {
      const pct = job.percent || 0;
      setProgressBar(pct, pct ? pct.toFixed(1) + '%' : 'Downloading…');
    } else if (job.status === 'done') {
      clearInterval(pollTimer);
      setProgressBar(100, 'Complete');
      $('status').className = 'status-msg ok';
      $('status').textContent = '✓ Downloaded: ' + (job.file || 'Saved to Downloads');
    } else if (job.status === 'error') {
      clearInterval(pollTimer);
      $('progressWrap').classList.add('hidden');
      $('status').className = 'status-msg err';
      $('status').textContent = 'Error: ' + (job.error || 'Failed');
    }
  }, 700);
}

function setProgressBar(pct, text) {
  $('bar').style.width = Math.max(2, Math.min(100, pct)) + '%';
  $('progressText').textContent = text;
}

// ── Ad Blocker Controls ──
function setupAdBlockerToggle() {
  chrome.runtime.sendMessage({ type: 'GET_ADBLOCK_STATUS' }, (resp) => {
    if (resp && typeof resp.enabled === 'boolean') {
      $('adblockToggle').checked = resp.enabled;
    }
  });

  $('adblockToggle').onchange = () => {
    const enable = $('adblockToggle').checked;
    chrome.runtime.sendMessage({ type: 'TOGGLE_ADBLOCK', enable }, () => {
      chrome.storage.local.set({ adBlockEnabled: enable }, () => {
        if (activeTabId) {
          chrome.tabs.reload(activeTabId);
        }
      });
    });
  };
}

// ── Settings Handlers ──
function setupSettingsHandlers() {
  $('saveSettingsBtn').onclick = async () => {
    const serverVal = $('serverUrlInput').value.trim().replace(/\/$/, '');
    const apiVal = $('apiKeyInput').value.trim();
    const engineVal = $('engineModelSelect').value;
    const confirmVal = $('confirmNameToggle').checked;

    SERVER = serverVal || 'http://127.0.0.1:8787';
    API_KEY = apiVal;
    ENGINE_MODEL = engineVal;
    CONFIRM_NAME = confirmVal;

    await chrome.storage.local.set({
      backendUrl: SERVER,
      apiKey: API_KEY,
      engineModel: ENGINE_MODEL,
      confirmName: CONFIRM_NAME
    });

    $('settingsStatus').className = 'status-msg ok';
    $('settingsStatus').textContent = '✓ Settings saved successfully';
    setTimeout(() => { $('settingsStatus').textContent = ''; }, 2000);

    const isWeb = /^https?:\/\//i.test(pageUrl);
    checkServerHealth(isWeb);
  };

  $('retryServer').onclick = () => {
    const isWeb = /^https?:\/\//i.test(pageUrl);
    checkServerHealth(isWeb);
  };
  $('copyCmd').onclick = () => {
    navigator.clipboard.writeText('python3 server/server.py');
    $('copyCmd').textContent = 'Copied!';
    setTimeout(() => ($('copyCmd').textContent = 'Copy Cmd'), 1200);
  };
}

// ── Popout Button ──
function setupPopoutButton() {
  $('popoutBtn').onclick = () => {
    if (!activeTabId) return;
    const u = chrome.runtime.getURL('grabber/grabber.html') +
      '?tabId=' + encodeURIComponent(activeTabId) + '&url=' + encodeURIComponent(pageUrl);
    chrome.tabs.create({ url: u });
    window.close();
  };
}

// ── Network & HLS Master Playlist Parsers ──
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
    return [];
  }
}

async function fetchJSON(path) {
  const headers = {};
  if (API_KEY) headers['X-API-Key'] = API_KEY;
  const r = await fetch(SERVER + path, { headers });
  return r.json();
}
async function postJSON(path, body) {
  const headers = { 'Content-Type': 'application/json' };
  if (API_KEY) headers['X-API-Key'] = API_KEY;
  const r = await fetch(SERVER + path, { method: 'POST', headers, body: JSON.stringify(body) });
  return r.json();
}

function getExt(u) {
  const m = u.split('?')[0].match(/\.([a-z0-9]{2,5})$/i);
  return m ? m[1].toLowerCase() : '';
}

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

function getItemFileName(it, index = 0) {
  if (it._customName) return it._customName;

  const ext = (it.kind === 'hls' || it.kind === 'dash')
    ? 'mp4'
    : (getExt(it.url) || (it.type === 'image' ? 'jpg' : it.type === 'audio' ? 'mp3' : 'mp4'));

  // 1. Try item metadata title if present
  if (it.metaTitle || it.title) {
    const cleaned = cleanStringForFilename(it.metaTitle || it.title);
    if (cleaned && cleaned.length > 3 && !GENERIC_FILENAME_RE.test(cleaned)) {
      return `${cleaned}.${ext}`;
    }
  }

  // 2. Try page title for video/audio streams or main media
  if (pageTitleVal) {
    const cleaned = cleanStringForFilename(pageTitleVal);
    if (cleaned && cleaned.length > 3) {
      if (it.type === 'video' || it.kind === 'hls' || it.kind === 'dash' || it.isVideo) {
        return `${cleaned}.${ext}`;
      }
      return `${cleaned}_${it.type || 'item'}_${index + 1}.${ext}`;
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
  return `${fallbackTitle}_${it.type || 'item'}_${index + 1}.${ext}`;
}

function getHighResUrl(url) {
  try {
    const u = new URL(url);
    if (u.hostname.includes('dmcdn.net') && u.pathname.includes('/v/')) {
      u.pathname = u.pathname.replace(/\/x(160|240|360|480|720)(\?|$)/, '/x1080$2');
      return u.href;
    }
    if (u.hostname.includes('ytimg.com')) {
      return u.href.replace(/(hqdefault|mqdefault|sddefault)\.jpg/, 'maxresdefault.jpg');
    }
  } catch (_) {}
  return url;
}

function fmtSize(bytes) {
  if (!bytes) return '';
  const k = 1024;
  const sizes = ['Bytes', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
}

function fmtDuration(s) {
  s = Math.round(s);
  const m = Math.floor(s / 60), r = s % 60;
  return m + ':' + String(r).padStart(2, '0');
}

function escUrl(s) {
  return String(s || '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

const BITRATE_MAP = {
  '2160p': 12000000,
  '1440p': 7500000,
  '1280p': 4500000,
  '1080p': 3500000,
  '848p':  1800000,
  '720p':  2145000,
  '640p':  1200000,
  '480p':  1050000,
  '360p':  600000,
  '240p':  350000,
};

function detectResolutionFromUrl(url) {
  const m = url.match(/(?:x|hd|_|-|\/)(2160|1440|1280|1080|848|720|640|480|360|240)(?:p|\/|\.|\?|_|-|$)/i);
  return m ? m[1] + 'p' : '';
}

async function expandHlsStreams(itemsList) {
  const expanded = [];
  const seenUrls = new Set();
  const dur = window._pageVideoDuration || 1800;

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
        const estBytes = (v.bandwidth && dur > 0) ? Math.round((v.bandwidth / 8) * dur) : (BITRATE_MAP[pxLabel] && dur > 0 ? Math.round((BITRATE_MAP[pxLabel] / 8) * dur) : Math.round((1800000 / 8) * dur));

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
      if (!pxLabel && it.url.includes('x1280')) pxLabel = '1280p';
      if (!pxLabel && it.url.includes('x720')) pxLabel = '720p';
      if (!pxLabel && it.url.includes('x848')) pxLabel = '848p';
      if (!pxLabel && it.url.includes('x640')) pxLabel = '640p';
      if (!pxLabel && it.url.includes('x480')) pxLabel = '480p';
      if (!pxLabel && it.url.includes('x360')) pxLabel = '360p';
      if (!pxLabel) pxLabel = '720p';

      const bw = BITRATE_MAP[pxLabel] || 1800000;
      const estBytes = Math.round((bw / 8) * dur);

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
