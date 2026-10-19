// Unit proof for review finding M3 / the "loses 1 of 4 downloads from history"
// bug on #51: the storage.local history buffer is a read-modify-write and must
// be serialized, or concurrent completions clobber each other.
const { loadServiceWorker } = require('./helpers/sw-harness');
const tick = () => new Promise((r) => setTimeout(r, 60));

describe('service worker: concurrent history writes keep every entry (#51)', () => {
  test('four downloads finishing at once all land in the history buffer', async () => {
    // local writes are delayed so an un-serialized read-modify-write would lose
    // all but the last entry.
    const { sw, localStore } = loadServiceWorker({ localSetDelayMs: 5 });
    await Promise.all([1, 2, 3, 4].map((i) =>
      sw.updateDownloadHistory({ id: 'dl_' + i, downloadId: i, filename: `f${i}.mp4`, url: `http://x/f${i}.mp4`, state: 'complete' })
    ));
    await tick();
    const hist = localStore._data.downloadHistory || [];
    const ids = hist.map((h) => h.id).sort();
    expect(ids).toEqual(['dl_1', 'dl_2', 'dl_3', 'dl_4']);
  });
});
