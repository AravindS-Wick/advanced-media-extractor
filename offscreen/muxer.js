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
    // Positional write: lets ranged chunks land straight at their final offset
    // as they arrive, with no reorder buffer and no whole-file staging.
    async writeAt(position, buf) {
      await writable.write({ type: 'write', position, data: buf });
    },
    async truncate(size) {
      await writable.truncate(size);
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

// Offscreen documents only expose chrome.runtime: chrome.storage is undefined
// here, so job state is NOT persisted from this file. Every MUX_PROGRESS /
// MUX_DONE / MUX_FAILED message is mirrored into storage by the service
// worker, which is also what fails jobs orphaned by a restart.

// Cleanup callbacks keyed by job, run once the worker confirms the save.
const pendingCleanups = new Map();

// ── Job slots ──
// Downloads that run all at once split the same bandwidth and the same
// per-host connection limit, so every one of them crawls. Only a couple run at
// a time; the rest wait as "Queued" and start the moment a slot frees up.
let MAX_ACTIVE_JOBS = 2;
let runningSlots = 0;
const slotQueue = [];

function registerJob(id, filename, abortController) {
  const job = { id, abortController, startTime: Date.now(), filename, slotHeld: false };
  activeJobs.set(id, job);
  return job;
}

function acquireSlot(job) {
  if (runningSlots < MAX_ACTIVE_JOBS) {
    runningSlots++;
    job.slotHeld = true;
    return Promise.resolve();
  }
  progress(job.id, { ...(job.last || {}), filename: job.filename, percent: (job.last && job.last.percent) || 0, status: 'Queued' }, true);
  return new Promise((resolve, reject) => {
    const entry = { job, resolve, reject };
    // A job paused before it ever got a slot waits outside the queue, so it
    // cannot start (and hold a slot) while paused.
    if (job.paused) job.parkedEntry = entry;
    else slotQueue.push(entry);
  });
}

// Hand free slots to waiting jobs, never beyond the current limit. Checking the
// limit here (not just in acquireSlot) is what makes lowering it mid-download
// work: running jobs finish on their own, and no waiter starts until the count
// has dropped below the new limit.
function drainQueue() {
  while (runningSlots < MAX_ACTIVE_JOBS && slotQueue.length) {
    const next = slotQueue.shift();
    runningSlots++;
    next.job.slotHeld = true;
    next.resolve();
  }
}

function releaseJobSlot(job) {
  if (!job || !job.slotHeld) return;
  job.slotHeld = false;
  runningSlots--;
  drainQueue();
}

// User-configurable (popup settings). Raising it starts waiting jobs at once.
function setMaxJobs(n) {
  MAX_ACTIVE_JOBS = Math.max(1, Math.min(10, parseInt(n, 10) || 2));
  drainQueue();
}

function dropQueued(id) {
  const i = slotQueue.findIndex((q) => q.job.id === id);
  if (i >= 0) slotQueue.splice(i, 1)[0].reject(new Error('Cancelled by user'));
  const job = activeJobs.get(id);
  if (job && job.parkedEntry) {
    const entry = job.parkedEntry;
    job.parkedEntry = null;
    entry.reject(new Error('Cancelled by user'));
  }
}

chrome.runtime.onMessage.addListener((msg) => {
  if (msg.connections) CONNECTIONS = Math.max(1, Math.min(32, parseInt(msg.connections, 10) || 16));
  if (msg.maxJobs) setMaxJobs(msg.maxJobs); // also carried by SET_MAX_JOBS_APPLY
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
  } else if (msg.type === 'PAUSE_MUX') {
    setPaused(msg.id, true);
  } else if (msg.type === 'RESUME_MUX') {
    setPaused(msg.id, false);
  } else if (msg.type === 'CANCEL_MUX' || msg.type === 'CANCEL_DOWNLOAD') {
    const job = activeJobs.get(msg.id);
    if (job && job.abortController) {
      job.abortController.abort();
      wakeWaiters(job);
      dropQueued(msg.id);
      releaseJobSlot(job);
      activeJobs.delete(msg.id);
      if (job.sink) Promise.resolve(job.sink.abort()).catch(() => {});
      done(msg.id, { error: 'Cancelled by user' });
    }
  }
});

