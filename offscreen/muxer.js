// Client-side HLS & Media Muxer (v4)
//
// Assembles HLS/fMP4/TS streams and bulk ZIPs entirely in this offscreen
// document. Two rules keep memory flat:
//
//   1. Nothing is accumulated in RAM. Segments and byte-ranges are streamed
//      into an OPFS (Origin Private File System) file as they arrive, and the
//      resulting File handle is disk-backed, so createObjectURL streams off
//      disk instead of materialising the whole video in memory.
//   2. File bytes never cross a chrome.runtime message. The previous bulk-ZIP
//      path sent binaries to the worker as a JSON array of numbers, which
//      amplified size ~8-20x and hit the ~32MB messaging cap.

const activeJobs = new Map(); // id -> { abortController, startTime, filename }
let keepAlivePort = null;
let keepAliveInterval = null;

function ensureKeepAlive() {
  if (!keepAlivePort) {
    try {
      keepAlivePort = chrome.runtime.connect({ name: 'offscreen-keepalive' });
      keepAlivePort.onDisconnect.addListener(() => {
        keepAlivePort = null;
        if (activeJobs.size > 0) ensureKeepAlive();
      });
    } catch (_) {}
  }
  if (!keepAliveInterval) {
    keepAliveInterval = setInterval(() => {
      if (activeJobs.size > 0) {
        if (keepAlivePort) {
          try { keepAlivePort.postMessage({ type: 'PING', activeCount: activeJobs.size }); } catch (_) {}
        } else {
          ensureKeepAlive();
        }
      } else {
        clearInterval(keepAliveInterval);
        keepAliveInterval = null;
        if (keepAlivePort) {
          try { keepAlivePort.disconnect(); } catch (_) {}
          keepAlivePort = null;
        }
      }
    }, 15000);
  }
}

// ──────────────────────────────────────────────
// DISK-BACKED SINK (OPFS)
//
// Available in an offscreen document with no user gesture, unlike
// showSaveFilePicker(). Writes land on disk immediately; the File returned by
// close() is a disk reference, not a memory buffer.
// ──────────────────────────────────────────────
const SCRATCH_PREFIX = 'mep-scratch-';

async function createDiskSink(jobId, mimeType) {
  const root = await navigator.storage.getDirectory();
  const name = SCRATCH_PREFIX + jobId;
  const handle = await root.getFileHandle(name, { create: true });
  const writable = await handle.createWritable();

  return {
    async write(buf) {
      await writable.write(buf);
    },
    async close(overrideMime) {
      await writable.close();
      const file = await handle.getFile();
      const targetMime = overrideMime || mimeType || 'video/mp4';
      return {
        blob: targetMime ? file.slice(0, file.size, targetMime) : file,
        cleanup: async () => {
          try { await root.removeEntry(name); } catch (_) {}
        }
      };
    },
    async abort() {
      try { await writable.abort(); } catch (_) {}
      try { await root.removeEntry(name); } catch (_) {}
    }
  };
}

// Sweep scratch files left behind by a crashed or killed job.
async function sweepScratch() {
  try {
    const root = await navigator.storage.getDirectory();
    for await (const [name] of root.entries()) {
      if (name.startsWith(SCRATCH_PREFIX)) {
        try { await root.removeEntry(name); } catch (_) {}
      }
    }
  } catch (_) {}
}
sweepScratch();

// Cleanup callbacks keyed by job, run once the worker confirms the save.
const pendingCleanups = new Map();

function syncJobToStorage(id, data) {
  try {
    chrome.storage.local.get(['activeDownloadJobs'], (res) => {
      const jobs = res.activeDownloadJobs || {};
      if (data) jobs[id] = { id, ...data, updatedAt: Date.now() };
      else delete jobs[id];
      chrome.storage.local.set({ activeDownloadJobs: jobs });
    });
  } catch (_) {}
}

chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === 'DO_MUX') {
    handleHlsMux(msg).catch((e) => done(msg.id, { error: String(e.message || e) }));
  } else if (msg.type === 'DO_PARALLEL') {
    handleParallelDownload(msg).catch((e) => done(msg.id, { error: String(e.message || e) }));
  } else if (msg.type === 'DO_ZIP') {
    handleZip(msg).catch((e) => done(msg.id, { error: String(e.message || e) }));
  } else if (msg.type === 'DOWNLOAD_SAVED') {
    // Worker confirmed chrome.downloads finished with this blob.
    const cleanup = pendingCleanups.get(msg.id);
    if (cleanup) {
      pendingCleanups.delete(msg.id);
      Promise.resolve(cleanup()).catch(() => {});
    }
  } else if (msg.type === 'CANCEL_MUX' || msg.type === 'CANCEL_DOWNLOAD') {
    const job = activeJobs.get(msg.id);
    if (job && job.abortController) {
      job.abortController.abort();
      activeJobs.delete(msg.id);
      syncJobToStorage(msg.id, null);
      if (job.sink) Promise.resolve(job.sink.abort()).catch(() => {});
      done(msg.id, { error: 'Cancelled by user' });
    }
  }
});

function done(id, payload) {
  const job = activeJobs.get(id);
  activeJobs.delete(id);
  syncJobToStorage(id, null);
  // A failure here (bad playlist, network error, cancel) happens before handOff()
  // ever runs, so it never reaches chrome.downloads and would otherwise vanish
  // the moment the popup/tab that started it closes. Record it explicitly so it
  // shows up in the Downloads history instead of silently disappearing.
  if (payload && payload.error) {
    chrome.runtime.sendMessage({
      type: 'MUX_FAILED',
      id,
      filename: (job && job.filename) || payload.filename || 'media_file',
      error: payload.error,
      jobType: id.startsWith('zip_') ? 'zip' : (id.startsWith('dl_') ? 'file' : 'hls')
    }).catch(() => {});
  }
  chrome.runtime.sendMessage({ type: 'MUX_DONE', id, ...payload }).catch(() => {});
}

function progress(id, progressPayload) {
  syncJobToStorage(id, progressPayload);
  chrome.runtime.sendMessage({ type: 'MUX_PROGRESS', id, ...progressPayload }).catch(() => {});
}

/**
 * Hand a finished blob to the worker, which owns chrome.downloads. The object
 * URL is revoked only after the worker confirms the file is on disk — the old
 * fixed 5-minute timer could fire while a slow write was still in flight.
 */
function handOff(id, blob, filename, extra = {}, cleanup = null) {
  const objectUrl = URL.createObjectURL(blob);
  if (cleanup) pendingCleanups.set(id, async () => { URL.revokeObjectURL(objectUrl); await cleanup(); });
  else pendingCleanups.set(id, async () => URL.revokeObjectURL(objectUrl));

  chrome.runtime.sendMessage({
    type: 'OFFSCREEN_DOWNLOAD',
    id,
    url: objectUrl,
    filename,
    ...extra
  }).catch(() => {});

  // Backstop: if the worker never confirms (it was asleep and the wake failed),
  // release after a generous window so scratch files don't accumulate forever.
  setTimeout(() => {
    const cb = pendingCleanups.get(id);
    if (cb) { pendingCleanups.delete(id); Promise.resolve(cb()).catch(() => {}); }
  }, 15 * 60 * 1000);
}

// ──────────────────────────────────────────────
// HLS
// ──────────────────────────────────────────────
async function handleHlsMux({ id, url, filename, preferredQuality }) {
  ensureKeepAlive();
  const abortController = new AbortController();

  const sink = await createDiskSink(id, null);
  activeJobs.set(id, { abortController, startTime: Date.now(), filename, sink });
  syncJobToStorage(id, { filename, percent: 0, status: 'Starting HLS fetch…' });

  const downloader = new HlsDownloader({ concurrency: 6, maxRetries: 3, retryDelayMs: 800 });

  const result = await downloader.download(url, {
    signal: abortController.signal,
    preferredQuality,
    sink,
    onProgress: (p) => {
      progress(id, {
        filename,
        percent: p.percent || 0,
        downloaded: p.downloaded || 0,
        total: p.total || 0,
        speedMBs: p.speedMBs || 0,
        etaSeconds: p.etaSeconds || 0,
        status: p.status || `Fetching ${p.percent}%…`
      });
    }
  });

  const baseName = (filename || 'video').replace(/\.[^.\/]+$/, '');
  const outName = `${baseName}.${result.container}`;

  handOff(id, result.blob, outName, {
    segments: result.segments,
    container: result.container,
    totalBytes: result.totalBytes
  }, result.cleanup);
}

