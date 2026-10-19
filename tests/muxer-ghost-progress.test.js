// Unit proof for the offscreen progress/done guards (review finding H1).
//
// muxer.js is a plain offscreen script (no exports, talks to chrome.* and OPFS
// directly), so we load its source into a vm context with the browser globals
// mocked, append an export of the internals we exercise, and capture every
// chrome.runtime.sendMessage.
const fs = require('fs');
const path = require('path');
const vm = require('vm');

function loadMuxer() {
  const sent = [];
  const fakeDir = {
    async *values() {},
    async removeEntry() {},
    async getFileHandle() {
      return { createWritable: async () => ({ write: async () => {}, close: async () => {}, abort: async () => {} }) };
    }
  };
  const sandbox = {
    chrome: {
      runtime: {
        onMessage: { addListener() {} },
        onConnect: { addListener() {} },
        connect: () => ({ onDisconnect: { addListener() {} }, postMessage() {}, disconnect() {} }),
        sendMessage: (m) => { sent.push(m); return Promise.resolve(); }
      },
      downloads: {}
    },
    navigator: { storage: { getDirectory: async () => fakeDir } },
    URL: { createObjectURL: () => 'blob:x', revokeObjectURL() {} },
    Blob: class {},
    TextEncoder,
    crypto: { getRandomValues: (a) => a, randomUUID: () => 'uuid' },
    setTimeout, clearTimeout, setInterval: () => 0, clearInterval,
    Date, Math, console, Promise
  };
  sandbox.self = sandbox;
  sandbox.globalThis = sandbox;
  let src = fs.readFileSync(path.join(__dirname, '..', 'offscreen', 'muxer.js'), 'utf8');
  src += '\n;globalThis.__m = { progress, done, activeJobs };';
  vm.runInNewContext(src, sandbox, { filename: 'muxer.js' });
  return { m: sandbox.__m, sent };
}

describe('offscreen muxer: no ghost progress, idempotent done (H1)', () => {
  test('progress() for an active job emits MUX_PROGRESS', () => {
    const { m, sent } = loadMuxer();
    m.activeJobs.set('dl_1', { filename: 'a.mp4', lastSent: 0 });
    m.progress('dl_1', { filename: 'a.mp4', percent: 10 }, true);
    expect(sent.filter((x) => x.type === 'MUX_PROGRESS' && x.id === 'dl_1')).toHaveLength(1);
  });

  test('progress() for a cancelled/finished job (not in activeJobs) emits nothing', () => {
    const { m, sent } = loadMuxer();
    // job was cancelled: it is no longer in activeJobs, but a worker is still
    // unwinding and calls progress() late.
    m.progress('dl_gone', { filename: 'a.mp4', percent: 42 }, true);
    expect(sent.filter((x) => x.type === 'MUX_PROGRESS')).toHaveLength(0);
  });

  test('done() is idempotent: a second call emits no duplicate MUX_DONE/MUX_FAILED', () => {
    const { m, sent } = loadMuxer();
    m.done('dl_2', { error: 'Cancelled by user' });
    m.done('dl_2', { error: 'Cancelled by user' }); // late worker rejection
    expect(sent.filter((x) => x.type === 'MUX_DONE' && x.id === 'dl_2')).toHaveLength(1);
    expect(sent.filter((x) => x.type === 'MUX_FAILED' && x.id === 'dl_2')).toHaveLength(1);
  });
});
