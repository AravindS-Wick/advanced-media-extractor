// Drives service-worker.js against an in-memory chrome mock: the Active list,
// history and incognito handling are all stateful and have regressed before.
const vm = require('vm');
const fs = require('fs');
const path = require('path');

function setup({ incognitoWindow = false } = {}) {
  const mem = { local: {}, session: {} };
  const clone = (v) => JSON.parse(JSON.stringify(v));
  const store = (area) => ({
    get: (keys, cb) => {
      const pr = (async () => {
        if (keys == null) return clone(mem[area]);
        const ks = typeof keys === 'string' ? [keys] : Array.isArray(keys) ? keys : Object.keys(keys);
        const o = {};
        ks.forEach((k) => { if (k in mem[area]) o[k] = clone(mem[area][k]); });
        return o;
      })();
      if (cb) { pr.then(cb); return undefined; }
      return pr;
    },
    set: async (o, cb) => { Object.assign(mem[area], clone(o)); if (cb) cb(); }
  });
  const ev = () => { const l = []; return { l, addListener: (f) => l.push(f), removeListener: (f) => { const i = l.indexOf(f); if (i >= 0) l.splice(i, 1); }, fire: (...a) => l.forEach((f) => f(...a)) }; };
  const dl = {};
  const history = [];
  const chrome = {
    runtime: { onMessage: ev(), onConnect: ev(), onInstalled: ev(), onStartup: ev(), sendMessage: () => Promise.resolve(), getURL: (p) => p, id: 'x' },
    storage: { local: store('local'), session: store('session'), onChanged: ev() },
    downloads: { onCreated: ev(), onChanged: ev(), onErased: ev(), search: (q, cb) => cb(Object.values(dl).filter((i) => (q.id == null || i.id === q.id) && (!q.state || i.state === q.state))), download: (o, cb) => cb(1), pause() {}, resume() {}, cancel() {} },
    windows: { getLastFocused: async () => ({ incognito: incognitoWindow }) },
    offscreen: { hasDocument: async () => true, createDocument: async () => {}, Reason: {} },
    action: { setBadgeText() {}, setBadgeBackgroundColor() {}, getBadgeText(a, cb) { if (cb) cb(''); } },
    tabs: { onRemoved: ev(), onUpdated: ev(), onCreated: ev(), onActivated: ev(), query: async () => [], sendMessage: async () => {}, get: async () => ({}) },
    webRequest: { onHeadersReceived: ev(), onBeforeRequest: ev(), onBeforeSendHeaders: ev(), onCompleted: ev() },
    webNavigation: { onCommitted: ev(), onBeforeNavigate: ev(), onCreatedNavigationTarget: ev(), onHistoryStateUpdated: ev() },
    declarativeNetRequest: { updateDynamicRules: async () => {}, getDynamicRules: async () => [], updateEnabledRulesets: async () => {}, getEnabledRulesets: async () => [] },
    contextMenus: { onClicked: ev(), create() {}, removeAll(cb) { if (cb) cb(); } },
    alarms: { onAlarm: ev(), create() {} },
    scripting: { executeScript: async () => [] }
  };
  const DownloadDB = {
    init: async () => {},
    saveDownload: async (e) => { history.push(e); },
    queryDownloads: async () => ({ items: history.slice(), stats: { totalCount: history.length, totalBytes: 0 } }),
    clearAll: async () => {}, pruneOlderThan: async () => 0
  };
  const ctx = { chrome, DownloadDB, importScripts: () => {}, console: { log() {}, error() {}, warn() {} }, setTimeout, clearTimeout, setInterval: () => 0, clearInterval, URL, URLSearchParams, fetch: () => Promise.reject(new Error('net')), navigator: {}, AbortSignal };
  ctx.self = ctx;
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'service-worker.js'), 'utf8'), ctx);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const send = (m, sender = {}) => new Promise((res) => {
    let done = false;
    chrome.runtime.onMessage.l.forEach((f) => f(m, sender, (x) => { done = true; res(x); }));
    setTimeout(() => { if (!done) res(undefined); }, 150);
  });
  const list = () => send({ type: 'GET_DOWNLOADS', filter: 'today' });
  return { chrome, dl, mem, history, sleep, send, list };
}

const nativeItem = (id, incognito = false) => ({ id, url: `https://x.test/${id}.mp4`, filename: '', state: 'in_progress', bytesReceived: 0, totalBytes: 1000, startTime: new Date().toISOString(), incognito });