// ──────────────────────────────────────────────
// DIRECT / PARALLEL FILE DOWNLOAD
// ──────────────────────────────────────────────
async function handleParallelDownload({ id, url, filename }) {
  ensureKeepAlive();
  const abortController = new AbortController();
  const signal = abortController.signal;
  activeJobs.set(id, { abortController, startTime: Date.now(), filename });
  syncJobToStorage(id, { filename, percent: 0, status: 'Starting download…' });

  let totalSize = 0;
  let supportsRange = false;

  try {
    const headRes = await fetch(url, { method: 'HEAD', credentials: 'include', signal });
    if (headRes.ok) {
      const len = headRes.headers.get('content-length');
      if (len) totalSize = parseInt(len, 10);
      const acc = headRes.headers.get('accept-ranges');
      if (acc && acc.toLowerCase() === 'bytes') supportsRange = true;
    }
  } catch (_) {}

  if (totalSize === 0) {
    try {
      const r = await fetch(url, { headers: { Range: 'bytes=0-0' }, credentials: 'include', signal });
      if (r.status === 206) {
        supportsRange = true;
        const cr = r.headers.get('content-range');
        const m = cr && cr.match(/\/(\d+)\s*$/);
        if (m) totalSize = parseInt(m[1], 10);
      }
    } catch (_) {}
  }

  const sink = await createDiskSink(id, null);
  activeJobs.set(id, { abortController, startTime: Date.now(), filename, sink });
  const startTime = Date.now();

  const report = (received) => {
    const elapsed = (Date.now() - startTime) / 1000;
    const speedMBs = elapsed > 0 ? (received / (1024 * 1024)) / elapsed : 0;
    const percent = totalSize > 0 ? Math.min(99, Math.round((received / totalSize) * 100)) : 0;
    progress(id, {
      filename,
      percent,
      speedMBs: parseFloat(speedMBs.toFixed(2)),
      status: totalSize > 0
        ? `Downloading ${percent}% (${speedMBs.toFixed(1)} MB/s)`
        : `Downloading ${(received / (1024 * 1024)).toFixed(1)} MB…`
    });
  };

  // Single sequential stream when the server won't do ranges, or the file is
  // small enough that four connections buy nothing.
  if (!supportsRange || totalSize < 2 * 1024 * 1024) {
    const res = await fetch(url, { credentials: 'include', signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);

    const reader = res.body.getReader();
    let received = 0;
    while (true) {
      const { done: rDone, value } = await reader.read();
      if (rDone) break;
      await sink.write(value);
      received += value.length;
      report(received);
    }

    const cleanName = (filename || 'download').split('?')[0].split('#')[0];
    const m = cleanName.match(/\.([a-z0-9]{2,5})$/i) || (url || '').match(/\.([a-z0-9]{2,5})(\?|#|$)/i);
    const ext = m ? m[1].toLowerCase() : 'mp4';
    let mimeType = 'video/mp4';
    if (['jpg', 'jpeg'].includes(ext)) mimeType = 'image/jpeg';
    else if (ext === 'png') mimeType = 'image/png';
    else if (ext === 'webp') mimeType = 'image/webp';
    else if (ext === 'gif') mimeType = 'image/gif';
    else if (ext === 'svg') mimeType = 'image/svg+xml';
    else if (ext === 'mp3') mimeType = 'audio/mpeg';
    else if (ext === 'm4a') mimeType = 'audio/mp4';
    else if (ext === 'wav') mimeType = 'audio/wav';
    else if (ext === 'ogg') mimeType = 'audio/ogg';
    else if (ext === 'webm') mimeType = 'video/webm';
    else if (ext === 'zip') mimeType = 'application/zip';
    else if (ext === 'pdf') mimeType = 'application/pdf';

    const out = await sink.close(mimeType);
    progress(id, { filename: cleanName, percent: 100, status: 'Finalizing…' });
    handOff(id, out.blob, cleanName, { totalBytes: received }, out.cleanup);
    return;
  }

  // Ranged download. Parts are fetched concurrently but written in order, so
  // only the in-flight window is ever resident rather than the whole file.
  const CONCURRENCY = 4;
  const chunkSize = Math.ceil(totalSize / CONCURRENCY);
  const ranges = [];
  for (let i = 0; i < CONCURRENCY; i++) {
    const start = i * chunkSize;
    const end = Math.min(totalSize - 1, (i + 1) * chunkSize - 1);
    if (start <= end) ranges.push({ start, end });
  }

  let received = 0;
  const partBlobs = new Array(ranges.length);

  await Promise.all(ranges.map(async (r, i) => {
    const response = await fetch(url, {
      headers: { Range: `bytes=${r.start}-${r.end}` },
      credentials: 'include',
      signal
    });
    if (!response.ok && response.status !== 206) {
      throw new Error(`Chunk ${i} failed with status ${response.status}`);
    }

    // Blob() spills to disk under memory pressure, unlike a retained
    // Uint8Array, so parts can be held here until it is their turn to write.
    const reader = response.body.getReader();
    const pieces = [];
    while (true) {
      const { done: rDone, value } = await reader.read();
      if (rDone) break;
      pieces.push(value);
      received += value.length;
      report(received);
    }
    partBlobs[i] = new Blob(pieces);
  }));

  for (const part of partBlobs) {
    await sink.write(await part.arrayBuffer());
  }

  const cleanName = (filename || 'download').split('?')[0].split('#')[0];
  const m = cleanName.match(/\.([a-z0-9]{2,5})$/i) || (url || '').match(/\.([a-z0-9]{2,5})(\?|#|$)/i);
  const ext = m ? m[1].toLowerCase() : 'mp4';
  let mimeType = 'video/mp4';
  if (['jpg', 'jpeg'].includes(ext)) mimeType = 'image/jpeg';
  else if (ext === 'png') mimeType = 'image/png';
  else if (ext === 'webp') mimeType = 'image/webp';
  else if (ext === 'gif') mimeType = 'image/gif';
  else if (ext === 'svg') mimeType = 'image/svg+xml';
  else if (ext === 'mp3') mimeType = 'audio/mpeg';
  else if (ext === 'm4a') mimeType = 'audio/mp4';
  else if (ext === 'wav') mimeType = 'audio/wav';
  else if (ext === 'ogg') mimeType = 'audio/ogg';
  else if (ext === 'webm') mimeType = 'video/webm';
  else if (ext === 'zip') mimeType = 'application/zip';
  else if (ext === 'pdf') mimeType = 'application/pdf';

  const out = await sink.close(mimeType);
  progress(id, { filename: cleanName, percent: 100, status: 'Finalizing…' });
  handOff(id, out.blob, cleanName, { totalBytes: received }, out.cleanup);
}

// ──────────────────────────────────────────────
// BULK ZIP
//
// Runs here rather than in the popup for two reasons: the popup is destroyed
// the moment it loses focus (taking its object URLs with it), and routing file
// bytes through chrome.runtime messages hit the messaging size cap.
// ──────────────────────────────────────────────
async function handleZip({ id, items, filename }) {
  ensureKeepAlive();
  const abortController = new AbortController();
  const signal = abortController.signal;
  activeJobs.set(id, { abortController, startTime: Date.now(), filename });

  const zip = new ZipBuilder();
  let completed = 0;
  const total = (items || []).length;

  for (let i = 0; i < total; i++) {
    if (signal.aborted) throw new Error('Cancelled by user');
    const it = items[i];
    progress(id, { filename, percent: Math.round((i / total) * 90), status: `Fetching ${i + 1}/${total}…` });

    try {
      const res = await fetch(it.url, { credentials: 'include', signal });
      if (!res.ok) continue;
      const buf = await res.arrayBuffer();
      zip.addFile(it.name, new Uint8Array(buf));
      completed++;
    } catch (_) {}
  }

  if (completed === 0) {
    throw new Error('Could not fetch any of the selected files');
  }

  progress(id, { filename, percent: 95, status: 'Generating ZIP…' });
  const zipBlob = zip.build();

  handOff(id, zipBlob, filename || 'media.zip', { totalBytes: zipBlob.size, zipped: completed });
}
