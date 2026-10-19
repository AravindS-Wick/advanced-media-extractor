// Loads service-worker.js into a vm context with a permissive `chrome` mock so
// its internal functions can be unit-tested. storage.local/session are real
// in-memory async stores (session writes are deliberately delayed so races in
// un-serialized read-modify-write code are observable); declarativeNetRequest
// rule mutations are recorded; everything else is a no-op stub.
const fs = require('fs');
const path = require('path');
const vm = require('vm');

function asyncStore(delay = 0) {
  const data = {};
  const wrap = (v) => (delay ? new Promise((r) => setTimeout(() => r(v), delay)) : Promise.resolve(v));
  return {
    _data: data,
    get(keys) {
      let out = {};
      if (keys == null) out = { ...data };
      else if (typeof keys === 'string') { if (keys in data) out[keys] = data[keys]; }
      else if (Array.isArray(keys)) keys.forEach((k) => { if (k in data) out[k] = data[k]; });
      else { Object.keys(keys).forEach((k) => { out[k] = k in data ? data[k] : keys[k]; }); }
      return wrap(out);
    },
    set(obj) { Object.assign(data, obj); return wrap(undefined); },
    remove(keys) { [].concat(keys).forEach((k) => delete data[k]); return wrap(undefined); },
    clear() { Object.keys(data).forEach((k) => delete data[k]); return wrap(undefined); }
  };
}

const evt = () => ({ addListener() {}, removeListener() {}, hasListener() { return false; } });

function loadServiceWorker(opts = {}) {
  const dnrRules = (opts.dynamicRules || []).slice();
  const dnrCalls = [];
  const sessionStore = asyncStore(opts.sessionSetDelayMs || 0);

  const chrome = {
    runtime: {
      id: 'ext-id', lastError: null,
      onMessage: evt(), onConnect: evt(), onInstalled: evt(), onStartup: evt(),
      sendMessage: () => Promise.resolve(), connect: () => ({ onDisconnect: evt(), postMessage() {}, disconnect() {} }),
      getURL: (p) => 'chrome-extension://ext-id/' + p
    },
    storage: { local: asyncStore(), session: sessionStore, onChanged: evt() },
    declarativeNetRequest: {
      getDynamicRules: () => Promise.resolve(dnrRules.slice()),
      getSessionRules: () => Promise.resolve([]),
      updateDynamicRules: (o) => { dnrCalls.push(o); (o.removeRuleIds || []).forEach((id) => { const i = dnrRules.findIndex((r) => r.id === id); if (i >= 0) dnrRules.splice(i, 1); }); (o.addRules || []).forEach((r) => dnrRules.push(r)); return Promise.resolve(); },
      updateSessionRules: () => Promise.resolve(),
      updateEnabledRulesets: () => Promise.resolve()
    },
    downloads: {
      search: (q, cb) => { if (cb) cb([]); return Promise.resolve([]); },
      download: (o, cb) => { if (cb) cb(1); }, cancel() {}, erase() {}, pause() {}, resume() {}, open() {}, show() {},
      onCreated: evt(), onChanged: evt(), onErased: evt()
    },
    action: { getBadgeText: () => Promise.resolve(''), setBadgeText: () => Promise.resolve(), setBadgeBackgroundColor: () => Promise.resolve() },
    cookies: { getAll: () => Promise.resolve([]) },
    offscreen: { hasDocument: () => Promise.resolve(false), createDocument: () => Promise.resolve() },
    scripting: { executeScript: () => Promise.resolve([]) },
    tabs: { create: () => Promise.resolve({}), remove: () => Promise.resolve(), update: () => Promise.resolve({}), sendMessage: () => Promise.resolve(), onCreated: evt(), onRemoved: evt(), onUpdated: evt() },
    webRequest: { onHeadersReceived: evt(), onBeforeRequest: evt() },
    webNavigation: { onBeforeNavigate: evt() }
  };

  const sandbox = {
    chrome, console, setTimeout, clearTimeout, setInterval: () => 0, clearInterval,
    URL, TextEncoder, TextDecoder, Blob: class {}, atob: (s) => Buffer.from(s, 'base64').toString('binary'),
    btoa: (s) => Buffer.from(s, 'binary').toString('base64'), crypto: { getRandomValues: (a) => a, randomUUID: () => 'uuid' },
    fetch: () => Promise.resolve({ ok: true, status: 200, headers: { get: () => null }, text: () => Promise.resolve(''), json: () => Promise.resolve({}) }),
    Date, Math, Promise, JSON, Object, Array, Map, Set, RegExp, Error
  };
  sandbox.self = sandbox;
  sandbox.globalThis = sandbox;
  const root = path.join(__dirname, '..', '..');
  const context = vm.createContext(sandbox);
  // service-worker.js pulls in its libs via importScripts; load each into the
  // same context so their globals (e.g. the download DB) are available.
  sandbox.importScripts = (...files) => {
    for (const f of files) {
      const code = fs.readFileSync(path.join(root, f), 'utf8');
      vm.runInContext(code, context, { filename: f });
    }
  };

  let src = fs.readFileSync(path.join(root, 'service-worker.js'), 'utf8');
  src += '\n;globalThis.__sw = { holdHeaderRule, releaseHeldRule, readHeldRules, seedHeaderRuleCounter, nextHeaderRuleId };';
  vm.runInContext(src, context, { filename: 'service-worker.js' });
  return { sw: sandbox.__sw, chrome, dnrRules, dnrCalls, sessionStore };
}

module.exports = { loadServiceWorker };
