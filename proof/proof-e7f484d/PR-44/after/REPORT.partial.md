# Proof run — HEAD @ 0842abf

Date: 2026-10-19T09:07:31.232Z

| Scenario | PR | Issue | Result |
|---|---|---|---|
| History retention setting (+ incognito rule via unit tests) | #44 | #32 | PASS |

## 04-incognito-history-retention
**History retention setting (+ incognito rule via unit tests)** - PASS

- PASS: a normal download is recorded when retention = forever
- PASS: retention setting offers forever / 1y / 90d / 30d / 7d / never - `Forever | 1 year | 90 days | 30 days | 7 days | Don't keep history`
- PASS: "Don't keep history" clears stored history - `0`
- note: Incognito suppression cannot be driven by Playwright (no incognito window with extensions); it is covered by tests/service-worker.flow.test.js - see jest-output.txt.
- note: recordings: recording-1.webm, recording-2.webm
