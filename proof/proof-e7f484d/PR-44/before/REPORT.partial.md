# Proof run — HEAD @ 1aa5d03

Date: 2026-10-19T09:07:43.531Z

| Scenario | PR | Issue | Result |
|---|---|---|---|
| History retention setting (+ incognito rule via unit tests) | #44 | #32 | FAIL |

## 04-incognito-history-retention
**History retention setting (+ incognito rule via unit tests)** - FAIL

- PASS: a normal download is recorded when retention = forever
- FAIL: retention setting offers forever / 1y / 90d / 30d / 7d / never
- FAIL: "Don't keep history" clears stored history - `1`
- note: Incognito suppression cannot be driven by Playwright (no incognito window with extensions); it is covered by tests/service-worker.flow.test.js - see jest-output.txt.
- note: recordings: recording-1.webm, recording-2.webm
