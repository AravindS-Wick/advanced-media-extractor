// Unit proof for review finding H2 on #44: a private (incognito) download must
// never be written to persistent storage.local, including when the service
// worker restarts mid-download and re-syncs in-progress downloads.
const { loadServiceWorker } = require('./helpers/sw-harness');

const tick = () => new Promise((r) => setTimeout(r, 30));

describe('service worker: incognito downloads never hit storage.local (H2)', () => {
  test('re-sync does not persist a private in-progress download, but keeps a normal one', async () => {
    const { sw, localStore } = loadServiceWorker({
      sessionInit: { privateIds: ['dl_42'] }, // marked private before the restart
      downloads: {
        complete: [],
        in_progress: [
          { id: 42, incognito: false, url: 'http://x/secret.mp4', filename: 'C:/u/secret.mp4', totalBytes: 100, bytesReceived: 10 },
          { id: 7, incognito: false, url: 'http://x/public.mp4', filename: 'C:/u/public.mp4', totalBytes: 100, bytesReceived: 10 }
        ]
      }
    });
    await sw.initDownloadTracking();
    await tick();
    const active = localStore._data.activeDownloads || {};
    expect(active['dl_42']).toBeUndefined(); // private → not on disk
    expect(active['dl_7']).toBeDefined();    // normal → tracked
  });

  test('a private entry a previous version leaked to storage.local is purged on re-sync', async () => {
    const { sw, localStore } = loadServiceWorker({
      sessionInit: { privateIds: ['dl_42'] },
      localInit: { activeDownloads: { 'dl_42': { id: 'dl_42', url: 'http://x/secret.mp4', state: 'in_progress' } } },
      downloads: { in_progress: [{ id: 42, incognito: false, url: 'http://x/secret.mp4', totalBytes: 100, bytesReceived: 10 }] }
    });
    await sw.initDownloadTracking();
    await tick();
    expect((localStore._data.activeDownloads || {})['dl_42']).toBeUndefined();
  });

  test('"Don\'t keep history" (retention -1) keeps updateDownloadHistory from writing', async () => {
    const { sw, localStore } = loadServiceWorker({ localInit: { historyRetentionDays: -1 } });
    await sw.updateDownloadHistory({ id: 'dl_9', downloadId: 9, filename: 'a.mp4', url: 'http://x/a.mp4', state: 'complete' });
    await tick();
    expect(localStore._data.downloadHistory || []).toHaveLength(0);
  });
});
