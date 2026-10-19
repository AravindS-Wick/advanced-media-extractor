# Proof run — HEAD @ 7a4d7b9

Date: 2026-10-19T09:07:05.713Z

| Scenario | PR | Issue | Result |
|---|---|---|---|
| Downloads list shows a live card with Pause / Resume / Cancel buttons | #43 | #31 | FAIL |

## 03-downloads-list-controls
**Downloads list shows a live card with Pause / Resume / Cancel buttons** - FAIL

- FAIL: active card appears
- FAIL: card has Pause and Cancel buttons
- FAIL: scenario ran without exception - `locator.click: Timeout 8000ms exceeded.
Call log:
[2m  - waiting for locator('.pause-job-btn').first()[22m
`
- note: recordings: recording-1.webm

## Page errors seen
- g03: Identifier 'openVideoPreview' has already been declared