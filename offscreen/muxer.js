// Client-side HLS muxer (no server / no ffmpeg).
// Downloads an .m3u8: picks the best variant, fetches every segment, decrypts
// AES-128 if needed, concatenates them, and saves a single playable file:
//   • fragmented-MP4 (init + .m4s segments)  -> one .mp4
//   • MPEG-TS (.ts segments)                 -> one .ts (plays in VLC / most players)
// SAMPLE-AES, DRM and DASH are out of scope (the "final boss" backend handles those).

chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === 'DO_MUX') {
    // success path emits OFFSCREEN_DOWNLOAD -> SW finalizes; only report errors here
    muxHls(msg).catch((e) => done(msg.id, { error: String(e.message || e) }));
  } else if (msg.type === 'DO_PARALLEL') {
    downloadParallel(msg).catch((e) => done(msg.id, { error: String(e.message || e) }));
  }
});

function done(id, payload) { chrome.runtime.sendMessage({ type: 'MUX_DONE', id, ...payload }).catch(() => {}); }
function progress(id, percent) { chrome.runtime.sendMessage({ type: 'MUX_PROGRESS', id, percent }).catch(() => {}); }
const abs = (uri, base) => new URL(uri, base).href;

async function fetchBuf(url) {
  const r = await fetch(url, { credentials: 'include' });
  if (!r.ok) throw new Error('HTTP ' + r.status + ' fetching a segment');
  return r.arrayBuffer();
}

function pickBestVariant(masterText, baseUrl) {
  const lines = masterText.split(/\r?\n/);
  let best = null, bestBw = -1;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].startsWith('#EXT-X-STREAM-INF')) {
      const bw = parseInt((lines[i].match(/BANDWIDTH=(\d+)/) || [])[1] || '0', 10);
      const uri = (lines[i + 1] || '').trim();
      if (uri && !uri.startsWith('#') && bw >= bestBw) { bestBw = bw; best = uri; }
    }
  }
  return best ? abs(best, baseUrl) : baseUrl;
}

function parseMedia(text, baseUrl) {
  const lines = text.split(/\r?\n/);
  const segments = [];
  let mapUri = null, key = null;
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith('#EXT-X-MAP:')) {
      const u = (line.match(/URI="([^"]+)"/) || [])[1];
      if (u) mapUri = abs(u, baseUrl);
    } else if (line.startsWith('#EXT-X-KEY:')) {
      const method = (line.match(/METHOD=([^,]+)/) || [])[1];
      const uri = (line.match(/URI="([^"]+)"/) || [])[1];
      const ivHex = (line.match(/IV=0x([0-9a-fA-F]+)/) || [])[1];
      if (method && method.toUpperCase() === 'AES-128' && uri) {
        key = { uri: abs(uri, baseUrl), iv: ivHex ? hexToBytes(ivHex) : null };
      } else if (method && method.toUpperCase() !== 'NONE') {
        throw new Error('Unsupported HLS encryption: ' + method);
      }
    } else if (!line.startsWith('#')) {
      segments.push(abs(line, baseUrl));
    }
  }
  return { segments, mapUri, key };
}

async function muxHls({ id, url, filename }) {
  // master -> media playlist
  const firstText = await (await fetch(url, { credentials: 'include' })).text();
  const mediaUrl = firstText.includes('#EXT-X-STREAM-INF') ? pickBestVariant(firstText, url) : url;
  const mediaText = mediaUrl === url ? firstText : await (await fetch(mediaUrl, { credentials: 'include' })).text();

  const { segments, mapUri, key } = parseMedia(mediaText, mediaUrl);
  if (!segments.length) throw new Error('No segments found in playlist');

  const parts = [];
  if (mapUri) parts.push(await fetchBuf(mapUri));

  let cryptoKey = null;
  if (key) cryptoKey = await crypto.subtle.importKey('raw', await fetchBuf(key.uri), 'AES-CBC', false, ['decrypt']);

  for (let i = 0; i < segments.length; i++) {
    let buf = await fetchBuf(segments[i]);
    if (cryptoKey) {
      const iv = key.iv || seqIv(i); // default IV = media sequence number
      buf = await crypto.subtle.decrypt({ name: 'AES-CBC', iv }, cryptoKey, buf);
    }
    parts.push(buf);
    if (i % 3 === 0 || i === segments.length - 1) progress(id, ((i + 1) / segments.length) * 100);
  }

  const isFmp4 = !!mapUri || /\.m4s(\?|#|$)/i.test(segments[0]) || /\.mp4(\?|#|$)/i.test(segments[0]);
  const blob = new Blob(parts, { type: isFmp4 ? 'video/mp4' : 'video/mp2t' });
  const objectUrl = URL.createObjectURL(blob);
  const outName = filename.replace(/\.[^.\/]+$/, '') + (isFmp4 ? '.mp4' : '.ts');

  // chrome.downloads isn't available in offscreen documents — hand the blob URL to
  // the service worker, which performs the actual download.
  chrome.runtime.sendMessage({ type: 'OFFSCREEN_DOWNLOAD', id, url: objectUrl, filename: outName,
    segments: segments.length, container: isFmp4 ? 'mp4' : 'ts' });
  setTimeout(() => URL.revokeObjectURL(objectUrl), 180000);
  return null; // final MUX_DONE is emitted by the service worker after the download starts
}

function hexToBytes(hex) {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.substr(i * 2, 2), 16);
  return out;
}
function seqIv(seq) {
  const iv = new Uint8Array(16);
  new DataView(iv.buffer).setUint32(12, seq); // big-endian sequence in last 4 bytes
  return iv;
}

