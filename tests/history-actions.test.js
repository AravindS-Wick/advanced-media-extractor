const HistoryActions = require('../lib/history-actions.js');

describe('HistoryActions', () => {
  const hls = { sourceUrl: 'https://cdn.example.com/v/master.m3u8', pageUrl: 'https://example.com/watch/1', kind: 'hls', filename: 'a.mp4', preferredQuality: '720' };

  test('offers Restart only when a web source URL was kept', () => {
    expect(HistoryActions.canRestart(hls)).toBe(true);
    expect(HistoryActions.canRestart({ url: 'https://x.test/a.mp4' })).toBe(true);
    expect(HistoryActions.canRestart({ sourceUrl: 'blob:https://x.test/1' })).toBe(false);
    expect(HistoryActions.canRestart({ ...hls, kind: 'zip' })).toBe(false);
    expect(HistoryActions.canRestart(null)).toBe(false);
  });

  test('offers Open page only for http(s) page URLs', () => {
    expect(HistoryActions.canOpenPage(hls)).toBe(true);
    expect(HistoryActions.canOpenPage({ pageUrl: 'javascript:alert(1)' })).toBe(false);
    expect(HistoryActions.canOpenPage({})).toBe(false);
  });

  test('restarts HLS entries as a MUX_HLS job with the saved quality', () => {
    const sent = [];
    global.chrome = { runtime: { sendMessage: (m, cb) => { sent.push(m); cb && cb({ ok: true }); } } };
    HistoryActions.restart(hls);
    expect(sent[0]).toMatchObject({ type: 'MUX_HLS', url: hls.sourceUrl, pageUrl: hls.pageUrl, preferredQuality: '720' });
    expect(sent[0].id).toMatch(/^mux_/);
    HistoryActions.restart({ url: 'https://x.test/a.mp4', filename: 'a.mp4' });
    expect(sent[1]).toMatchObject({ type: 'DOWNLOAD_STREAM', url: 'https://x.test/a.mp4' });
    delete global.chrome;
  });
});
