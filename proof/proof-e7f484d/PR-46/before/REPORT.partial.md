# Proof run — HEAD @ 6a830c3

Date: 2026-10-19T09:09:11.841Z

| Scenario | PR | Issue | Result |
|---|---|---|---|
| History keeps source link + page; Restart and Open page work | #46 | #34 | FAIL |

## 06-history-restart-open-page
**History keeps source link + page; Restart and Open page work** - FAIL

- PASS: download completed
- FAIL: history entry stores pageUrl
- FAIL: history entry stores sourceUrl - `blob:chrome-extension://oalnghkmgppgddchmfhlkkmbgakggnbm/e7619a6f-3d2d-40e1-bfaf-baf68734293c`
- FAIL: Restart button is shown
- FAIL: Open page button is shown
- FAIL: scenario ran without exception - `locator.click: Timeout 8000ms exceeded.
Call log:
[2m  - waiting for locator('.page-btn').first()[22m
`
- note: history item: {"id":"dl_1","downloadId":1,"filename":"46345e20-e70b-4f53-99b0-ac8c35e4f91d","savePath":"C:\\Users\\ARAVIN~1\\AppData\\Local\\Temp\\playwright-artifacts-VJ4v2w\\46345e20-e70b-4f53-99b0-ac8c35e4f91d","url":"blob:chrome-extension://oalnghkmgppgddchmfhlkkmbgakggnbm/e7619a6f-3d2d-40e1-bfaf-baf68734293c","finalUrl":"blob:chrome-extension://oalnghkmgppgddchmfhlkkmbgakggnbm/e7619a6f-3d2d-40e1-bfaf-baf68734293c","referrer":"","domain":"","pageTitle":"","mime":"video/mp4","type":"direct","totalBytes":1048576,"startTime":1792400941118,"completedAt":1792400941265,"date":"2026-10-19","state":"complete","error":null,"updatedAt":1792400941265}
- note: recordings: recording-1.webm
