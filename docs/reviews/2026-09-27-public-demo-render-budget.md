# Public-demo functional rendering budget

## Observed staging gate failure

Client change `331860ae924e2bd88815baa657f100bdf332078c` passed 151 local browser tests, 920 runtime tests and CI. Staging run [36305828734](https://github.com/vrata-labs/platform/actions/runs/36305828734) failed in both attempts with 50/51: the second participant did not reach `audioJoined=true` within the existing 30-second muted-join check. All three new identity-upgrade browser scenarios passed. Both attempts rolled back to `3912f70363ce4b83eab5a638059740eaead1a60a`.

The same audio step had already failed on `3912f70` in run 36267850481 attempt 1, before passing on its second attempt. This is not sufficient evidence of an identity-upgrade regression or a LiveKit server fault.

## Isolated comparison

To avoid another blind deploy retry, a temporary browser-only probe recorded allowlisted fetch categories/statuses, WebSocket lifecycle, peer connection/ICE states, click time, long tasks and frame budget. No request bodies, media JWTs, candidate addresses or invite links were logged. The existing public-demo setup/cleanup created only disposable rooms.

First, the currently deployed `3912f70` passed the full instrumented public-demo scenario from the local runner. Then **the same compiled `331860a` client** was tested twice against the unchanged staging backend, serving its HTML/JS/CSS through isolated Playwright routes. This was a diagnostic client comparison, not an exact-SHA staging acceptance or server deployment. Only DPR differed; the original 30-second assertion and strict real media checks remained enabled.

| Member observation | DPR 1 | DPR 0.5 |
|---|---:|---:|
| Join click (ms since page start) | 48674 | 25120 |
| First observed audioJoined (ms) | 70872 | 36055 |
| Click → audioJoined | 22198 ms | 10935 ms |
| Reported average frame budget at join completion | 1077.5 ms | 550.4 ms |
| Long-task time recorded at click / completion | 41769 / 62627 ms | 17677 / 28658 ms |

Both runs followed manifest → health → media token → WebSocket → peer connection → ICE connected → audioJoined, with no extra auth stage. Endpoint responses were successful. At DPR 1 there were long main-thread stalls even between a completed response and the next request. Long-task observer delivery is asynchronous; the table's cumulative difference should not be interpreted as an exact wall-clock attribution percentage.

## Adjustment

`createTrackedContext` now uses the existing reference screen-share functional-test budget from PR #118: CSS viewport 640×400, DPR 0.5, drawing buffer 320×200. Each joined page asserts all five dimensions. This bounds software-rendering work for concurrent 3D clients while preserving the ordinary room UI, real transport and document texture assertions. The failed 30-second stage now also reports safe token HTTP statuses, audio snapshots, frame budget and DPR.

This change does not establish acceptable rendering performance on real low-power devices. Real Android/Quest and microphone acceptance remain part of the working-meeting plan. A genuinely stuck media connection still needs explicit bounded failure/recovery; the rendering-budget adjustment does not claim to implement it.