function done(id, payload) {
  const job = activeJobs.get(id);
  releaseJobSlot(job);
  activeJobs.delete(id);
  // A failure here (bad playlist, network error, cancel) happens before handOff()
  // ever runs, so it never reaches chrome.downloads and would otherwise vanish
  // the moment the popup/tab that started it closes. Record it explicitly so it
  // shows up in the Downloads history instead of silently disappearing.
  if (payload && payload.error) {
    // A failed job never reaches handOff, so nothing else would free its scratch file.
    if (job && job.sink) Promise.resolve(job.sink.abort()).catch(() => {});
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

// Every progress message makes the popup re-query the download list, so one
// per finished segment per job is far too chatty. State is always recorded;
// the broadcast is limited to a few per second per job.
const PROGRESS_INTERVAL_MS = 500;

function progress(id, progressPayload, force = false) {
  const job = activeJobs.get(id);
  const paused = !!(job && job.paused);
  const payload = { ...progressPayload, paused, ...(paused ? { status: 'Paused' } : {}) };
  if (job) job.last = progressPayload;

  const now = Date.now();
  if (!force && job && now - (job.lastSent || 0) < PROGRESS_INTERVAL_MS) return;
  if (job) job.lastSent = now;
  chrome.runtime.sendMessage({ type: 'MUX_PROGRESS', id, ...payload }).catch(() => {});
}

// ── Pause / resume ──
// Workers call waitIfPaused() before starting each segment, range or file, so
// a pause lets in-flight pieces finish and then holds the job without
// discarding anything already on disk. Cancel wakes any waiters.
async function waitIfPaused(id) {
  for (;;) {
    const job = activeJobs.get(id);
    // Held until the job is resumed AND has a download slot again.
    if (!job || job.abortController.signal.aborted || (!job.paused && job.slotHeld)) return;
    await new Promise((resolve) => { (job.waiters = job.waiters || []).push(resolve); });
  }
}

function wakeWaiters(job) {
  if (job && job.waiters) job.waiters.splice(0).forEach((r) => r());
}

// A paused download gives its slot back so the next queued one can start;
// resuming takes a slot again, or waits as "Queued" if they are all busy.
function setPaused(id, paused) {
  const job = activeJobs.get(id);
  if (!job || job.paused === paused) return;
  job.paused = paused;
  if (paused) {
    // Still waiting for its first slot: take it out of the queue until resumed.
    const i = slotQueue.findIndex((q) => q.job === job);
    if (i >= 0) job.parkedEntry = slotQueue.splice(i, 1)[0];
    releaseJobSlot(job);
  } else if (job.parkedEntry) {
    slotQueue.push(job.parkedEntry);
    job.parkedEntry = null;
    drainQueue();
  } else if (!job.slotHeld) {
    acquireSlot(job).then(() => wakeWaiters(job)).catch(() => {});
  } else {
    wakeWaiters(job);
  }
  progress(id, job.last || { filename: job.filename, percent: 0 }, true);
}

/**
 * Hand a finished blob to the worker, which owns chrome.downloads. The object
 * URL is revoked only after the worker confirms the file is on disk — the old
 * fixed 5-minute timer could fire while a slow write was still in flight.
 */
function handOff(id, blob, filename, extra = {}, cleanup = null) {
  // Fetching is finished. Without this the job stayed in activeJobs forever:
  // a ghost entry in the Active list, and a keep-alive that never switched off.
  releaseJobSlot(activeJobs.get(id));
  activeJobs.delete(id);

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

  // Backstop only: the worker normally confirms via DOWNLOAD_SAVED. Copying a
  // multi-GB blob to the user's disk can take a long while on a slow drive, and
  // revoking the URL mid-copy would fail the save, so the window is generous.
  setTimeout(() => {
    const cb = pendingCleanups.get(id);
    if (cb) { pendingCleanups.delete(id); Promise.resolve(cb()).catch(() => {}); }
  }, 6 * 60 * 60 * 1000);
}

// ──────────────────────────────────────────────
// HLS
// ──────────────────────────────────────────────
async function handleHlsMux({ id, url, filename, preferredQuality }) {
  ensureKeepAlive();
  const abortController = new AbortController();
  const job = registerJob(id, filename, abortController);
  await acquireSlot(job);

  const sink = await createDiskSink(id, null);
  job.sink = sink;
  progress(id, { filename, percent: 0, status: 'Starting HLS fetch…' }, true);

  // ~1 min of backoff per segment, plus unlimited-ish waiting while offline.
  const downloader = new HlsDownloader({ concurrency: CONNECTIONS, maxRetries: 6, retryDelayMs: 1000 });

  const result = await downloader.download(url, {
    signal: abortController.signal,
    preferredQuality,
    sink,
    waitIfPaused: () => waitIfPaused(id),
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
//
// The file is cut into small ranges that a pool of workers pulls from a shared
// queue, each streamed straight to its final offset in the OPFS file. Compared
// with the old "one quarter of the file per connection" split this:
//   - never idles on the slowest quarter (a worker that finishes just takes the
//     next range), which is what made large files crawl;
//   - retries and resumes a failed range from the byte it reached, instead of
//     failing the whole job on the first dropped connection;
//   - holds only the in-flight chunks in memory, not the whole file.
// ──────────────────────────────────────────────
const RANGE_CHUNK_BYTES = 8 * 1024 * 1024;
let CONNECTIONS = 16; // per download; set from the popup via the service worker
const RANGE_MAX_ATTEMPTS = 8;

const MIME_BY_EXT = {
  jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', gif: 'image/gif',
  svg: 'image/svg+xml', mp3: 'audio/mpeg', m4a: 'audio/mp4', wav: 'audio/wav', ogg: 'audio/ogg',
  webm: 'video/webm', zip: 'application/zip', pdf: 'application/pdf'
};

function mimeForDownload(cleanName, url) {
  const m = cleanName.match(/\.([a-z0-9]{2,5})$/i) || (url || '').match(/\.([a-z0-9]{2,5})(\?|#|$)/i);
  const ext = m ? m[1].toLowerCase() : 'mp4';
  return MIME_BY_EXT[ext] || 'video/mp4';
}

function httpError(status) {
  const e = new Error(`HTTP ${status}`);
  e.status = status;
  return e;
}

function isPermanentHttp(err, attempt) {
  const s = err && err.status;
  return s === 400 || s === 401 || s === 404 || s === 410 || (s === 403 && attempt >= 2);
}

/** Total size and range support. A real 1-byte ranged GET beats trusting Accept-Ranges. */
async function probeRemote(url, signal) {
  try {
    const r = await fetch(url, { headers: { Range: 'bytes=0-0' }, credentials: 'include', signal });
    if (r.status === 206) {
      const cr = r.headers.get('content-range');
      const m = cr && cr.match(/\/(\d+)\s*$/);
      if (m) return { totalSize: parseInt(m[1], 10), supportsRange: true };
    }
    if (r.ok) {
      const len = parseInt(r.headers.get('content-length') || '0', 10);
      if (len > 1) return { totalSize: len, supportsRange: false };
    }
  } catch (e) {
    if (signal.aborted) throw e;
  }
  try {
    const h = await fetch(url, { method: 'HEAD', credentials: 'include', signal });
    if (h.ok) return { totalSize: parseInt(h.headers.get('content-length') || '0', 10) || 0, supportsRange: false };
  } catch (e) {
    if (signal.aborted) throw e;
  }
  return { totalSize: 0, supportsRange: false };
}

/**
 * Stream one range into the sink, resuming from the last byte written whenever
 * the connection drops. Waits out offline periods without burning attempts.
 */
async function downloadRange({ url, start, end, signal, sink, onBytes, gate }) {
  let offset = start;
  let attempt = 0;
  while (offset <= end) {
    try {
      const res = await fetch(url, {
        headers: { Range: `bytes=${offset}-${end}` },
        credentials: 'include',
        signal
      });
      if (res.status !== 206) throw httpError(res.status);

      const reader = res.body.getReader();
      while (true) {
        await gate();
        const { done: rDone, value } = await reader.read();
        if (rDone) break;
        await sink.writeAt(offset, value);
        offset += value.length;
        onBytes(value.length);
        attempt = 0; // progress was made; the link is alive
      }
      if (offset <= end) throw new Error('Connection closed early');
    } catch (err) {
      if (signal.aborted) throw new Error('Cancelled by user');
      attempt++;
      if (isPermanentHttp(err, attempt) || attempt >= RANGE_MAX_ATTEMPTS) throw err;
      await waitForNetwork(signal);
      await abortableSleep(Math.min(1000 * Math.pow(2, attempt - 1), 20000), signal);
    }
  }
}

async function handleParallelDownload({ id, url, filename }) {
  ensureKeepAlive();
  const abortController = new AbortController();
  const signal = abortController.signal;
  const job = registerJob(id, filename, abortController);
  await acquireSlot(job);
  progress(id, { filename, percent: 0, status: 'Starting download…' }, true);

  const { totalSize, supportsRange } = await probeRemote(url, signal);

  const sink = await createDiskSink(id, null);
  job.sink = sink;
  const startTime = Date.now();
  let received = 0;
  const gate = () => waitIfPaused(id);

  const report = () => {
    const elapsed = (Date.now() - startTime) / 1000;
    const speedMBs = elapsed > 0 ? (received / (1024 * 1024)) / elapsed : 0;
    const percent = totalSize > 0 ? Math.min(99, Math.round((received / totalSize) * 100)) : 0;
    const etaSeconds = totalSize > 0 && speedMBs > 0
      ? Math.round((totalSize - received) / (speedMBs * 1024 * 1024))
      : 0;
    progress(id, {
      filename,
      percent,
      speedMBs: parseFloat(speedMBs.toFixed(2)),
      etaSeconds,
      status: totalSize > 0
        ? `Downloading ${percent}% (${speedMBs.toFixed(1)} MB/s)`
        : `Downloading ${(received / (1024 * 1024)).toFixed(1)} MB…`
    });
  };

  // Progress fires per network read; the popup only needs a few updates a second.
  let lastReport = 0;
  const onBytes = (n) => {
    received += n;
    const now = Date.now();
    if (now - lastReport >= 500) { lastReport = now; report(); }
  };

  if (supportsRange && totalSize >= 2 * 1024 * 1024) {
    const ranges = [];
    for (let start = 0; start < totalSize; start += RANGE_CHUNK_BYTES) {
      ranges.push({ start, end: Math.min(totalSize - 1, start + RANGE_CHUNK_BYTES - 1) });
    }
    let next = 0;
    const worker = async () => {
      while (next < ranges.length) {
        await gate();
        const r = ranges[next++];
        await downloadRange({ url, start: r.start, end: r.end, signal, sink, onBytes, gate });
      }
    };
    await Promise.all(Array.from({ length: Math.min(CONNECTIONS, ranges.length) }, worker));
  } else {
    // Server can't do ranges (or the file is tiny): one stream, restarted from
    // zero if it drops, since there is nothing to resume from.
    let attempt = 0;
    while (true) {
      try {
        const res = await fetch(url, { credentials: 'include', signal });
        if (!res.ok) throw httpError(res.status);
        received = 0;
        const reader = res.body.getReader();
        while (true) {
          await gate();
          const { done: rDone, value } = await reader.read();
          if (rDone) break;
          await sink.writeAt(received, value);
          onBytes(value.length);
        }
        await sink.truncate(received);
        break;
      } catch (err) {
        if (signal.aborted) throw new Error('Cancelled by user');
        attempt++;
        if (isPermanentHttp(err, attempt) || attempt >= 4) throw err;
        await waitForNetwork(signal);
        await abortableSleep(Math.min(1000 * Math.pow(2, attempt - 1), 20000), signal);
      }
    }
  }

  const cleanName = (filename || 'download').split('?')[0].split('#')[0];
  const out = await sink.close(mimeForDownload(cleanName, url));
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
  const job = registerJob(id, filename, abortController);
  await acquireSlot(job);

  const zip = new ZipBuilder();
  let completed = 0;
  const total = (items || []).length;

  for (let i = 0; i < total; i++) {
    await waitIfPaused(id);
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
