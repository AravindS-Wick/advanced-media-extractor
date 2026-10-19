const { HlsDownloader } = require('../lib/hls-downloader.js');

// A response whose body never delivers anything until its request is aborted.
function hangingResponse(signal) {
  if (signal.aborted) return Promise.reject(new DOMException('aborted', 'AbortError'));
  return {
    ok: true,
    status: 200,
    body: {
      getReader: () => ({
        read: () => new Promise((_, reject) => {
          const fail = () => reject(new DOMException('aborted', 'AbortError'));
          if (signal.aborted) fail(); else signal.addEventListener('abort', fail);
        })
      })
    }
  };
}

function goodResponse(bytes) {
  let sent = false;
  return {
    ok: true,
    status: 200,
    body: {
      getReader: () => ({
        read: async () => (sent ? { done: true } : (sent = true, { done: false, value: bytes }))
      })
    }
  };
}

describe('HlsDownloader stall watchdog', () => {
  afterEach(() => { jest.useRealTimers(); delete global.fetch; });

  test('abandons a connection that goes silent and retries on a fresh one', async () => {
    jest.useFakeTimers();
    const calls = [];
    global.fetch = jest.fn((url, opts) => {
      calls.push(url);
      return Promise.resolve(calls.length === 1 ? hangingResponse(opts.signal) : goodResponse(new Uint8Array([1, 2, 3])));
    });

    const dl = new HlsDownloader({ maxRetries: 2, retryDelayMs: 10 });
    const p = dl.fetchBytesWithRetry('https://cdn.test/seg1.ts');
    await jest.advanceTimersByTimeAsync(16000); // past the 15s stall limit
    const buf = await p;

    expect(calls).toHaveLength(2);
    expect(new Uint8Array(buf)).toEqual(new Uint8Array([1, 2, 3]));
  });

  test('does not treat a user abort as a stall', async () => {
    const ac = new AbortController();
    global.fetch = jest.fn((url, opts) => (opts.signal.aborted ? Promise.reject(new DOMException('aborted', 'AbortError')) : Promise.resolve(hangingResponse(opts.signal))));
    const dl = new HlsDownloader({ maxRetries: 3, retryDelayMs: 10 });
    const p = dl.fetchBytesWithRetry('https://cdn.test/seg1.ts', { signal: ac.signal });
    ac.abort();
    await expect(p).rejects.toThrow(/aborted by user/);
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });
});
