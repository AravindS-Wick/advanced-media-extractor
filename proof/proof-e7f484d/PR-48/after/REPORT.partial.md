# Proof run — HEAD @ 24b9e50

Date: 2026-10-19T09:11:39.203Z

| Scenario | PR | Issue | Result |
|---|---|---|---|
| A connection that goes silent is dropped and re-fetched | #48 | #36 | PASS |
| Stall watchdog unit tests | #48 | #36 | PASS |

## 08-stalled-connection-watchdog
**A connection that goes silent is dropped and re-fetched** - PASS

- PASS: download finishes despite hung connections (watchdog fired)
- PASS: server saw reconnects: probe + 3 ranges + at least 3 re-fetches - `7 requests`
- note: Unit proof: tests/stall-watchdog.test.js (see 08b folder). Live check uses a server that goes silent mid-body on the first request of each range.
- note: recordings: recording-1.webm

## 08b-stall-watchdog-unit
**Stall watchdog unit tests** - PASS

- PASS: jest suite green - `Tests:       33 passed, 33 total`
- PASS: relevant tests ran - `2 matching lines`
