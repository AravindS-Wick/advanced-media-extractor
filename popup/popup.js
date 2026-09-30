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

// Real-time Progress & State Listener
chrome.runtime.onMessage.addListener((m) => {
  if (!m) return;

  if (m.type === 'DOWNLOAD_HISTORY_UPDATED' || m.type === 'ACTIVE_DOWNLOADS_UPDATED' || m.type === 'DOWNLOAD_COMPLETE') {
    if (typeof refreshDownloadsList === 'function') refreshDownloadsList();
  }

  if (m.id) {
    if (!activeMuxJobs[m.id]) {
      // Find matching card button in DOM if popup was reopened during download
      const allCards = document.querySelectorAll('.resource-card');
      for (const card of allCards) {
        const nameEl = card.querySelector('.res-name');
        if (nameEl && m.filename && (nameEl.textContent.includes(m.filename) || m.filename.includes(nameEl.textContent))) {
          const btn = card.querySelector('.dl-btn');
          if (btn) activeMuxJobs[m.id] = { btn };
          break;
        }
      }
    }

    const j = activeMuxJobs[m.id];
    if (j) {
      if (m.type === 'MUX_PROGRESS') {
        if (j.btn) {
          j.btn.disabled = true;
          if (m.status) {
            j.btn.textContent = m.status;
          } else {
            const prefix = m.id.startsWith('dl_') ? 'Fetching ' : 'Muxing ';
            j.btn.textContent = prefix + Math.round(m.percent) + '%';
          }
        }
      } else if (m.type === 'MUX_DONE') {
        if (m.error) {
          if (j.btn) {
            const isCancel = m.error.includes('aborted') || m.error.includes('Cancelled');
            j.btn.disabled = false;
            j.btn.textContent = isCancel ? 'Cancelled' : 'Err ⚠';
            j.btn.title = isCancel ? '' : m.error;
            j.btn.classList.toggle('has-error', !isCancel);
            setTimeout(() => {
              if (j.btn) {
                j.btn.textContent = '⬇ Download';
                j.btn.title = '';
                j.btn.classList.remove('has-error');
              }
            }, isCancel ? 3000 : 6000);
          }
        } else {
          if (j.btn) {
            j.btn.disabled = false;
            j.btn.textContent = '✓ Saved';
            j.btn.title = '';
            setTimeout(() => { if (j.btn) j.btn.textContent = '⬇ Download'; }, 3500);
          }
        }
        delete activeMuxJobs[m.id];
      }
    }
  }

  if (m.type === 'MUX_PROGRESS' || m.type === 'MUX_DONE') {
    if (typeof refreshDownloadsList === 'function') refreshDownloadsList();
  }
});

document.addEventListener('DOMContentLoaded', init);

