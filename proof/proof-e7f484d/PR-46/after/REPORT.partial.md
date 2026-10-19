# Proof run — HEAD @ 600ba1c

Date: 2026-10-19T09:08:50.260Z

| Scenario | PR | Issue | Result |
|---|---|---|---|
| History keeps source link + page; Restart and Open page work | #46 | #34 | PASS |

## 06-history-restart-open-page
**History keeps source link + page; Restart and Open page work** - PASS

- PASS: download completed
- PASS: history entry stores pageUrl - `http://127.0.0.1:12487/`
- PASS: history entry stores sourceUrl - `http://127.0.0.1:12487/big/hist1.bin?size=1048576`
- PASS: Restart button is shown
- PASS: Open page button is shown
- PASS: Open page opens the saved source page in a new tab - `http://127.0.0.1:12487/`
- PASS: Restart re-requests the saved link - `2 -> 3`
- note: history item: {"id":"dl_1","downloadId":1,"filename":"6ca4c647-72e5-457a-aac2-361b55c9a356","savePath":"C:\\Users\\ARAVIN~1\\AppData\\Local\\Temp\\playwright-artifacts-9UN5hc\\6ca4c647-72e5-457a-aac2-361b55c9a356","url":"blob:chrome-extension://nofjfgehjldnnplbmccgbjmekpcfdiaa/9fa02f68-219e-44ab-937b-31c2abee1c5a","finalUrl":"blob:chrome-extension://nofjfgehjldnnplbmccgbjmekpcfdiaa/9fa02f68-219e-44ab-937b-31c2abee1c5a","referrer":"","domain":"","pageTitle":"","sourceUrl":"http://127.0.0.1:12487/big/hist1.bin?size=1048576","pageUrl":"http://127.0.0.1:12487/","kind":"file","preferredQuality":"","mime":"video/mp4","type":"direct","totalBytes":1048576,"startTime":1792400915523,"completedAt":1792400915679,"date":"2026-10-19","state":"complete","error":null,"updatedAt":1792400915679}
- note: recordings: recording-1.webm, recording-2.webm
