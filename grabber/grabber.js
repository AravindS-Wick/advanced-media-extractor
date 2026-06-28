// Page Grabber: asks the service worker to scan the target tab (DOM + sniffed network),
// shows every resource by category, and downloads each via the right engine:
//   direct files  -> chrome.downloads (through the SW, which adds Referer)
//   HLS / DASH     -> the local yt-dlp + ffmpeg server (muxes to a real file)

const params = new URLSearchParams(location.search);
const tabId = parseInt(params.get('tabId'), 10);
const pageUrlParam = params.get('url') || '';

let items = [];
let activeCat = 'video';
const muxJobs = {}; // id -> { btn, setMsg } for in-browser HLS muxing

// Progress/result from the offscreen HLS muxer
chrome.runtime.onMessage.addListener((m) => {
  const j = m && m.id && muxJobs[m.id];
  if (!j) return;
  if (m.type === 'MUX_PROGRESS') {
    const prefix = m.id.startsWith('dl_') ? 'Downloading ' : 'Muxing ';
    j.setMsg(prefix + Math.round(m.percent) + '%', true);
  } else if (m.type === 'MUX_DONE') {
    if (m.error) { j.setMsg(m.error, false); resetBtn(j.btn); }
    else {
      const details = m.segments ? ` (${m.segments} segs)` : '';
      j.setMsg(`✓ ${m.file || 'saved'}${details}`, true);
      if (j.btn) j.btn.textContent = '✓ Done';
    }
    delete muxJobs[m.id];
  }
});

const $ = (id) => document.getElementById(id);
$('pageUrl').textContent = pageUrlParam;

document.querySelectorAll('.tab').forEach((t) => {
  t.onclick = () => {
    document.querySelectorAll('.tab').forEach((x) => x.classList.remove('active'));
    t.classList.add('active');
    activeCat = t.dataset.cat;
    render();
  };
});
$('rescan').onclick = scan;
$('dlAll').onclick = downloadAllInCat;

init();

function init() {
  $('serverState').textContent = '● serverless — direct files + HLS handled in-browser';
  $('serverState').className = 'ok';
  scan();
}

function scan() {
  $('status').textContent = 'Scanning this page…';
  $('grid').innerHTML = '';
  chrome.runtime.sendMessage({ type: 'SCAN_TAB', tabId }, (resp) => {
    if (chrome.runtime.lastError || !resp || !resp.ok) {
      $('status').textContent = 'Scan failed: ' + (chrome.runtime.lastError?.message || resp?.error || 'unknown') + ' — is the tab still open?';
      return;
    }
    items = resp.items || [];
    updateCounts();
    const total = items.length;
    $('status').textContent = total ? `Found ${total} resource${total === 1 ? '' : 's'} on this page.` : 'No downloadable resources detected. Try playing the video, then Rescan.';
    render();
  });
}

function catOf(it) {
  if (it.type) return it.type === 'image' ? 'image' : it.type === 'audio' ? 'audio' : it.type === 'doc' ? 'doc' : 'video';
  if (it.isAudio) return 'audio';     // legacy items without an explicit type
  if (it.isVideo) return 'video';
  return 'doc';
}

function updateCounts() {
  ['video', 'image', 'audio', 'doc'].forEach((c) => {
    $('c-' + c).textContent = items.filter((it) => catOf(it) === c).length;
  });
}

function render() {
  const grid = $('grid');
  grid.innerHTML = '';
  const list = items.filter((it) => catOf(it) === activeCat);
  $('dlAll').textContent = `⬇ Download all ${activeCat} (${list.length})`;
  $('dlAll').style.display = list.length ? '' : 'none';
  if (!list.length) { grid.innerHTML = '<p class="empty">Nothing in this category.</p>'; return; }
  list.forEach((it) => grid.appendChild(card(it)));
}

