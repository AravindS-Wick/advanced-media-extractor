// Popup: one-click downloader. Talks to the local yt-dlp backend (server/server.py),
// which is the universal engine (~1800 sites incl. YouTube/Dailymotion/X/Instagram/
// generic HLS). The extension itself just supplies the current tab URL and a preset.

let SERVER = 'http://127.0.0.1:8787';

const $ = (id) => document.getElementById(id);
let pageUrl = '';
let pollTimer = null;

init();

async function init() {
  const stored = await chrome.storage.local.get('backendUrl');
  if (stored.backendUrl) {
    SERVER = stored.backendUrl;
  }
  $('serverUrlInput').value = SERVER;

  $('toggleSettings').onclick = () => {
    $('settingsPanel').classList.toggle('hidden');
  };
  $('saveServerUrl').onclick = async () => {
    const val = $('serverUrlInput').value.trim();
    if (val) {
      SERVER = val.replace(/\/$/, ''); // strip trailing slash
      await chrome.storage.local.set({ backendUrl: SERVER });
      $('settingsPanel').classList.add('hidden');
      init();
    }
  };

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  pageUrl = tab?.url || '';
  const isWeb = /^https?:\/\//i.test(pageUrl);

  // PRIMARY action — serverless page grabber. Always available on web pages.
  $('grabAll').onclick = () => {
    if (!isWeb) return;
    const u = chrome.runtime.getURL('grabber/grabber.html') +
      '?tabId=' + encodeURIComponent(tab.id) + '&url=' + encodeURIComponent(pageUrl);
    chrome.tabs.create({ url: u });
    window.close();
  };
  if (!isWeb) {
    $('grabAll').disabled = true;
    $('badPage').classList.remove('hidden');
  }

  // The local server is OPTIONAL (only needed for YouTube/streaming one-click).
  const health = isWeb ? await getJSON('/health').catch(() => null) : null;
  if (health && health.ok) {
    $('serverSection').classList.remove('hidden');
    $('serverHint').classList.add('hidden');
    $('serverState').textContent = health.ffmpeg ? '● helper ready' : '● helper (no ffmpeg!)';
    $('serverState').className = 'server-state ' + (health.ffmpeg ? 'ok' : 'warn');
    await resolve();
  } else {
    $('serverSection').classList.add('hidden');
    $('serverHint').classList.remove('hidden');
    $('serverState').textContent = '● serverless mode';
    $('serverState').className = 'server-state ok';
  }
}

async function resolve() {
  $('title').textContent = 'Reading this page…';
  $('presets').innerHTML = '';
  try {
    const info = await getJSON('/resolve?url=' + encodeURIComponent(pageUrl));
    if (info.error) throw new Error(info.error);
    $('title').textContent = info.title || 'media';
    const bits = [];
    if (info.extractor) bits.push(info.extractor);
    if (info.duration) bits.push(fmtDur(info.duration));
    $('sub').textContent = bits.join(' · ');
    if (info.thumbnail) { $('thumb').src = info.thumbnail; $('thumb').classList.remove('hidden'); }
    renderPresets(info);
  } catch (e) {
    $('title').textContent = "Couldn't read media here";
    $('sub').textContent = String(e.message || e).slice(0, 140);
  }
}

function renderPresets(info) {
  const wrap = $('presets');
  wrap.innerHTML = '';
  const heights = info.heights || [];
  const opts = [];
  if (info.hasVideo) {
    opts.push({ preset: 'best', label: '⬇ Best quality', primary: true });
    // Render all unique resolutions found
    const uniqueHeights = [...new Set(heights)].sort((a, b) => b - a);
    uniqueHeights.forEach((h) => {
      let label = h + 'p';
      if (h >= 4320) label = h + 'p (8K)';
      else if (h >= 2160) label = h + 'p (4K)';
      else if (h >= 1440) label = h + 'p (2K)';
      opts.push({ preset: String(h), label });
    });
  }
  if (info.hasAudio) opts.push({ preset: 'audio', label: '🎵 Audio (MP3)' });
  if (opts.length === 0) opts.push({ preset: 'best', label: '⬇ Download' });

  opts.forEach((o) => {
    const b = document.createElement('button');
    b.className = 'btn ' + (o.primary ? 'btn-primary' : 'btn-ghost');
    b.textContent = o.label;
    b.onclick = () => startDownload(o.preset, b);
    wrap.appendChild(b);
  });
}

async function startDownload(preset, btn) {
  document.querySelectorAll('#presets .btn').forEach((b) => (b.disabled = true));
  $('status').textContent = '';
  $('progressWrap').classList.remove('hidden');
  setBar(0, 'Starting…');
  try {
    const { job_id, error } = await postJSON('/download', { url: pageUrl, preset });
    if (error) throw new Error(error);
    poll(job_id);
  } catch (e) {
    fail(String(e.message || e));
  }
}

function poll(jobId) {
  clearInterval(pollTimer);
  pollTimer = setInterval(async () => {
    let job;
    try { job = await getJSON('/progress?id=' + jobId); }
    catch { return; }
    if (job.status === 'running') {
      setBar(job.percent || 0, (job.percent ? job.percent.toFixed(1) + '%' : 'Downloading…'));
    } else if (job.status === 'done') {
      clearInterval(pollTimer);
      setBar(100, 'Done');
      $('status').className = 'status ok';
      $('status').textContent = '✓ Saved to Downloads' + (job.file ? ': ' + job.file : '');
      document.querySelectorAll('#presets .btn').forEach((b) => (b.disabled = false));

      const isLocal = SERVER.includes('127.0.0.1') || SERVER.includes('localhost');
      if (!isLocal && job.file) {
        chrome.downloads.download({
          url: SERVER + '/files?id=' + jobId,
          filename: job.file
        });
      }
    } else if (job.status === 'error') {
      clearInterval(pollTimer);
      fail(job.error || 'download failed');
    }
  }, 700);
}

function fail(msg) {
  $('progressWrap').classList.add('hidden');
  $('status').className = 'status err';
  $('status').textContent = '✗ ' + msg.slice(0, 200);
  document.querySelectorAll('#presets .btn').forEach((b) => (b.disabled = false));
}

function setBar(pct, text) {
  $('bar').style.width = Math.max(2, Math.min(100, pct)) + '%';
  $('progressText').textContent = text;
}

// ── helpers ──
function fmtDur(s) { s = Math.round(s); const m = Math.floor(s / 60), r = s % 60; return m + ':' + String(r).padStart(2, '0'); }

async function getJSON(path) {
  const r = await fetch(SERVER + path);
  return r.json();
}
async function postJSON(path, body) {
  const r = await fetch(SERVER + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  return r.json();
}

$('retry').onclick = () => { $('serverState').className = 'server-state'; init(); };
$('copyCmd').onclick = () => {
  navigator.clipboard.writeText('cd advanced-media-extractor && python3 server/server.py');
  $('copyCmd').textContent = 'Copied';
  setTimeout(() => ($('copyCmd').textContent = 'Copy'), 1200);
};
