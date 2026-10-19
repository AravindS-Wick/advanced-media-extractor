// Unit proof for review finding on #52: private (incognito) downloads must be
// shown to an incognito caller only — never merged into a normal popup/grabber.
const { loadServiceWorker } = require('./helpers/sw-harness');

function setup() {
  return loadServiceWorker({
    dbItems: [{ id: 'dl_n', filename: 'normal.mp4', state: 'complete' }],
    sessionInit: {
      activeDownloads: { dl_p: { id: 'dl_p', filename: 'secret.mp4', state: 'in_progress', private: true } },
      privateHistory: [{ id: 'dl_p', filename: 'secret.mp4', state: 'complete' }]
    },
    localInit: {
      activeDownloads: { dl_n: { id: 'dl_n', filename: 'normal.mp4', state: 'in_progress' } }
    }
  });
}

describe('service worker: GET_DOWNLOADS scopes private data to incognito callers (#52)', () => {
  test('a normal caller sees no private downloads or private history', async () => {
    const { dispatch } = setup();
    const resp = await dispatch({ type: 'GET_DOWNLOADS', filter: 'all', incognito: false });
    expect(resp.ok).toBe(true);
    const activeIds = resp.active.map((a) => a.id);
    const histIds = resp.history.map((h) => h.id);
    expect(activeIds).not.toContain('dl_p');
    expect(histIds).not.toContain('dl_p');
    expect(activeIds).toContain('dl_n'); // normal download still shown
  });

  test('an incognito caller sees the private downloads and private history', async () => {
    const { dispatch } = setup();
    const resp = await dispatch({ type: 'GET_DOWNLOADS', filter: 'all', incognito: true });
    expect(resp.ok).toBe(true);
    expect(resp.active.map((a) => a.id)).toContain('dl_p');
    expect(resp.history.map((h) => h.id)).toContain('dl_p');
  });

  test('a content-script sender in an incognito tab also sees private data', async () => {
    const { dispatch } = setup();
    const resp = await dispatch({ type: 'GET_DOWNLOADS', filter: 'all' }, { tab: { incognito: true } });
    expect(resp.active.map((a) => a.id)).toContain('dl_p');
  });
});
