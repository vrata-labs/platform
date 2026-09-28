# Two-client seat-marker software-GPU profile

## Reproduction

The runtime is `d82052ed711eaf6eeb7fcea28bd4f0889a64f8b0`. The pending API-only
migration-order correction does not change its browser bundle. The affected
scenario is `seat-marker-visual.spec.ts`: real meeting-room-basic, two live
clients, 640×480 viewports, DPR 1, `debug=1&scenefit=0&onboard=0`.
The pinned scene has 133 meshes, 18 materials, 25 textures and 11,576,640 asset
bytes. Chromium headless shell uses ANGLE/SwiftShader; default CDP GPU status
reports software compositing. No unrelated process was stopped during profiling.

Both clients were profiled with CDP CPU sampling (2 ms), native WebGL/Canvas
call durations, long tasks, animation callbacks and network events. Browser
tracing enabled `devtools.timeline`, `disabled-by-default-devtools.timeline.frame`,
`blink.user_timing`, `gpu`, `disabled-by-default-gpu.service`. Each run used a
fresh browser and disposable room. Publisher joined first; observer joined while
publisher continued rendering. Profiles included a short post-load interval.
The diagnostic harness allowed 140 s to observe completion; this is not the
acceptance deadline and does not count as an E2E pass.

## Controlled comparisons

| Experiment | Publisher observed load | Observer observed load |
|---|---:|---:|
| Original shared browser | 10.2 s | 47.4 s |
| Suppress only diagnostic canvas readback | 13.1 s | 48.0 s |
| Enable GPU compositing, same SwiftShader | 7.8 s | 47.7 s |
| GPU compositing + suppressed diagnostic readback | 5.9 s | 113.6 s |
| Separate browser processes, original rendering/diagnostics | 9.4 s | 18.7 s |
| Repeat original shared browser | 9.5 s | 35.9 s |
| Repeat separate browsers | 10.0 s | 15.5 s |

The readback experiment intercepted only `drawImage` from the real WebGL canvas
to the 320×180 diagnostic scratch canvas. Its pixel statistics are deliberately
invalid and were never accepted as visual evidence. The compositor experiments
used `--enable-gpu --use-angle=swiftshader`; neither change was adopted.

In the original profile, publisher diagnostic `drawImage` took 24.65 s across
22 calls (maximum 3.28 s). CPU samples placed it under
`reportDiagnostics → captureCanvasDiagnostics`. Observer shader/program-log
queries also accumulated about 17 s. These synchronous calls wait for GPU work;
their duration alone does not prove that the called operation causes that work.

Removing the diagnostic readbacks left 119 native `GLES2::ReadPixels` events
and 94.2 s aggregate duration across both renderer threads, approximately one
per animation callback. Publisher `TaskDuration` was 67.8 s, but `ScriptDuration`
only 3.2 s and thread CPU time 4.6 s. Large non-JavaScript waits remain in the
software canvas/compositor path. Enabling GPU compositing moved the diagnostic
stall to `getImageData`, without improving observer load. Removing both barriers
made observer startup worse in that run.

The separate-browser experiments retained both live clients, all pixels,
materials and diagnostics. Observer frame-budget snapshots were about 450 ms,
versus 1,024–1,648 ms in the default shared-browser profiles. Repeating the
original topology between isolated runs reproduced the larger delay. This
supports shared software-GPU queue contention as an important contributor.
It does not establish exclusive causality for every historical timeout, nor
measure hardware-GPU or Quest performance. Trace durations are nested and may
span concurrent threads; they must not be added as wall-clock time. The combined
compositor/readback trace hit the 250,000-event capture cap.

## Test correction

The visual occupancy scenario now launches its observer in another browser
process with the configured launch options, browser type, channel and headless
mode. Both participants still run concurrently against the same room and real
room-state transport. Viewport/DPR, geometry, materials, rendering diagnostics,
90 s scene deadline, ray/seat assertions and explicit PNG captures are preserved.
The observer browser is closed in teardown, including failure paths.

This is isolation of the visual test participants' software-GPU queues, not a
runtime rendering optimization. Other multi-context scenarios continue to cover
shared-browser clients. Browser pixel captures remain necessary for the visual
checks; no cached or synthetic screenshot replaces them.

Focused verification passed all three cases: component, meeting-room-basic and
presentation-room-basic (2.6 min total). Inspection of the actual PNG attachments
confirmed the free/hovered marker and its disappearance on authoritative
occupancy in both rooms. API build and all 807 API tests, including PostgreSQL
legacy migration and the pinned rollback build, passed; workspace lint and
typecheck passed. Final full-suite and deployed-SHA results are recorded in the
[implementation journal](2026-09-26-working-meeting-implementation.md).
