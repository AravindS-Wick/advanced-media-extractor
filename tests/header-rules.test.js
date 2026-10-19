// Unit proof for review finding on #43: header-rule id allocation and the
// held-rules map must survive a service-worker restart and concurrent writes.
const { loadServiceWorker } = require('./helpers/sw-harness');

describe('service worker: header-rule bookkeeping (#43)', () => {
  test('concurrent holdHeaderRule writes are serialized — no entry is lost', async () => {
    // session writes are delayed so an un-serialized read-modify-write would
    // read the same empty snapshot and clobber each other.
    const { sw, sessionStore } = loadServiceWorker({ sessionSetDelayMs: 4 });
    await Promise.all(Array.from({ length: 20 }, (_, i) => sw.holdHeaderRule('job:' + i, 900000 + i)));
    const held = sessionStore._data.heldHeaderRules;
    expect(Object.keys(held)).toHaveLength(20);
    for (let i = 0; i < 20; i++) expect(held['job:' + i]).toBe(900000 + i);
  });

  test('seedHeaderRuleCounter continues above ids still in use after a restart', async () => {
    // Simulate a restart: a rule id 900500 is still installed / held, but the
    // in-memory counter is back at 0.
    const { sw, sessionStore } = loadServiceWorker({ dynamicRules: [{ id: 900500 }] });
    await sessionStore.set({ heldHeaderRules: { 'job:old': 900500 } });
    await sw.seedHeaderRuleCounter();
    const next = sw.nextHeaderRuleId();
    expect(next).toBeGreaterThan(900500);
    expect(next).toBe(900501);
  });

  test('releaseHeldRule removes the entry and the dynamic rule', async () => {
    const { sw, sessionStore, dnrRules } = loadServiceWorker({ dynamicRules: [{ id: 900001 }] });
    await sw.holdHeaderRule('job:x', 900001);
    await sw.releaseHeldRule('job:x');
    expect(sessionStore._data.heldHeaderRules['job:x']).toBeUndefined();
    expect(dnrRules.find((r) => r.id === 900001)).toBeUndefined();
  });
});