function card(it) {
  const div = document.createElement('div');
  div.className = 'card ' + catOf(it);
  
  let downloadUrl = it.url;
  if (it.type === 'image') {
    downloadUrl = getHighResImageUrl(it.url);
  }
  const name = fileName({ ...it, url: downloadUrl });

  const badge = it.kind === 'hls' ? 'HLS' : it.kind === 'dash' ? 'DASH' : (ext(downloadUrl) || it.type).toUpperCase();
  const preview = it.type === 'image'
    ? `<img class="thumb" src="${esc(downloadUrl)}" loading="lazy" referrerpolicy="no-referrer">`
    : `<div class="thumb icon">${it.type === 'audio' ? '🎵' : it.type === 'doc' ? '📄' : '🎬'}</div>`;
  div.innerHTML = `
    ${preview}
    <div class="info">
      <div class="name" title="${esc(name)}">${esc(name)}</div>
      <div class="sub"><span class="kbadge">${badge}</span><span class="src">${esc(it.source || 'page')}</span></div>
      <div class="url" title="${esc(downloadUrl)}">${esc(downloadUrl)}</div>
    </div>
    <div class="row" style="flex-wrap: wrap; gap: 6px;">
      <div class="selector-wrap hidden" style="width: 100%; margin-bottom: 6px;">
        <select class="res-select" style="width: 100%; padding: 6px; border-radius: 4px; background: #1d2128; color: #fff; border: 1px solid #2d3139; font-size: 11px;"></select>
      </div>
      <button class="btn btn-primary dl">⬇ Download</button>
      <button class="btn btn-ghost copy">Copy URL</button>
    </div>
    <div class="cstatus"></div>`;

  div.querySelector('.copy').onclick = () => navigator.clipboard.writeText(downloadUrl);
  const dlBtn = div.querySelector('.dl');
  const statusEl = div.querySelector('.cstatus');

  if (it.kind === 'hls') {
    getHlsVariants(downloadUrl).then(variants => {
      if (variants && variants.length > 0) {
        const wrap = div.querySelector('.selector-wrap');
        const sel = div.querySelector('.res-select');
        wrap.classList.remove('hidden');
        
        variants.forEach(v => {
          const opt = document.createElement('option');
          opt.value = v.url;
          opt.textContent = `${v.label} (bandwidth: ${Math.round(v.bandwidth / 1000)}k)`;
          sel.appendChild(opt);
        });

        dlBtn.onclick = () => {
          const selectedUrl = sel.value;
          const chosenVariant = variants.find(v => v.url === selectedUrl);
          const baseNoExt = name.replace(/\.[^.\/]+$/, '');
          const variantName = `${baseNoExt}_${chosenVariant?.label || 'stream'}.mp4`;
          download({ ...it, url: selectedUrl }, dlBtn, statusEl, variantName);
        };
      } else {
        dlBtn.onclick = () => download({ ...it, url: downloadUrl }, dlBtn, statusEl, name);
      }
    }).catch(() => {
      dlBtn.onclick = () => download({ ...it, url: downloadUrl }, dlBtn, statusEl, name);
    });
  } else {
    dlBtn.onclick = () => download({ ...it, url: downloadUrl }, dlBtn, statusEl, name);
  }

  return div;
}

function download(it, btn, statusEl, customFilename) {
  if (btn) { btn.disabled = true; btn.textContent = '⟳ …'; }
  const setMsg = (m, ok) => { if (statusEl) { statusEl.textContent = m; statusEl.className = 'cstatus ' + (ok ? 'ok' : 'err'); } };
  const filename = customFilename || fileName(it);

  if (it.kind === 'dash') { setMsg('DASH needs the backend (final boss) — coming later', false); resetBtn(btn); return; }
  
  if (it.kind === 'hls') {
    const id = 'mux_' + Math.random().toString(36).slice(2);
    muxJobs[id] = { btn, setMsg };
    setMsg('Fetching segments…', true);
    chrome.runtime.sendMessage({ type: 'MUX_HLS', id, url: it.url, filename });
    return;
  }

  // Use the offscreen document to download regular direct files in parallel parts
  const id = 'dl_' + Math.random().toString(36).slice(2);
  muxJobs[id] = { btn, setMsg };
  setMsg('Checking range support…', true);
  chrome.runtime.sendMessage({ type: 'DOWNLOAD_PARALLEL', id, url: it.url, filename });
}

let bulkBusy = false;
async function downloadAllInCat() {
  if (bulkBusy) return;
  bulkBusy = true;
  const cards = [...document.querySelectorAll('#grid .card')];
  for (const c of cards) {
    c.querySelector('.dl').click();
    await new Promise((r) => setTimeout(r, 400)); // gentle stagger
  }
  bulkBusy = false;
}

// helpers
function resetBtn(btn) { if (btn) { btn.disabled = false; btn.textContent = '⬇ Download'; } }
function ext(u) { const m = (u.split('?')[0].match(/\.([a-z0-9]{2,5})$/i)); return m ? m[1].toLowerCase() : ''; }
function fileName(it) {
  try {
    const base = decodeURIComponent(new URL(it.url).pathname.split('/').pop() || '');
    if (base && /\.[a-z0-9]{2,5}$/i.test(base)) return base.slice(0, 180);
  } catch {}
  const e = it.kind === 'hls' || it.kind === 'dash' ? 'mp4' : ext(it.url) || (it.type === 'image' ? 'jpg' : it.type === 'audio' ? 'mp3' : it.type === 'doc' ? 'pdf' : 'mp4');
  return `media_${Date.now().toString().slice(-6)}.${e}`;
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
