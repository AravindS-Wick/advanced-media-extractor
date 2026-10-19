# Proof run — HEAD @ 995a713

Date: 2026-10-19T09:10:23.257Z

| Scenario | PR | Issue | Result |
|---|---|---|---|
| Pause frees a slot so the next queued download starts; cancel clears queued jobs | #47 | #35 | FAIL |

## 07-queue-pause-frees-slot
**Pause frees a slot so the next queued download starts; cancel clears queued jobs** - FAIL

- PASS: limit 3: 3 running, 2 queued - `{"dl_q1":"running:7%","dl_q2":"running:7%","dl_q3":"running:7%","dl_q4":"queued:0%","dl_q5":"queued:0%"}`
- PASS: #3 shows paused - `paused:8%`
- FAIL: #4 started once #3 was paused - `queued:0%`
- PASS: #5 still queued - `queued:0%`
- PASS: resumed #3 re-acquires a slot or waits Queued (never stuck paused) - `running:9%`
- PASS: cancelled queued job disappears - `{"dl_q1":"running:23%","dl_q2":"running:28%","dl_q3":"running:9%","dl_q4":"queued:0%"}`
- note: after start: {"dl_q1":"running:7%","dl_q2":"running:7%","dl_q3":"running:7%","dl_q4":"queued:0%","dl_q5":"queued:0%"}
- note: after pausing #3: {"dl_q1":"running:23%","dl_q2":"running:27%","dl_q3":"paused:8%","dl_q4":"queued:0%","dl_q5":"queued:0%"}
- note: after resuming #3: {"dl_q1":"running:23%","dl_q2":"running:28%","dl_q3":"running:9%","dl_q4":"queued:0%","dl_q5":"queued:0%"}
- note: after cancelling queued #5: {"dl_q1":"running:23%","dl_q2":"running:28%","dl_q3":"running:9%","dl_q4":"queued:0%"}
- note: leftover jobs after cancel-all (a ghost here is the bug fixed in PR #51, asserted in scenario 11): {}
- note: recordings: recording-1.webm
