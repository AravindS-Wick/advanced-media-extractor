# Proof run — HEAD @ 158c587

Date: 2026-10-19T09:08:23.497Z

| Scenario | PR | Issue | Result |
|---|---|---|---|
| Open pages stay in step without a refresh | #45 | #33 | PASS |

## 05-tab-state-sync
**Open pages stay in step without a refresh** - PASS

- PASS: download started in tab A appears in tab B without refresh
- PASS: cancelling in A removes the card in B without refresh
- PASS: ad-block toggle flipped in popup 1 updates popup 2 live - `before=true after=false`
- note: recordings: recording-1.webm, recording-2.webm, recording-3.webm, recording-4.webm
