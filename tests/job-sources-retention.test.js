// Unit proof for review finding M1 on #46: jobSources (remembered source URL +
// page per download) is history too, so it must honour retention, Clear history
// and per-item erase instead of leaving visited URLs on disk.
const { loadServiceWorker } = require('./helpers/sw-harness');
const tick = () => new Promise((r) => setTimeout(r, 10));

describe('service worker: jobSources respects retention/clear/erase (#46)', () => {
  test('saveJobSource writes nothing when retention is "Don\'t keep history" (-1)', async () => {
    const { sw } = loadServiceWorker({ localInit: { historyRetentionDays: -1 } });
    await sw.saveJobSource('dl_1', { url: 'http://x/a.mp4', pageUrl: 'http://x/page', kind: 'file' });
    expect(await sw.getJobSource('dl_1')).toBeNull();
  });

  test('saveJobSource stores when retention is forever (0), clear wipes it', async () => {
    const { sw } = loadServiceWorker({ localInit: { historyRetentionDays: 0 } });
    await sw.saveJobSource('dl_2', { url: 'http://x/a.mp4', pageUrl: 'http://x/page', kind: 'file' });
    expect(await sw.getJobSource('dl_2')).toMatchObject({ url: 'http://x/a.mp4' });
    await sw.clearJobSources();
    expect(await sw.getJobSource('dl_2')).toBeNull();
  });

  test('removeJobSources deletes just the erased item', async () => {
    const { sw } = loadServiceWorker({ localInit: { historyRetentionDays: 0 } });
    await sw.saveJobSource('dl_3', { url: 'http://x/a', pageUrl: 'p', kind: 'file' });
    await sw.saveJobSource('dl_4', { url: 'http://x/b', pageUrl: 'p', kind: 'file' });
    await sw.removeJobSources('dl_3', null);
    expect(await sw.getJobSource('dl_3')).toBeNull();
    expect(await sw.getJobSource('dl_4')).toMatchObject({ url: 'http://x/b' });
  });

  test('pruneJobSources drops entries older than the cutoff', async () => {
    const { sw, localStore } = loadServiceWorker({ localInit: { historyRetentionDays: 0 } });
    await sw.saveJobSource('dl_old', { url: 'http://x/old', pageUrl: 'p', kind: 'file' });
    // backdate it well past the cutoff
    localStore._data.jobSources.dl_old.savedAt = Date.now() - 100 * 86400000;
    await sw.saveJobSource('dl_new', { url: 'http://x/new', pageUrl: 'p', kind: 'file' });
    await sw.pruneJobSources(Date.now() - 30 * 86400000);
    expect(await sw.getJobSource('dl_old')).toBeNull();
    expect(await sw.getJobSource('dl_new')).toMatchObject({ url: 'http://x/new' });
  });
});