async function downloadParallel({ id, url, filename }) {
  let totalSize = 0;
  let supportsRange = false;
  
  // 1. Try HEAD request to inspect size & range capability
  try {
    const res = await fetch(url, { method: 'HEAD', credentials: 'include' });
    if (res.ok) {
      const len = res.headers.get('content-length');
      if (len) totalSize = parseInt(len, 10);
      const acc = res.headers.get('accept-ranges');
      if (acc && acc.toLowerCase() === 'bytes') supportsRange = true;
    }
  } catch (e) {
    console.log('HEAD request failed, trying GET fallback');
  }

  // 2. GET fallback with tiny range to test Accept-Ranges
  if (totalSize === 0) {
    try {
      const res = await fetch(url, { headers: { 'Range': 'bytes=0-0' }, credentials: 'include' });
      if (res.status === 206) {
        supportsRange = true;
        const cr = res.headers.get('content-range');
        if (cr) {
          const match = cr.match(/\/(\d+)$/);
          if (match) totalSize = parseInt(match[1], 10);
        }
      }
    } catch (e) {}
  }

  // 3. Fallback: single-thread downloader for tiny/unsized files or non-range CDNs
  if (!supportsRange || totalSize < 1024 * 1024) {
    progress(id, 25);
    const buf = await fetchBuf(url);
    progress(id, 100);
    const blob = new Blob([buf]);
    const objectUrl = URL.createObjectURL(blob);
    chrome.runtime.sendMessage({ type: 'OFFSCREEN_DOWNLOAD', id, url: objectUrl, filename });
    setTimeout(() => URL.revokeObjectURL(objectUrl), 180000);
    return;
  }

  // 4. Parallel chunked download (4 parts)
  const CONCURRENCY = 4;
  const chunkSize = Math.ceil(totalSize / CONCURRENCY);
  const promises = [];
  const progressTrack = new Array(CONCURRENCY).fill(0);

  for (let i = 0; i < CONCURRENCY; i++) {
    const start = i * chunkSize;
    const end = Math.min(totalSize - 1, (i + 1) * chunkSize - 1);

    const fetchPart = async () => {
      const response = await fetch(url, {
        headers: { 'Range': `bytes=${start}-${end}` },
        credentials: 'include'
      });
      if (!response.ok && response.status !== 206) {
        throw new Error(`Failed fetching chunk ${i}: status ${response.status}`);
      }

      const reader = response.body.getReader();
      const chunks = [];
      let received = 0;

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
        received += value.length;
        progressTrack[i] = received / (end - start + 1);

        const totalProgress = (progressTrack.reduce((sum, p) => sum + p, 0) / CONCURRENCY) * 100;
        progress(id, totalProgress);
      }

      const partBuffer = new Uint8Array(received);
      let offset = 0;
      for (const chunk of chunks) {
        partBuffer.set(chunk, offset);
        offset += chunk.length;
      }
      return partBuffer.buffer;
    };

    promises.push(fetchPart());
  }

  const buffers = await Promise.all(promises);
  const blob = new Blob(buffers);
  const objectUrl = URL.createObjectURL(blob);

  chrome.runtime.sendMessage({ type: 'OFFSCREEN_DOWNLOAD', id, url: objectUrl, filename });
  setTimeout(() => URL.revokeObjectURL(objectUrl), 180000);
}