describe('service worker download tracking', () => {
  test('a native download is listed while running, then moves to history', async () => {
    const t = setup();
    await t.sleep(100);
    t.dl[7] = nativeItem(7);
    t.chrome.downloads.onCreated.fire(t.dl[7]);
    await t.sleep(50);
    t.chrome.downloads.onChanged.fire({ id: 7, bytesReceived: { current: 400 }, totalBytes: { current: 1000 } });
    await t.sleep(100);
    let r = await t.list();
    expect(r.active.map((a) => [a.id, a.percent])).toEqual([['dl_7', 40]]);

    t.dl[7].state = 'complete';
    t.chrome.downloads.onChanged.fire({ id: 7, state: { current: 'complete' } });
    await t.sleep(150);
    r = await t.list();
    expect(r.active).toHaveLength(0);
    expect(t.history.map((h) => h.id)).toEqual(['dl_7']);
  });

  test('a late progress update cannot resurrect a finished download', async () => {
    const t = setup();
    await t.sleep(100);
    t.dl[8] = nativeItem(8);
    t.chrome.downloads.onCreated.fire(t.dl[8]);
    await t.sleep(50);
    t.dl[8].state = 'complete';
    t.chrome.downloads.onChanged.fire({ id: 8, state: { current: 'complete' } });
    t.chrome.downloads.onChanged.fire({ id: 8, bytesReceived: { current: 999 } }); // stale, arrives after
    await t.sleep(200);
    expect((await t.list()).active).toHaveLength(0);
  });

  test('offscreen job progress shows up in the Active list and is dropped when done', async () => {
    const t = setup();
    await t.sleep(100);
    await t.send({ type: 'DOWNLOAD_PARALLEL', id: 'dl_job1', url: 'https://x.test/big.mp4', filename: 'big.mp4' });
    await t.send({ type: 'MUX_PROGRESS', id: 'dl_job1', filename: 'big.mp4', percent: 10 });
    await t.send({ type: 'MUX_PROGRESS', id: 'dl_job1', filename: 'big.mp4', percent: 50 });
    await t.sleep(600);
    let r = await t.list();
    expect(r.active.map((a) => [a.id, a.percent, a.type])).toEqual([['dl_job1', 50, 'file']]);

    await t.send({ type: 'MUX_FAILED', id: 'dl_job1', filename: 'big.mp4', error: 'x' });
    await t.sleep(100);
    r = await t.list();
    expect(r.active).toHaveLength(0);
  });

  test('incognito downloads are visible this session but never persisted', async () => {
    const t = setup();
    await t.sleep(100);
    t.dl[9] = nativeItem(9, true);
    t.chrome.downloads.onCreated.fire(t.dl[9]);
    await t.sleep(50);
    t.chrome.downloads.onChanged.fire({ id: 9, bytesReceived: { current: 300 }, totalBytes: { current: 1000 } });
    await t.sleep(100);
    let r = await t.list();
    expect(r.active.map((a) => [a.id, a.percent, a.private])).toEqual([['dl_9', 30, true]]);

    t.dl[9].state = 'complete';
    t.chrome.downloads.onChanged.fire({ id: 9, state: { current: 'complete' } });
    await t.sleep(150);
    r = await t.list();
    expect(r.active).toHaveLength(0);
    expect(r.history.map((h) => [h.id, h.private])).toEqual([['dl_9', true]]);
    expect(t.history).toHaveLength(0);
    expect(t.mem.local.activeDownloads || {}).toEqual({});
    expect(t.mem.local.downloadHistory || []).toEqual([]);
  });

  test('jobs started from an incognito window are shown but kept out of local storage', async () => {
    const t = setup({ incognitoWindow: true });
    await t.sleep(100);
    await t.send({ type: 'DOWNLOAD_PARALLEL', id: 'dl_p1', url: 'https://x.test/big.mp4', filename: 'big.mp4' });
    await t.send({ type: 'MUX_PROGRESS', id: 'dl_p1', filename: 'big.mp4', percent: 20 });
    await t.sleep(100);
    const r = await t.list();
    expect(r.active.map((a) => a.id)).toEqual(['dl_p1']);
    expect(t.mem.local.activeDownloadJobs || {}).toEqual({});
  });
});