async function init() {
  // Load settings from storage
  const stored = await chrome.storage.local.get(['backendUrl', 'apiKey', 'engineModel', 'confirmName', 'mediaSortPreference', 'downloadSubfolder']);
  if (stored.backendUrl) SERVER = stored.backendUrl;
  if (stored.apiKey) API_KEY = stored.apiKey;
  if (stored.engineModel) ENGINE_MODEL = stored.engineModel;
  if (typeof stored.confirmName === 'boolean') CONFIRM_NAME = stored.confirmName;
  if (stored.mediaSortPreference && $('sortFilter')) {
    $('sortFilter').value = stored.mediaSortPreference;
  }

  $('serverUrlInput').value = SERVER;
  $('apiKeyInput').value = API_KEY;
  $('engineModelSelect').value = ENGINE_MODEL;
  $('confirmNameToggle').checked = CONFIRM_NAME;
  if ($('downloadFolderInput')) $('downloadFolderInput').value = stored.downloadSubfolder || '';

  setupNavTabs();
  setupSettingsHandlers();
  setupPopoutButton();
  setupBulkModal();
  setupVideoModal();
  setupDownloadsTab();

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

    if (pageUrl.includes('youtube.com')) {
      $('ytMuxBanner')?.classList.remove('hidden');
      const goToEngineBtn = $('goToEngineBtn');
      if (goToEngineBtn) {
        goToEngineBtn.onclick = () => {
          const engineTabBtn = document.querySelector('.tab-btn[data-tab="tab-engine"], .nav-tab[data-tab="tab-engine"]');
          if (engineTabBtn) engineTabBtn.click();
        };
      }
    }
  }

  // Set up both ad blocker & redirect shield controls
  setupAdBlockerToggle();
  setupRedirectBlockerUI();

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

  $('refreshScan').onclick = () => scanCurrentPage(true);
  $('clearList').onclick = clearCurrentList;
  $('formatFilter').onchange = renderResourceGrid;
  if ($('sortFilter')) {
    $('sortFilter').onchange = (e) => {
      chrome.storage.local.set({ mediaSortPreference: e.target.value }).catch(() => {});
      renderResourceGrid();
    };
  }
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
async function scanCurrentPage(reset = false) {
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

  chrome.runtime.sendMessage({ type: 'SCAN_TAB', tabId: activeTabId, reset }, async (resp) => {
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
    if (!s.url || fetchedItems.some((x) => x.url === s.url)) return;
    const parentName = parentIt._customName || parentIt.title || parentIt.metaTitle || 'Subtitle';
    fetchedItems.push({
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
    updateCategoryCounts();
    populateFormatDropdown();
    renderResourceGrid();
  }
}

function updateCategoryCounts() {
  $('c-all').textContent = fetchedItems.length;
  const badgeEl = $('headerCountBadge');
  if (badgeEl) badgeEl.textContent = `${fetchedItems.length} Found`;

  // Videos tab only shows complete videos with audio!
  const videoCount = fetchedItems.filter((it) => catOf(it) === 'video' && it.isMuxed !== false).length;
  const audioCount = fetchedItems.filter((it) => catOf(it) === 'audio' || it.isAudio).length;
  const imageCount = fetchedItems.filter((it) => catOf(it) === 'image').length;
  const docCount = fetchedItems.filter((it) => catOf(it) === 'doc').length;

  if ($('c-video')) $('c-video').textContent = videoCount;
  if ($('c-audio')) $('c-audio').textContent = audioCount;
  if ($('c-image')) $('c-image').textContent = imageCount;
  if ($('c-doc')) $('c-doc').textContent = docCount;
}

function populateFormatDropdown() {
  const select = $('formatFilter');
  const prevVal = select.value;
  select.innerHTML = '<option value="all">All Formats</option>';

  const filteredList = fetchedItems.filter((it) => {
    if (activeCat === 'all') return true;
    if (activeCat === 'video') return catOf(it) === 'video' && it.isMuxed !== false;
    if (activeCat === 'audio') return catOf(it) === 'audio' || it.isAudio;
    return catOf(it) === activeCat;
  });
  const formats = new Set();
  filteredList.forEach((it) => {
    const f = it.kind === 'hls' ? 'm3u8' : it.kind === 'dash' ? 'mpd' : it.kind === 'subtitle' ? 'vtt' : getExt(it.url) || it.type;
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

  let list = fetchedItems.filter((it) => {
    if (activeCat === 'all') return true;
    if (activeCat === 'video') {
      // In the Videos tab, only show videos that have audio (video as usual with audio)!
      return catOf(it) === 'video' && it.isMuxed !== false;
    }
    if (activeCat === 'audio') {
      // Audio separately in the audio tab
      return catOf(it) === 'audio' || it.isAudio;
    }
    return catOf(it) === activeCat;
  });

  const selectedFormat = $('formatFilter').value;
  if (selectedFormat !== 'all') {
    list = list.filter((it) => {
      const f = it.kind === 'hls' ? 'm3u8' : it.kind === 'dash' ? 'mpd' : it.kind === 'subtitle' ? 'vtt' : getExt(it.url) || it.type;
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

  // Sort list
  const sortVal = $('sortFilter') ? $('sortFilter').value : 'default';
  if (sortVal && sortVal !== 'default') {
    list.sort((a, b) => {
      if (sortVal === 'size-desc') {
        const sA = a.size || a.estimatedBytes || 0;
        const sB = b.size || b.estimatedBytes || 0;
        return sB - sA;
      }
      if (sortVal === 'size-asc') {
        const sA = a.size || a.estimatedBytes || 0;
        const sB = b.size || b.estimatedBytes || 0;
        return sA - sB;
      }
      if (sortVal === 'quality-desc') {
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
        if (qB !== qA) return qB - qA;
        const sA = a.size || a.estimatedBytes || 0;
        const sB = b.size || b.estimatedBytes || 0;
        return sB - sA;
      }
      if (sortVal === 'name-asc') {
        const nameA = (a._customName || getItemFileName(a)).toLowerCase();
        const nameB = (b._customName || getItemFileName(b)).toLowerCase();
        return nameA.localeCompare(nameB, undefined, { numeric: true, sensitivity: 'base' });
      }
      if (sortVal === 'name-desc') {
        const nameA = (a._customName || getItemFileName(a)).toLowerCase();
        const nameB = (b._customName || getItemFileName(b)).toLowerCase();
        return nameB.localeCompare(nameA, undefined, { numeric: true, sensitivity: 'base' });
      }
      if (sortVal === 'type-asc') {
        const extA = (a.kind === 'hls' ? 'm3u8' : a.kind === 'dash' ? 'mpd' : getExt(a.url) || a.type || '').toLowerCase();
        const extB = (b.kind === 'hls' ? 'm3u8' : b.kind === 'dash' ? 'mpd' : getExt(b.url) || b.type || '').toLowerCase();
        return extA.localeCompare(extB);
      }
      return 0;
    });
  }

  if (!list.length) {
    const isInsta = (pageUrl && pageUrl.includes('instagram.com')) || (pageTitleVal && pageTitleVal.includes('Instagram'));
    if (isInsta && currentFilter === 'video') {
      grid.innerHTML = `
        <div class="empty-state" style="padding: 20px 14px; text-align: center;">
          <div style="font-size: 26px; margin-bottom: 6px;">🎬</div>
          <div style="font-weight: 600; color: #fff; font-size: 13px; margin-bottom: 4px;">No videos detected yet</div>
          <div style="font-size: 11px; color: #94a3b8; line-height: 1.4; margin-bottom: 10px;">
            Instagram streams media only after the video starts playing.
          </div>
          <div style="background: rgba(99, 102, 241, 0.12); border: 1px solid rgba(99, 102, 241, 0.3); border-radius: 6px; padding: 8px 10px; font-size: 11px; color: #a5b4fc; text-align: left;">
            💡 <b>Tip:</b> Click Play on the Instagram Reel for 1 second, then click <b>🔄 Rescan</b> above.
          </div>
        </div>
      `;
    } else {
      grid.innerHTML = '<div class="empty-state">No matching media resources found.</div>';
    }
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

  const formatBadge = it.kind === 'hls' ? 'HLS' : it.kind === 'dash' ? 'DASH' : it.kind === 'subtitle' ? 'CC' : (getExt(downloadUrl) || it.type).toUpperCase();
  const sizeBadge = it.size ? fmtSize(it.size) : '';

  const thumbUrl = it.poster || it.thumbnail || (it.type === 'image' ? downloadUrl : null);
  let preview = '';
  if (thumbUrl) {
    preview = `
      <div style="position: relative; width: 44px; height: 44px; flex-shrink: 0;">
        <img class="res-thumb" src="${escUrl(thumbUrl)}" loading="lazy" referrerpolicy="no-referrer" onerror="this.style.display='none';this.nextElementSibling.style.display='flex'">
        <div class="res-thumb" style="display:none">${it.isSubtitle ? '💬' : it.type === 'audio' ? '🎵' : it.type === 'doc' ? '📄' : '🎬'}</div>
      </div>
    `;
  } else if (it.type === 'video' || it.isVideo) {
    preview = `
      <div style="position: relative; width: 44px; height: 44px; flex-shrink: 0;">
        <video class="res-thumb" src="${escUrl(downloadUrl)}#t=0.1" preload="metadata" muted playsinline></video>
      </div>
    `;
  } else {
    preview = `<div class="res-thumb">${it.isSubtitle ? '💬' : it.type === 'audio' ? '🎵' : it.type === 'doc' ? '📄' : '🎬'}</div>`;
  }

  const pixelBadge = it._pixelLabel ? `<span class="badge-pixel">${escUrl(it._pixelLabel)}</span>` : '';

  let streamAudioBadge = '';
  if (it.isVideo && it.isMuxed) {
    streamAudioBadge = `<span class="badge-tag" style="background:rgba(16,185,129,0.2); color:#34d399; border-color:rgba(16,185,129,0.4);" title="Full stream with Audio & Video combined">🔊 Video + Audio</span>`;
  } else if (it.isVideo && it.isMuxed === false) {
    streamAudioBadge = `<span class="badge-tag" style="background:rgba(245,158,11,0.2); color:#fbbf24; border-color:rgba(245,158,11,0.4);" title="Video-only stream without sound. For 1080p/4K with sound, use 🎬 1-Click Engine">🔇 Video Only</span>`;
  } else if (it.isAudio || it.type === 'audio') {
    streamAudioBadge = `<span class="badge-tag" style="background:rgba(59,130,246,0.2); color:#60a5fa; border-color:rgba(59,130,246,0.4);" title="Audio stream (MP3/M4A)">🎵 Audio Only</span>`;
  }

  card.innerHTML = `
    ${preview}
    <div class="res-info">
      <div class="res-name" title="Click to rename" data-idx="${idx}">${escUrl(filename)}</div>
      <div class="res-sub">
        <span class="badge-tag">${formatBadge}</span>
        ${streamAudioBadge}
        ${pixelBadge}
        <span class="res-size">${sizeBadge ? '· ' + sizeBadge : ''}</span>
      </div>
      <div class="selector-wrap hidden mt-1" style="width: 100%;">
        <select class="res-select form-select" style="padding: 2px 4px; font-size: 10px;"></select>
      </div>
    </div>
    <div class="res-actions">
      <button class="btn-preview-mini preview-btn" title="Preview in popup modal">👁 Preview</button>
      <button class="btn-preview-mini play-tab-btn" title="Open in dedicated preview tab" style="color:#a5b4fc;">↗ Tab</button>
      <button class="btn-dl-mini dl-btn">⬇ Download</button>
    </div>
  `;

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
          const subDiv = card.querySelector('.res-sub');
          if (subDiv && !subDiv.querySelector('.badge-pixel')) {
            const span = document.createElement('span');
            span.className = 'badge-pixel';
            span.textContent = it._pixelLabel;
            subDiv.appendChild(span);
          }
        }

        const sizeEl = card.querySelector('.res-size');
        if (topVariant.estimatedBytes > 0) {
          it.size = topVariant.estimatedBytes;
          const segInfo = segmentsCount ? ` (${segmentsCount} segs)` : '';
          if (sizeEl) sizeEl.textContent = `· ~${fmtSize(topVariant.estimatedBytes)}${segInfo}`;
        } else if (topVariant.bandwidth) {
          if (sizeEl) sizeEl.textContent = `· ${Math.round(topVariant.bandwidth / 1000)} kbps`;
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
            const vEst = v.estimatedBytes > 0 ? ` · ~${fmtSize(v.estimatedBytes)}` : '';
            const icon = v.isAudioOnly ? '🎵 ' : '';
            opt.textContent = `${icon}${v.label} (${Math.round(v.bandwidth / 1000)}k${vEst})`;
            sel.appendChild(opt);
          });

          sel.onchange = () => {
            const chosen = variants.find(v => v.url === sel.value);
            if (chosen && chosen.estimatedBytes > 0) {
              it.size = chosen.estimatedBytes;
              if (sizeEl) sizeEl.textContent = `· ~${fmtSize(chosen.estimatedBytes)}`;
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

  // Play in separate tab button click
  const playTabBtn = card.querySelector('.play-tab-btn');
  if (playTabBtn) {
    playTabBtn.onclick = () => {
      const sel = card.querySelector('.res-select');
      let targetUrl = downloadUrl;
      if (sel && sel.value) targetUrl = sel.value;
      openStandalonePlayer(targetUrl, filename, it.type || 'video');
    };
  }

  const dlBtn = card.querySelector('.dl-btn');
  dlBtn.onclick = () => {
    const sel = card.querySelector('.res-select');
    let targetUrl = downloadUrl;
    let preferredQuality = '';
    if (sel && sel.value) {
      targetUrl = sel.value;
      preferredQuality = sel.options[sel.selectedIndex]?.textContent || '';
    }
    downloadItem(it, targetUrl, filename, dlBtn, preferredQuality);
  };

  // Restore running background job state if present
  try {
    chrome.storage.local.get(['activeDownloadJobs'], (res) => {
      const jobs = res.activeDownloadJobs || {};
      for (const [jobId, job] of Object.entries(jobs)) {
        if (job && job.filename && (job.filename === filename || filename.includes(job.filename))) {
          dlBtn.disabled = true;
          dlBtn.textContent = job.status || `Fetching ${Math.round(job.percent || 0)}%…`;
          activeMuxJobs[jobId] = { btn: dlBtn };
          break;
        }
      }
    });
  } catch (_) {}

  return card;
}

function downloadItem(it, downloadUrl, filename, btn, preferredQuality = '') {
  // A subtitle URL from an HLS master playlist is frequently itself an .m3u8
  // wrapper, not a video stream — resolve it to the real .vtt first so it
  // doesn't get routed into the video mux pipeline below.
  if (it.kind === 'subtitle') {
    downloadSubtitleItem(it, downloadUrl, filename, btn);
    return;
  }

  let resolvedName = filename || it._customName || getItemFileName({ ...it, url: downloadUrl });

  if (CONFIRM_NAME) {
    const prompted = prompt('Confirm file name before download:', resolvedName);
    if (prompted === null) return;
    if (prompted.trim()) resolvedName = prompted.trim();
  }

  // Ensure resolvedName has a valid extension
  if (!/\.[a-z0-9]{2,5}$/i.test(resolvedName)) {
    const isVid = it.kind === 'hls' || it.kind === 'dash' || it.isVideo || it.type === 'video';
    const isAud = it.type === 'audio' || it.isAudio;
    const isImg = it.type === 'image';
    resolvedName += isVid ? '.mp4' : isAud ? '.mp3' : isImg ? '.jpg' : '.mp4';
  }

  btn.disabled = true;
  btn.textContent = '⟳ Starting…';

  const isHls = it.kind === 'hls' ||
                /(\.m3u8|manifest\.m3u8|\/manifest\/video\/|\/hls\/|\.m3u8\?|type=hls|format=m3u8|format=hls)/i.test(downloadUrl) ||
                (it.mimeType && /mpegurl/i.test(it.mimeType));

  if (isHls) {
    const id = 'mux_' + Math.random().toString(36).slice(2);
    activeMuxJobs[id] = { btn };
    btn.textContent = 'Fetching 0%…';
    chrome.runtime.sendMessage({
      type: 'MUX_HLS',
      id,
      url: downloadUrl,
      filename: resolvedName,
      preferredQuality
    }, () => {
      if (typeof refreshDownloadsList === 'function') refreshDownloadsList();
    });
    return;
  }

  // Direct download via SW
  chrome.runtime.sendMessage({
    type: 'DOWNLOAD_STREAM',
    url: downloadUrl,
    filename: resolvedName,
    pageUrl: pageUrl,
    mimeType: it.mimeType || ''
  }, (resp) => {
    if (typeof refreshDownloadsList === 'function') refreshDownloadsList();

    if (resp && resp.isHls && resp.id) {
      // Intercepted by SW and routed to HLS muxer
      activeMuxJobs[resp.id] = { btn };
      btn.textContent = 'Fetching 0%…';
      return;
    }

    btn.disabled = false;
    if (resp && resp.ok) {
      btn.textContent = '✓ Saved';
      btn.title = '';
      setTimeout(() => { btn.textContent = '⬇ Download'; }, 3000);
    } else {
      const errMsg = (resp && resp.error) || (chrome.runtime.lastError && chrome.runtime.lastError.message) || 'Download failed';
      btn.textContent = 'Err ⚠';
      btn.title = errMsg;
      btn.classList.add('has-error');
      setTimeout(() => {
        btn.textContent = '⬇ Download';
        btn.title = '';
        btn.classList.remove('has-error');
      }, 6000);
    }
  });
}

async function downloadSubtitleItem(it, downloadUrl, filename, btn) {
  btn.disabled = true;
  btn.textContent = 'Resolving…';

  const resolveFn = typeof resolveSubtitleUrl === 'function' ? resolveSubtitleUrl : async (u) => u;
  let targetUrl = downloadUrl;
  try {
    targetUrl = await resolveFn(downloadUrl);
  } catch (_) {}

  const resolvedName = filename || it._customName || getItemFileName({ ...it, url: targetUrl });
  btn.textContent = '⟳ Downloading…';

  chrome.runtime.sendMessage({
    type: 'DOWNLOAD_STREAM',
    url: targetUrl,
    filename: resolvedName,
    pageUrl: pageUrl,
    mimeType: 'text/vtt'
  }, (resp) => {
    if (typeof refreshDownloadsList === 'function') refreshDownloadsList();
    btn.disabled = false;
    if (resp && resp.ok) {
      btn.textContent = '✓ Saved';
      setTimeout(() => { btn.textContent = '⬇ Download'; }, 3000);
    } else {
      const errMsg = (resp && resp.error) || (chrome.runtime.lastError && chrome.runtime.lastError.message) || 'Download failed';
      btn.textContent = 'Err ⚠';
      btn.title = errMsg;
      btn.classList.add('has-error');
      setTimeout(() => {
        btn.textContent = '⬇ Download';
        btn.title = '';
        btn.classList.remove('has-error');
      }, 6000);
    }
  });
}

// ── Inbuilt Custom Video Preview Player Modal ──
let isPlayerSeeking = false;
let playerToastTimer = null;
let currentPreviewItem = null;
let currentPreviewUrl = '';
let currentPreviewFilename = '';

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
  const playerDlBtn = $('playerDownloadBtn');
  const spinner = $('playerSpinner');
  const container = $('videoContainer');

  let lastVolume = 1;

  if (playerDlBtn) {
    playerDlBtn.onclick = (e) => {
      e.stopPropagation();
      if (!currentPreviewItem || !currentPreviewUrl) return;
      downloadItem(currentPreviewItem, currentPreviewUrl, currentPreviewFilename, playerDlBtn);
    };
  }

  function closePlayer() {
    player.pause();
    player.src = '';
    const imgEl = $('previewImage');
    if (imgEl) { imgEl.src = ''; }
    const docEl = $('previewDoc');
    if (docEl) { docEl.src = ''; }
    videoModal.classList.add('hidden');
  }

  if (closeBtn) closeBtn.onclick = closePlayer;

  const popoutPlayerBtn = $('popoutPlayerBtn');
  if (popoutPlayerBtn) {
    popoutPlayerBtn.onclick = () => {
      const curTime = player.currentTime || 0;
      closePlayer();
      openStandalonePlayer(currentPreviewUrl, currentPreviewFilename, currentPreviewItem?.type || 'video', curTime);
    };
  }

  if (videoModal) {
    videoModal.onclick = (e) => {
      if (e.target === videoModal) closePlayer();
    };
  }

  function togglePlay() {
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

  // Keyboard controls
  window.addEventListener('keydown', (e) => {
    if (videoModal.classList.contains('hidden')) return;
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
  currentPreviewFilename = title || (it ? it._customName || getItemFileName(it) : 'media');

  const type = it?.type || 'video';
  const isVideo = type === 'video' || it?.isVideo;
  const isAudio = type === 'audio' || it?.isAudio;
  const isImage = type === 'image';
  const isDoc = type === 'doc';

  const badgeIcon = isImage ? '🖼️' : isDoc ? '📄' : isAudio ? '🎵' : '🎬';
  const badgeDefaultTitle = isImage ? 'Image Preview' : isDoc ? 'Document Preview' : isAudio ? 'Audio Preview' : 'Video Preview';

  const iconBadge = document.querySelector('.video-icon-badge');
  if (iconBadge) iconBadge.textContent = badgeIcon;
  $('videoTitle').textContent = title || badgeDefaultTitle;

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
    player.playbackRate = 1;
    if (progressBar) progressBar.style.width = '0%';
    if (bufferBar) bufferBar.style.width = '0%';
    if (seekSlider) seekSlider.value = 0;
    if (timeDisplay) timeDisplay.textContent = '00:00 / 00:00';

    updateVolumeUI(player);

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
      pageUrl: pageUrl || ''
    }).catch(() => {});

    player.src = url;
    player.play().catch(() => {});
  }

  videoModal.classList.remove('hidden');
}

const openVideoPreview = openMediaPreview;

function openStandalonePlayer(url, title, type = 'video', currentTime = 0) {
  if (!url) return;
  const playerUrl = chrome.runtime.getURL('player/player.html') +
    '?url=' + encodeURIComponent(url) +
    '&title=' + encodeURIComponent(title || 'Media Stream') +
    '&type=' + encodeURIComponent(type) +
    '&source=' + encodeURIComponent(pageUrl || '') +
    (currentTime > 0 ? '&t=' + encodeURIComponent(currentTime) : '');
  chrome.tabs.create({ url: playerUrl });
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
      const f = it.kind === 'hls' ? 'm3u8' : it.kind === 'dash' ? 'mpd' : it.kind === 'subtitle' ? 'vtt' : getExt(it.url) || it.type;
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
  btn.textContent = 'Preparing ZIP…';

  // The fetching, packing and blob creation all happen in the offscreen
  // document. Doing it here used to fail two ways: file bytes were shipped
  // through chrome.runtime as JSON number arrays (hitting the ~32MB messaging
  // cap), and the object URL was created in the popup — which Chrome destroys
  // the moment it loses focus, killing the download mid-write.
  const items = list.map((it, i) => {
    const targetUrl = it.type === 'image' ? getHighResUrl(it.url) : it.url;
    return {
      url: targetUrl,
      name: it._customName || getItemFileName({ ...it, url: targetUrl }, i)
    };
  });

  const cleanTitle = (pageTitleVal || 'Media_Collection').replace(/[^a-zA-Z0-9_\-]/g, '_').slice(0, 40);
  const id = 'zip_' + Math.random().toString(36).slice(2);

  activeMuxJobs[id] = { btn };
  chrome.runtime.sendMessage({
    type: 'BUILD_ZIP',
    id,
    items,
    filename: `${cleanTitle}_Media_Collection.zip`
  });

  // The job now survives the popup closing; progress arrives over MUX_PROGRESS.
  btn.textContent = 'Zipping 0%…';
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

// ── Per-Domain Ad Blocker Controls ──
function getDomainFromUrl(url) {
  if (!url || !url.startsWith('http')) return '';
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch (_) {
    return '';
  }
}

function setupAdBlockerToggle() {
  const currentDomain = getDomainFromUrl(pageUrl);
  if (currentDomain) {
    $('adblockCurrentDomain').textContent = currentDomain;
  } else {
    $('adblockCurrentDomain').textContent = 'Web Page';
  }

  function renderWhitelistChips(disabledDomains = []) {
    const listWrap = $('whitelistDomainList');
    const pausedCountEl = $('pausedDomainCount');
    if (pausedCountEl) pausedCountEl.textContent = disabledDomains.length;

    if (!listWrap) return;
    if (!disabledDomains.length) {
      listWrap.innerHTML = '<span class="empty-hint">No sites paused. All sites protected.</span>';
      return;
    }

    listWrap.innerHTML = '';
    disabledDomains.forEach(domain => {
      const chip = document.createElement('span');
      chip.className = 'domain-chip';
      chip.innerHTML = `
        <span>${escUrl(domain)}</span>
        <button class="remove-chip-btn" title="Re-enable Ad Block on ${escUrl(domain)}">✕</button>
      `;

      chip.querySelector('.remove-chip-btn').onclick = () => {
        chrome.runtime.sendMessage({ type: 'TOGGLE_ADBLOCK', domain, enable: true }, () => {
          refreshAdBlockState();
          if (activeTabId && currentDomain === domain) {
            chrome.tabs.reload(activeTabId);
          }
        });
      };

      listWrap.appendChild(chip);
    });
  }

  function refreshAdBlockState() {
    chrome.runtime.sendMessage({ type: 'GET_ADBLOCK_STATUS', domain: currentDomain }, (resp) => {
      if (!resp) return;
      const domainToggle = $('adblockDomainToggle');
      const globalToggle = $('adblockGlobalToggle');
      const statusLabel = $('adblockDomainStatus');

      if (domainToggle) domainToggle.checked = !!resp.domainEnabled;
      if (globalToggle) globalToggle.checked = !!resp.globalEnabled;

      if (statusLabel) {
        if (!resp.globalEnabled) {
          statusLabel.textContent = '○ Shield is turned OFF globally';
          statusLabel.className = 'domain-status-label paused';
        } else if (resp.isDomainDisabled) {
          statusLabel.textContent = `○ Paused on ${currentDomain || 'this site'}`;
          statusLabel.className = 'domain-status-label paused';
        } else {
          statusLabel.textContent = `● Protected on ${currentDomain || 'this site'}`;
          statusLabel.className = 'domain-status-label';
        }
      }

      renderWhitelistChips(resp.disabledDomains || []);
    });
  }

  refreshAdBlockState();

  // Per-domain switch change handler
  const domainToggle = $('adblockDomainToggle');
  if (domainToggle) {
    domainToggle.onchange = () => {
      const enable = domainToggle.checked;
      if (!currentDomain) return;

      chrome.runtime.sendMessage({ type: 'TOGGLE_ADBLOCK', domain: currentDomain, enable }, () => {
        refreshAdBlockState();
        if (activeTabId) {
          chrome.tabs.reload(activeTabId);
        }
      });
    };
  }

  // Global switch change handler
  const globalToggle = $('adblockGlobalToggle');
  if (globalToggle) {
    globalToggle.onchange = () => {
      const enable = globalToggle.checked;
      chrome.runtime.sendMessage({ type: 'TOGGLE_ADBLOCK', isGlobal: true, enable }, () => {
        refreshAdBlockState();
        if (activeTabId) {
          chrome.tabs.reload(activeTabId);
        }
      });
    };
  }
}

// ── Per-Domain Redirect Blocker Controls ──
function setupRedirectBlockerUI() {
  const currentDomain = getDomainFromUrl(pageUrl);
  if (currentDomain) {
    const domainEl = $('redirectCurrentDomain');
    if (domainEl) domainEl.textContent = currentDomain;
  }

  function renderRedirectChips(disabledDomains = []) {
    const listWrap = $('redirectPausedDomainList');
    if (!listWrap) return;

    if (!disabledDomains.length) {
      listWrap.innerHTML = '<span class="empty-hint">No sites paused. All redirects intercepted.</span>';
      return;
    }

    listWrap.innerHTML = '';
    disabledDomains.forEach(domain => {
      const chip = document.createElement('span');
      chip.className = 'domain-chip';
      chip.innerHTML = `
        <span>${escUrl(domain)}</span>
        <button class="remove-chip-btn" title="Re-enable redirect blocker on ${escUrl(domain)}">✕</button>
      `;

      chip.querySelector('.remove-chip-btn').onclick = () => {
        chrome.storage.local.get(['redirectBlockerDisabledDomains'], (res) => {
          let list = Array.isArray(res.redirectBlockerDisabledDomains) ? res.redirectBlockerDisabledDomains : [];
          list = list.filter(d => normalizeDomain(d) !== normalizeDomain(domain));
          chrome.runtime.sendMessage({ type: 'SET_REDIRECT_SETTINGS', disabledDomains: list }, () => {
            refreshRedirectState();
            if (activeTabId && currentDomain === domain) {
              chrome.tabs.reload(activeTabId);
            }
          });
        });
      };

      listWrap.appendChild(chip);
    });
  }

  function refreshRedirectState() {
    chrome.runtime.sendMessage({ type: 'GET_REDIRECT_STATS' }, (resp) => {
      if (!resp) return;
      const countEl = $('redirectBlockedCount');
      const toggle = $('redirectBlockerToggle');
      const domainToggle = $('redirectDomainToggle');
      const statusLabel = $('redirectDomainStatus');
      const disabledDomains = resp.disabledDomains || [];

      if (countEl) countEl.textContent = resp.blockedCount || 0;
      if (toggle) toggle.checked = resp.enabled !== false;

      const isDomainDisabled = currentDomain ? isDomainInList(currentDomain, disabledDomains) : false;
      if (domainToggle) domainToggle.checked = !isDomainDisabled && resp.enabled !== false;

      if (statusLabel) {
        if (!resp.enabled) {
          statusLabel.textContent = '○ Redirect blocker is OFF globally';
          statusLabel.className = 'domain-status-label paused';
        } else if (isDomainDisabled) {
          statusLabel.textContent = `○ Paused on ${currentDomain || 'this site'}`;
          statusLabel.className = 'domain-status-label paused';
        } else {
          statusLabel.textContent = `● Redirect blocking active on ${currentDomain || 'this site'}`;
          statusLabel.className = 'domain-status-label';
        }
      }

      renderRedirectChips(disabledDomains);
    });
  }

  refreshRedirectState();

  // Master Redirect toggle
  const mainToggle = $('redirectBlockerToggle');
  if (mainToggle) {
    mainToggle.onchange = () => {
      chrome.runtime.sendMessage({ type: 'SET_REDIRECT_SETTINGS', enabled: mainToggle.checked }, () => {
        refreshRedirectState();
      });
    };
  }

  // Per-domain Redirect toggle
  const domainToggle = $('redirectDomainToggle');
  if (domainToggle) {
    domainToggle.onchange = () => {
      if (!currentDomain) return;
      chrome.storage.local.get(['redirectBlockerDisabledDomains'], (res) => {
        let list = Array.isArray(res.redirectBlockerDisabledDomains) ? [...res.redirectBlockerDisabledDomains] : [];
        if (domainToggle.checked) {
          list = list.filter(d => normalizeDomain(d) !== normalizeDomain(currentDomain));
        } else {
          if (!list.some(d => normalizeDomain(d) === normalizeDomain(currentDomain))) {
            list.push(currentDomain);
          }
        }
        chrome.runtime.sendMessage({ type: 'SET_REDIRECT_SETTINGS', disabledDomains: list }, () => {
          refreshRedirectState();
        });
      });
    };
  }

  // Reset Redirect counter
  const resetBtn = $('resetRedirectStats');
  if (resetBtn) {
    resetBtn.onclick = () => {
      chrome.runtime.sendMessage({ type: 'RESET_REDIRECT_STATS' }, () => {
        const countEl = $('redirectBlockedCount');
        if (countEl) countEl.textContent = '0';
      });
    };
  }
}

// ── Downloads Manager Tab Logic (IndexedDB Engine) ──
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
        a.download = `media_extractor_downloads_export_${DownloadDB.getLocalIsoDate ? DownloadDB.getLocalIsoDate() : 'db'}.json`;
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

  refreshDownloadsList();
}

function formatTimeAgo(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  const now = Date.now();
  const diff = Math.floor((now - ts) / 1000);

  if (diff < 60) return 'Just now';
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;

  // For older items, show clean formatted date & time
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
              <span class="dl-card-name" title="${escUrl(job.filename)}">${escUrl(job.filename || 'Downloading media…')}</span>
            </div>
            <span class="badge-tag">${typeBadge}</span>
          </div>
          <div class="dl-card-bar-track">
            <div class="dl-card-bar-fill" style="width: ${percent}%"></div>
          </div>
          <div class="dl-card-meta">
            <div class="dl-meta-left">
              <span>${escUrl(statusText)}</span>
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
          ? `<span class="status-msg err" style="margin:0;font-size:10px">${escUrl(item.error || 'Interrupted')}</span>`
          : `<span class="status-msg ok" style="margin:0;font-size:10px">Completed ${item.totalBytes ? '· ' + fmtSize(item.totalBytes) : ''}</span>`;
        const timeAgo = formatTimeAgo(item.completedAt || item.startTime);
        const savePathDisplay = item.savePath || ('Saved to Downloads: ' + item.filename);

        card.innerHTML = `
          <div class="dl-card-head">
            <div class="dl-card-name-wrap">
              <span class="dl-card-icon">${icon}</span>
              <span class="dl-card-name" title="${escUrl(item.filename)}">${escUrl(item.filename)}</span>
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
          <div class="dl-location-bar" title="Exact save location on disk: ${escUrl(savePathDisplay)}">
            <div class="dl-location-left">
              <span class="dl-location-icon">📂</span>
              <span class="dl-location-text">${escUrl(savePathDisplay)}</span>
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

  // Warn the instant a drive letter / absolute path is typed, rather than
  // only after Save is clicked — chrome.downloads can never write outside
  // the browser's own Downloads directory, so this can never be an absolute
  // path no matter what's typed here.
  const folderInput = $('downloadFolderInput');
  if (folderInput) {
    folderInput.oninput = () => {
      const val = folderInput.value.trim();
      const looksAbsolute = /^[a-zA-Z]:[\\/]/.test(val) || /^\\\\/.test(val) || /^\//.test(val);
      const statusEl = $('downloadFolderStatus');
      if (!statusEl) return;
      if (looksAbsolute) {
        statusEl.className = 'status-msg err';
        statusEl.textContent = `⚠ This box can't take a drive/full path — "${val.split(/[\\/]/)[0]}" will get stripped out. To use a different drive, change it in chrome://settings/downloads instead.`;
      } else {
        statusEl.textContent = '';
      }
    };
  }

  const saveFolderBtn = $('saveDownloadFolderBtn');
  if (saveFolderBtn) {
    saveFolderBtn.onclick = async () => {
      // chrome.downloads.download() rejects the ENTIRE download with "Invalid
      // filename" if the path has a drive letter, leading slash, "..", or any
      // segment containing : * ? " < > | — so a real Windows path like
      // "D:\Anime" has to be cleaned down to a plain relative subfolder.
      const raw = $('downloadFolderInput').value.trim();
      // A drive letter (D:\...), a UNC share (\\server\...), or a leading "/"
      // means the user is trying to point outside Downloads — something no
      // extension API can do. Warn loudly instead of silently turning
      // "D:\Shared" into a folder literally named "D" inside Downloads.
      const looksAbsolute = /^[a-zA-Z]:[\\/]/.test(raw) || /^\\\\/.test(raw) || /^\//.test(raw);

      const folder = raw
        .replace(/\\/g, '/')
        .split('/')
        .map((seg) => seg.replace(/[:*?"<>|]/g, '').trim())
        .filter((seg) => seg && seg !== '.' && seg !== '..')
        .join('/');
      $('downloadFolderInput').value = folder;

      await chrome.storage.local.set({ downloadSubfolder: folder });

      if (looksAbsolute) {
        $('downloadFolderStatus').className = 'status-msg err';
        $('downloadFolderStatus').textContent = folder
          ? `⚠ This box can't take a drive/full path — it saved as Downloads/${folder}/, not a real "${raw.split(/[\\/]/)[0]}" drive. To use a different drive, change it in chrome://settings/downloads instead.`
          : `⚠ This box can't take a drive/full path. To use a different drive, change it in chrome://settings/downloads instead.`;
        setTimeout(() => { $('downloadFolderStatus').textContent = ''; }, 9000);
      } else {
        $('downloadFolderStatus').className = 'status-msg ok';
        $('downloadFolderStatus').textContent = folder
          ? `✓ Downloads will now save to Downloads/${folder}/`
          : '✓ Downloads will save to the default Downloads folder';
        setTimeout(() => { $('downloadFolderStatus').textContent = ''; }, 3000);
      }
    };
  }

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
  if (!u) return '';
  try {
    const clean = u.split('?')[0].split('#')[0];
    const m = clean.match(/\.([a-z0-9]{2,5})$/i);
    if (!m) return '';
    const ext = m[1].toLowerCase();
    // Exclude web scripts, playlists, and non-media extensions
    if (['php', 'aspx', 'asp', 'jsp', 'cgi', 'm3u8', 'mpd', 'ts', 'm4s', 'html', 'htm', 'txt', 'json', 'xml'].includes(ext)) {
      return '';
    }
    return ext;
  } catch (_) {
    return '';
  }
}

const GENERIC_FILENAME_RE = /^(instagram|facebook|manifest|master|playlist|index|stream|video|audio|init|output|file|media|segment|chunk|download|[a-z0-9]{4,14})$/i;

function cleanStringForFilename(str) {
  if (!str) return '';
  return str
    .replace(/^\s*\(\d+\)\s*•?\s*/i, '') // Strip "(1) ", "(2) • " notification badges
    .replace(/\s*-\s*(Dailymotion|YouTube|Vimeo|Twitter|Instagram|TikTok|X)$/i, '')
    .replace(/\s*•\s*(Instagram|Facebook)$/i, '')
    .replace(/[\\/:*?"<>|]/g, '_')
    .replace(/\s+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 100);
}

function getItemFileName(it, index = 0) {
  const isAudio = it.type === 'audio' || it.isAudio || /(\.mp3|\.m4a|\.aac|\.wav|\.ogg|\.flac)/i.test(it.url) || (/audio/i.test(it.url) && !/video/i.test(it.url));
  const isVideo = !isAudio && (it.kind === 'hls' || it.kind === 'dash' || it.isVideo || it.type === 'video' || /(\.m3u8|\.mpd|\.mp4|\.webm|\.mkv|\.mov)/i.test(it.url));
  const isImage = !isAudio && !isVideo && (it.type === 'image' || /(\.jpg|\.jpeg|\.png|\.webp|\.gif|\.svg|\.avif)/i.test(it.url));

  let ext = getExt(it.url);
  if (it.kind === 'subtitle') ext = 'vtt'; // Always saved as the resolved .vtt, regardless of the source playlist URL
  else if (isAudio) {
    if (!ext || ext === 'mp4') ext = 'mp3';
  } else if (!ext) {
    if (isVideo) ext = 'mp4';
    else if (isImage) ext = 'jpg';
    else if (it.type === 'doc') ext = 'pdf';
    else ext = 'mp4';
  }

  if (it._customName) {
    let custom = it._customName.trim();
    if (!/\.[a-z0-9]{2,5}$/i.test(custom)) {
      custom += `.${ext}`;
    }
    return custom;
  }

  // 1. Try item metadata title if present
  if (it.metaTitle || it.title) {
    const cleaned = cleanStringForFilename(it.metaTitle || it.title);
    if (cleaned && cleaned.length > 3 && !GENERIC_FILENAME_RE.test(cleaned)) {
      return isAudio && !/audio/i.test(cleaned) ? `${cleaned}_Audio.${ext}` : `${cleaned}.${ext}`;
    }
  }

  // 1.5. If Instagram Reel/Post, try extracting reel code
  if (pageUrl && pageUrl.includes('instagram.com')) {
    const reelMatch = pageUrl.match(/\/(?:reels?|p)\/([A-Za-z0-9_-]+)/);
    if (reelMatch) {
      return isAudio ? `Instagram_Reel_${reelMatch[1]}_Audio.${ext}` : `Instagram_Reel_${reelMatch[1]}.${ext}`;
    }
  }

  // 2. Try page title for video/audio streams or main media
  if (pageTitleVal) {
    const cleaned = cleanStringForFilename(pageTitleVal);
    if (cleaned && cleaned.length > 3) {
      if (isVideo) {
        return `${cleaned}.${ext}`;
      }
      return `${cleaned}_${it.type || 'item'}_${index + 1}.${ext}`;
    }
  }

  // 3. Fallback to URL pathname if clean and not generic
  try {
    const rawBase = decodeURIComponent(new URL(it.url).pathname.split('/').pop() || '');
    const cleanBase = cleanStringForFilename(rawBase.replace(/\.[^/.]+$/, ''));
    if (cleanBase && cleanBase.length > 3 && !GENERIC_FILENAME_RE.test(cleanBase) && !/^[a-f0-9]{16,}$/i.test(cleanBase)) {
      return `${cleanBase}.${ext}`;
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
