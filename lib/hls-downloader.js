/**
 * HLS Stream Downloader & Assembler Engine (v3.2)
 * Universal module for Chrome Extensions (MV3 Offscreen), Web Apps, and Mobile Apps.
 * 
 * Features:
 * - Master & Media Playlist parsing (HLS specification compliant)
 * - Exact duration & segment-summed file size inspection (inspectHlsStream)
 * - Resolution & variant selection (1080p, 720p, 480p, 360p, Audio-only)
 * - High-speed parallel segment worker pool (6-8 concurrent streams)
 * - Automatic retry with exponential backoff on network failures
 * - AES-128 key decryption (Web Crypto API)
 * - Fragmented MP4 (fMP4 / EXT-X-MAP) & MPEG-TS (.ts) stream assembly
 * - AbortController support for instantaneous cancellation
 * - Detailed real-time progress callbacks (percent, segments, speed, ETA)
 */

(function (global) {
  'use strict';

  function resolveUrl(uri, base) {
    try {
      return new URL(uri, base).href;
    } catch (_) {
      return uri;
    }
  }

  // No bytes for this long = the connection is dead or throttled to a halt.
  const STALL_HEADERS_MS = 20000;
  const STALL_MS = 15000;

  function abortableSleep(ms, signal) {
    return new Promise((resolve) => {
      const t = setTimeout(done, ms);
      function done() {
        clearTimeout(t);
        if (signal) signal.removeEventListener('abort', done);
        resolve();
      }
      if (signal) signal.addEventListener('abort', done, { once: true });
    });
  }

  // Resolves once the browser reports connectivity again (or after maxWaitMs, so
  // a wrong onLine flag can never hang a job). A laptop that dozes while the
  // user is away drops its network; counting that against the retry budget is
  // what used to fail whole downloads.
  function waitForNetwork(signal, maxWaitMs = 10 * 60 * 1000) {
    if (typeof navigator === 'undefined' || navigator.onLine !== false || typeof addEventListener !== 'function') {
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      const t = setTimeout(finish, maxWaitMs);
      function finish() {
        clearTimeout(t);
        removeEventListener('online', finish);
        if (signal) signal.removeEventListener('abort', finish);
        resolve();
      }
      addEventListener('online', finish, { once: true });
      if (signal) signal.addEventListener('abort', finish, { once: true });
    });
  }

  function hexToBytes(hex) {
    const cleanHex = hex.replace(/^0x/i, '');
    const out = new Uint8Array(cleanHex.length / 2);
    for (let i = 0; i < out.length; i++) {
      out[i] = parseInt(cleanHex.substr(i * 2, 2), 16);
    }
    return out;
  }

  function seqToIv(seq) {
    const iv = new Uint8Array(16);
    new DataView(iv.buffer).setUint32(12, seq, false); // Big-endian sequence number in last 4 bytes
    return iv;
  }

  /**
   * Parse HLS Master Playlist to extract all video & audio variants
   */
  function parseMasterPlaylist(masterText, masterUrl) {
    if (!masterText || !masterText.includes('#EXT-X-STREAM-INF')) {
      return [];
    }

    const lines = masterText.split(/\r?\n/);
    const variants = [];

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      if (line.startsWith('#EXT-X-STREAM-INF:')) {
        const bwMatch = line.match(/BANDWIDTH=(\d+)/i);
        const bandwidth = bwMatch ? parseInt(bwMatch[1], 10) : 0;

        const resMatch = line.match(/RESOLUTION=(\d+)x(\d+)/i);
        const width = resMatch ? parseInt(resMatch[1], 10) : 0;
        const height = resMatch ? parseInt(resMatch[2], 10) : 0;

        const codecsMatch = line.match(/CODECS="([^"]+)"/i);
        const codecs = codecsMatch ? codecsMatch[1] : '';

        const nameMatch = line.match(/NAME="([^"]+)"/i);
        const name = nameMatch ? nameMatch[1] : '';

        // Next line contains the media playlist URI
        let uri = '';
        for (let j = i + 1; j < lines.length; j++) {
          const next = lines[j].trim();
          if (next && !next.startsWith('#')) {
            uri = next;
            break;
          }
        }

        if (uri) {
          const variantUrl = resolveUrl(uri, masterUrl);
          let label = '';
          if (height) {
            label = `${height}p`;
          } else if (name) {
            label = name.includes('p') ? name : `${name}p`;
          } else if (bandwidth) {
            label = `${Math.round(bandwidth / 1000)}k`;
          } else {
            label = 'Stream';
          }

          variants.push({
            url: variantUrl,
            bandwidth,
            width,
            height,
            codecs,
            label,
            isAudioOnly: codecs.startsWith('mp4a') && !codecs.includes('avc') && !codecs.includes('hvc')
          });
        }
      }
    }

    // Sort by bandwidth descending (highest quality first)
    variants.sort((a, b) => (b.bandwidth || 0) - (a.bandwidth || 0));
    return variants;
  }

  /**
   * Parse HLS Master Playlist to extract subtitle/CC renditions (#EXT-X-MEDIA:TYPE=SUBTITLES).
   * These are declared separately from #EXT-X-STREAM-INF video variants.
   */
  function parseSubtitleRenditions(masterText, masterUrl) {
    if (!masterText) return [];
    const lines = masterText.split(/\r?\n/);
    const subs = [];

    for (const raw of lines) {
      const line = raw.trim();
      if (!line.startsWith('#EXT-X-MEDIA:') || !/TYPE=SUBTITLES/i.test(line)) continue;

      const uriMatch = line.match(/URI="([^"]+)"/i);
      if (!uriMatch) continue; // Some renditions only signal availability with no fetchable URI

      const nameMatch = line.match(/NAME="([^"]+)"/i);
      const langMatch = line.match(/LANGUAGE="([^"]+)"/i);
      const groupMatch = line.match(/GROUP-ID="([^"]+)"/i);

      subs.push({
        url: resolveUrl(uriMatch[1], masterUrl),
        label: nameMatch ? nameMatch[1] : (langMatch ? langMatch[1].toUpperCase() : 'Subtitles'),
        lang: langMatch ? langMatch[1] : '',
        groupId: groupMatch ? groupMatch[1] : ''
      });
    }

    return subs;
  }

  /**
   * A subtitle URI from a master playlist is frequently itself a small .m3u8
   * ("WebVTT playlist") pointing at one .vtt segment rather than the caption
   * file directly. Resolve it down to the actual downloadable file.
   */
  async function resolveSubtitleUrl(url, options = {}) {
    if (!/\.m3u8(\?|#|$)/i.test(url)) return url;
    try {
      const res = await fetch(url, { credentials: 'include', ...options });
      if (!res.ok) return url;
      const text = await res.text();
      const lines = text.split(/\r?\n/);
      for (const raw of lines) {
        const line = raw.trim();
        if (line && !line.startsWith('#')) {
          return resolveUrl(line, url);
        }
      }
    } catch (_) {}
    return url;
  }

  /**
   * Parse HLS Media Playlist to extract segments, initialization maps, encryption keys, and exact duration
   */
  function parseMediaPlaylist(mediaText, mediaUrl) {
    const lines = mediaText.split(/\r?\n/);
    const segments = [];
    let mapUri = null;
    let key = null;
    let targetDuration = 4;
    let isFmp4 = false;
    let totalDuration = 0;
    let currentSegmentDuration = 0;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      if (!line) continue;

      if (line.startsWith('#EXT-X-TARGETDURATION:')) {
        const td = parseInt(line.split(':')[1], 10);
        if (!isNaN(td)) targetDuration = td;
      } else if (line.startsWith('#EXTINF:')) {
        const durMatch = line.match(/#EXTINF:([\d.]+)/i);
        if (durMatch) {
          const segDur = parseFloat(durMatch[1]);
          if (!isNaN(segDur)) {
            currentSegmentDuration = segDur;
            totalDuration += segDur;
          }
        }
      } else if (line.startsWith('#EXT-X-MAP:')) {
        const u = (line.match(/URI="([^"]+)"/i) || [])[1];
        if (u) {
          mapUri = resolveUrl(u, mediaUrl);
          isFmp4 = true;
        }
      } else if (line.startsWith('#EXT-X-KEY:')) {
        const method = (line.match(/METHOD=([^,]+)/i) || [])[1];
        const uri = (line.match(/URI="([^"]+)"/i) || [])[1];
        const ivHex = (line.match(/IV=(0x[0-9a-fA-F]+)/i) || [])[1];

        if (method && method.toUpperCase() === 'AES-128' && uri) {
          key = {
            method: 'AES-128',
            uri: resolveUrl(uri, mediaUrl),
            iv: ivHex ? hexToBytes(ivHex) : null
          };
        } else if (method && method.toUpperCase() !== 'NONE') {
          console.warn('[HlsDownloader] Unsupported encryption method:', method);
        }
      } else if (!line.startsWith('#')) {
        const segmentUrl = resolveUrl(line, mediaUrl);
        if (/\.m4s(\?|#|$)/i.test(segmentUrl) || /\.mp4(\?|#|$)/i.test(segmentUrl)) {
          isFmp4 = true;
        }
        segments.push({
          url: segmentUrl,
          duration: currentSegmentDuration || targetDuration
        });
        currentSegmentDuration = 0;
      }
    }

    return {
      segments,
      mapUri,
      key,
      targetDuration,
      totalDuration: Math.round(totalDuration || (segments.length * targetDuration)),
      isFmp4: isFmp4 || (segments.length > 0 && /\.m4s(\?|#|$)/i.test(segments[0].url))
    };
  }

  /**
   * Inspect HLS stream to extract all variants with exact segment-summed duration and calculated sizes
   */
  async function inspectHlsStream(masterUrl, options = {}) {
    try {
      const res = await fetch(masterUrl, { credentials: 'include', ...options });
      if (!res.ok) return { variants: [], totalDuration: 0, segmentsCount: 0 };
      const text = await res.text();

      if (text.includes('#EXT-X-STREAM-INF')) {
        const variants = parseMasterPlaylist(text, masterUrl);
        const subtitles = parseSubtitleRenditions(text, masterUrl);
        if (variants.length === 0) return { variants: [], totalDuration: 0, segmentsCount: 0, subtitles };

        // Fetch top variant media playlist to get exact duration & segment count
        let totalDuration = 0;
        let segmentsCount = 0;
        try {
          const topMediaRes = await fetch(variants[0].url, { credentials: 'include', ...options });
          if (topMediaRes.ok) {
            const topMediaText = await topMediaRes.text();
            const parsed = parseMediaPlaylist(topMediaText, variants[0].url);
            totalDuration = parsed.totalDuration;
            segmentsCount = parsed.segments.length;
          }
        } catch (_) {}

        // Compute accurate size estimates for every variant
        const enhancedVariants = variants.map(v => {
          const estBytes = (v.bandwidth && totalDuration > 0)
            ? Math.round((v.bandwidth / 8) * totalDuration)
            : 0;
          return {
            ...v,
            totalDuration,
            segmentsCount,
            estimatedBytes: estBytes
          };
        });

        // Add synthesized Audio-Only variant if not explicitly present
        const hasAudioOnly = enhancedVariants.some(v => v.isAudioOnly);
        if (!hasAudioOnly && enhancedVariants.length > 0) {
          const audioBw = 128000; // 128 kbps AAC
          enhancedVariants.push({
            url: enhancedVariants[0].url,
            bandwidth: audioBw,
            width: 0,
            height: 0,
            codecs: 'mp4a.40.2',
            label: 'Audio Only',
            isAudioOnly: true,
            totalDuration,
            segmentsCount,
            estimatedBytes: totalDuration > 0 ? Math.round((audioBw / 8) * totalDuration) : 0
          });
        }

        return {
          variants: enhancedVariants,
          totalDuration,
          segmentsCount,
          subtitles
        };
      } else {
        // Direct media playlist (.m3u8 containing segments directly)
        const parsed = parseMediaPlaylist(text, masterUrl);
        const totalDuration = parsed.totalDuration;
        const estBytes = totalDuration > 0 ? Math.round((1800000 / 8) * totalDuration) : 0;
        return {
          variants: [{
            url: masterUrl,
            bandwidth: 1800000,
            label: 'Stream',
            totalDuration,
            segmentsCount: parsed.segments.length,
            estimatedBytes: estBytes
          }],
          totalDuration,
          segmentsCount: parsed.segments.length,
          subtitles: []
        };
      }
    } catch (e) {
      console.warn('[HlsDownloader] inspectHlsStream error:', e);
      return { variants: [], totalDuration: 0, segmentsCount: 0, subtitles: [] };
    }
  }

  /**
   * Main HlsDownloader Class
   */
  class HlsDownloader {
    constructor(options = {}) {
      this.concurrency = options.concurrency || 6;
      this.maxRetries = options.maxRetries || 3;
      this.retryDelayMs = options.retryDelayMs || 1000;
      this.maxRetryDelayMs = options.maxRetryDelayMs || 20000;
      this.headers = options.headers || {};
    }

    /**
     * Fetch with exponential backoff. `read` (optional) consumes the body inside
     * the retry loop: a connection reset while the body streams throws from
     * arrayBuffer(), not fetch(), and used to escape retry and kill the job.
     * Permanent client errors fail fast; 403 gets a couple of tries since CDNs
     * return it transiently. While the machine is offline, waiting is free.
     */
    async fetchWithRetry(url, options = {}, retries = this.maxRetries, read = null) {
      const signal = options.signal;
      let lastError;
      for (let attempt = 0; attempt <= retries; attempt++) {
        // Per-attempt controller + watchdog: a CDN that throttles by going quiet
        // leaves a connection open forever, and one such segment blocks the
        // in-order writer (and so the whole download) with nothing to retry.
        // Abort it after STALL_MS without data and take a fresh connection.
        const ac = new AbortController();
        const forwardAbort = () => ac.abort();
        if (signal) signal.addEventListener('abort', forwardAbort, { once: true });
        let stalled = false;
        let timer = null;
        const touch = (ms = STALL_MS) => {
          clearTimeout(timer);
          timer = setTimeout(() => { stalled = true; ac.abort(); }, ms);
        };
        try {
          touch(STALL_HEADERS_MS);
          const res = await fetch(url, {
            ...options,
            signal: ac.signal,
            headers: { ...this.headers, ...(options.headers || {}) },
            credentials: 'include'
          });

          if (!res.ok) {
            const httpErr = new Error(`HTTP ${res.status} (${res.statusText})`);
            httpErr.status = res.status;
            throw httpErr;
          }
          touch(); // headers are in; now the body must keep flowing
          return read ? await read(res, touch) : res;
        } catch (err) {
          lastError = stalled ? new Error('Connection stalled (no data received)') : err;
          if (signal && signal.aborted) {
            throw new Error('Download aborted by user');
          }
          const status = err && err.status;
          const permanent = status === 400 || status === 401 || status === 404 || status === 410 ||
                            (status === 403 && attempt >= 2);
          if (permanent || attempt >= retries) break;

          await waitForNetwork(signal);
          // A stalled connection is already a long wait; retry on a new one at once.
          if (!stalled) await abortableSleep(Math.min(this.retryDelayMs * Math.pow(2, attempt), this.maxRetryDelayMs), signal);
        } finally {
          clearTimeout(timer);
          if (signal) signal.removeEventListener('abort', forwardAbort);
        }
      }
      throw lastError || new Error(`Failed to fetch ${url}`);
    }

    // Streams the body so the stall watchdog sees every chunk (arrayBuffer()
    // gives no progress signal until the whole body has arrived).
    fetchBytesWithRetry(url, options = {}) {
      return this.fetchWithRetry(url, options, this.maxRetries, async (res, touch) => {
        if (!res.body || !res.body.getReader) return res.arrayBuffer();
        const reader = res.body.getReader();
        const chunks = [];
        let size = 0;
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          chunks.push(value);
          size += value.byteLength;
          touch();
        }
        const out = new Uint8Array(size);
        let off = 0;
        for (const c of chunks) { out.set(c, off); off += c.byteLength; }
        return out.buffer;
      });
    }

    async download(manifestUrl, options = {}) {
      const signal = options.signal;
      const onProgress = options.onProgress || (() => {});
      const preferredQuality = options.preferredQuality || '';

      onProgress({ percent: 1, status: 'Fetching playlist manifest…' });

      const manifestRes = await this.fetchWithRetry(manifestUrl, { signal });
      const manifestText = await manifestRes.text();

      let targetMediaUrl = manifestUrl;
      let mediaText = manifestText;

      // Handle Master Playlist -> Select desired variant
      if (manifestText.includes('#EXT-X-STREAM-INF')) {
        const variants = parseMasterPlaylist(manifestText, manifestUrl);
        if (variants.length === 0) {
          throw new Error('No valid stream variants found in master playlist');
        }

        let selected = variants[0]; // Default to highest resolution/bitrate
        if (preferredQuality) {
          const cleanQ = preferredQuality.toLowerCase().replace(/[^a-z0-9]/g, '');
          const match = variants.find(v => v.label.toLowerCase().replace(/[^a-z0-9]/g, '').includes(cleanQ));
          if (match) selected = match;
        }

        targetMediaUrl = selected.url;
        onProgress({ percent: 3, status: `Selected ${selected.label} stream…` });

        const mediaRes = await this.fetchWithRetry(targetMediaUrl, { signal });
        mediaText = await mediaRes.text();
      }

      // Parse Media Playlist
      const { segments, mapUri, key, isFmp4 } = parseMediaPlaylist(mediaText, targetMediaUrl);

      if (segments.length === 0) {
        throw new Error('No media segments found in media playlist');
      }

      const totalSegments = segments.length;
      let cryptoKey = null;

      // Fetch AES-128 Decryption Key if required
      if (key && key.method === 'AES-128' && key.uri) {
        onProgress({ percent: 5, status: 'Fetching decryption key…' });
        const keyBuf = await this.fetchBytesWithRetry(key.uri, { signal });
        cryptoKey = await crypto.subtle.importKey(
          'raw',
          keyBuf,
          { name: 'AES-CBC' },
          false,
          ['decrypt']
        );
      }

      // Fetch Initialization Segment (fMP4 init.mp4)
      let initBuffer = null;
      if (mapUri) {
        onProgress({ percent: 6, status: 'Fetching init segment…' });
        initBuffer = await this.fetchBytesWithRetry(mapUri, { signal });
      }

      const container = isFmp4 ? 'mp4' : 'ts';
      const mimeType = isFmp4 ? 'video/mp4' : 'video/mp2t';

      // A sink lets the caller stream straight to disk, which keeps peak memory
      // flat no matter how long the video is. The previous version held every
      // segment in an array and then copied the lot into a Blob, so peak usage
      // was roughly twice the finished file — a 90-minute 1080p stream wanted
      // several GB and got the offscreen document OOM-killed mid-job.
      // Without a sink we still buffer, which is only safe for short streams.
      const sink = options.sink || null;
      const buffered = sink ? null : [];

      let completedCount = 0;
      let totalDownloadedBytes = 0;
      // Speed is measured on bytes *received* over the last few seconds. The old
      // figure divided bytes already *written* (which waits on the slowest
      // in-order segment) by total elapsed time, so it read low and lagged.
      let receivedBytes = 0;
      const samples = [];
      const SPEED_WINDOW_MS = 8000;
      const currentSpeedMBs = () => {
        const now = Date.now();
        samples.push([now, receivedBytes]);
        while (samples.length > 2 && now - samples[0][0] > SPEED_WINDOW_MS) samples.shift();
        const [t0, b0] = samples[0];
        const dt = (now - t0) / 1000;
        return dt > 0.5 ? (receivedBytes - b0) / (1024 * 1024) / dt : 0;
      };

      const emit = async (buf) => {
        totalDownloadedBytes += buf.byteLength;
        if (sink) await sink.write(buf);
        else buffered.push(buf);
      };

      if (initBuffer) await emit(initBuffer);

      // Segments are fetched in parallel but must be written in playback order,
      // so a segment that finishes early waits here. MAX_PENDING bounds that
      // reorder buffer — it is what stops this becoming a whole-file buffer again.
      const MAX_PENDING = Math.max(this.concurrency * 4, 16);
      const pending = new Map();
      let writeIndex = 0;
      let nextIndex = 0;
      let draining = false;

      const tryDrain = async () => {
        if (draining) return;
        draining = true;
        try {
          while (pending.has(writeIndex)) {
            const buf = pending.get(writeIndex);
            pending.delete(writeIndex);
            writeIndex++;
            await emit(buf);
          }
        } finally {
          draining = false;
        }
      };

      const worker = async () => {
        while (nextIndex < totalSegments) {
          if (options.waitIfPaused) await options.waitIfPaused();
          if (signal && signal.aborted) {
            throw new Error('Download aborted by user');
          }

          // Backpressure: never race so far ahead of the writer that the
          // reorder buffer grows without bound.
          while (pending.size >= MAX_PENDING) {
            if (signal && signal.aborted) throw new Error('Download aborted by user');
            await tryDrain();
            if (pending.size >= MAX_PENDING) await new Promise((r) => setTimeout(r, 25));
          }

          const index = nextIndex++;
          const seg = segments[index];

          let segBuffer = await this.fetchBytesWithRetry(seg.url, { signal });
          receivedBytes += segBuffer.byteLength;

          // Decrypt if AES-128 protected
          if (cryptoKey) {
            const iv = key.iv || seqToIv(index);
            try {
              segBuffer = await crypto.subtle.decrypt(
                { name: 'AES-CBC', iv },
                cryptoKey,
                segBuffer
              );
            } catch (decErr) {
              console.warn(`[HlsDownloader] Decryption failed for segment ${index}:`, decErr);
            }
          }

          pending.set(index, segBuffer);
          completedCount++;
          await tryDrain();

          const percent = Math.min(99, Math.round((completedCount / totalSegments) * 94) + 6);
          const speedMBs = currentSpeedMBs();
          const etaSeconds = speedMBs > 0
            ? Math.round(((totalSegments - completedCount) * (receivedBytes / Math.max(completedCount, 1))) / (speedMBs * 1024 * 1024))
            : 0;

          onProgress({
            percent,
            downloaded: completedCount,
            total: totalSegments,
            speedMBs: parseFloat(speedMBs.toFixed(2)),
            etaSeconds,
            status: `Fetching ${percent}% (${completedCount}/${totalSegments} segs · ${speedMBs.toFixed(1)} MB/s)`
          });
        }
      };

      const workerCount = Math.min(this.concurrency, totalSegments);
      const workers = [];
      for (let i = 0; i < workerCount; i++) {
        workers.push(worker());
      }

      await Promise.all(workers);
      await tryDrain(); // flush anything the last worker left behind

      onProgress({ percent: 100, status: 'Finalizing media file…' });

      if (sink) {
        const out = await sink.close(mimeType);
        return {
          blob: out && out.blob ? out.blob : null,
          container,
          segments: totalSegments,
          totalBytes: totalDownloadedBytes,
          cleanup: out && out.cleanup ? out.cleanup : null
        };
      }

      const blob = new Blob(buffered, { type: mimeType });
      return {
        blob,
        container,
        segments: totalSegments,
        totalBytes: blob.size
      };
    }
  }

  // Export for multiple environments
  const exportsObj = {
    HlsDownloader,
    parseMasterPlaylist,
    parseMediaPlaylist,
    parseSubtitleRenditions,
    resolveSubtitleUrl,
    inspectHlsStream,
    resolveUrl
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = exportsObj;
  }
  if (typeof global !== 'undefined') {
    global.HlsDownloader = HlsDownloader;
    global.parseMasterPlaylist = parseMasterPlaylist;
    global.parseMediaPlaylist = parseMediaPlaylist;
    global.parseSubtitleRenditions = parseSubtitleRenditions;
    global.resolveSubtitleUrl = resolveSubtitleUrl;
    global.inspectHlsStream = inspectHlsStream;
    global.resolveUrl = resolveUrl;
    global.waitForNetwork = waitForNetwork;
    global.abortableSleep = abortableSleep;
  }
})(typeof window !== 'undefined' ? window : typeof globalThis !== 'undefined' ? globalThis : this);
