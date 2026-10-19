# Proof run — HEAD @ c42aa0c

Date: 2026-10-19T09:09:44.960Z

| Scenario | PR | Issue | Result |
|---|---|---|---|
| Pause frees a slot so the next queued download starts; cancel clears queued jobs | #47 | #35 | PASS |

## 07-queue-pause-frees-slot
**Pause frees a slot so the next queued download starts; cancel clears queued jobs** - PASS

- PASS: limit 3: 3 running, 2 queued - `{"dl_q1":"running:8%","dl_q2":"running:7%","dl_q3":"running:7%","dl_q4":"queued:0%","dl_q5":"queued:0%"}`
- PASS: #3 shows paused - `paused:7%`
- PASS: #4 started once #3 was paused - `running:0%`
- PASS: #5 still queued - `queued:0%`
- PASS: resumed #3 re-acquires a slot or waits Queued (never stuck paused) - `queued:8%`
- PASS: cancelled queued job disappears - `{"dl_q1":"running:13%","dl_q2":"running:13%","dl_q3":"queued:8%","dl_q4":"running:0%"}`
- note: after start: {"dl_q1":"running:8%","dl_q2":"running:7%","dl_q3":"running:7%","dl_q4":"queued:0%","dl_q5":"queued:0%"}
- note: after pausing #3: {"dl_q1":"running:11%","dl_q2":"running:10%","dl_q3":"paused:7%","dl_q4":"running:0%","dl_q5":"queued:0%"}
- note: after resuming #3: {"dl_q1":"running:12%","dl_q2":"running:12%","dl_q3":"queued:8%","dl_q4":"running:0%","dl_q5":"queued:0%"}
- note: after cancelling queued #5: {"dl_q1":"running:13%","dl_q2":"running:13%","dl_q3":"queued:8%","dl_q4":"running:0%"}
- note: leftover jobs after cancel-all (a ghost here is the bug fixed in PR #51, asserted in scenario 11): {"dl_q3":"running:8%"}
- note: recordings: recording-1.webm
