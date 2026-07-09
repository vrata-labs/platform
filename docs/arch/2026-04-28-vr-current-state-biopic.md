# VR Current State Biopic

## Snapshot

- Date: 2026-04-28.
- Branch: `deploy/scene-bundles-stage-20260328`.
- Current accepted commit: `6f220bd fix vr hand marker tracking`.
- Staging app: `https://89.169.161.91.sslip.io`.
- Primary headset validation room: Hall `42db8225-f671-4e46-9c28-9381d66a948c`.

## Confirmed Working In Real Headset

- Hall ray works correctly.
- Hall snap-turn works correctly, including direction and one-shot behavior.
- Hall teleport works correctly.
- Hall seat interaction works correctly.
- Hall self hand marker sphere now matches the controller position.

## What Changed To Get Here

- `f3c3471 stabilize vr snap turn input` made the ray, snap-turn, teleport, and seat path stable in real Hall headset testing.
- `6f220bd fix vr hand marker tracking` fixed the remaining hand sphere issue by keeping direct VR hand targets unclamped and using the same yaw convention as the working XR ray/turn path.
- `6f220bd` also aligned avatar pose-frame world conversion with the same yaw convention, so published hand positions follow the corrected marker path.

## Verification At This Point

- Runtime build and unit tests passed locally: `pnpm --filter @vrata/runtime-web build && pnpm --filter @vrata/runtime-web test` with `101 passed`.
- Full local e2e passed: `pnpm test:e2e` with `49 passed, 1 skipped`.
- CI passed for `6f220bd`: run `25044825248`.
- Docker Publish passed for `6f220bd`: run `25044825303`.
- Staging Deploy passed for `6f220bd`: run `25044928127`.
- Staging gate passed: `pnpm test:e2e:staging` with `32 passed`.
- Real Hall headset test after deploy confirmed hand marker alignment.

## Guardrails

- Treat `6f220bd` as the current VR baseline.
- Do not change ray, snap-turn, teleport, or seating paths while working on hand marker/avatar visuals unless fresh telemetry proves they are involved.
- In VR, self-avatar hand spheres are controller markers and must track resolved XR hand world positions exactly after yaw/teleport.
- Do not clamp direct VR hand targets like desktop/mobile procedural hand poses.
- Keep Hall real headset checks on `?debug=1&scenefit=0` to avoid debug-fit changing the spawn/framing.

## Still Not Finished From The Larger Plan

- The broader VR plan is not closed as a product polish pass.
- Seat reconnect restore remains skipped in local e2e and still needs a dedicated pass if persistence/reconnect becomes the priority.
- Ray visual thickness/debug styling can be reduced later, after the VR baseline stays stable.
- BlueOffice can still be used as a secondary staging XR check, but Hall is now the confirmed real-headset baseline for this path.

## Resume Point

- If a future regression appears, first compare against `6f220bd` and collect `pnpm xr:telemetry -- --room hall --history-limit 200 --json`.
- For code investigation, start with `apps/runtime-web/src/avatar/avatar-ik.ts`, `apps/runtime-web/src/avatar/avatar-xr-hands.ts`, `apps/runtime-web/src/avatar/avatar-xr-ray.ts`, `apps/runtime-web/src/movement.ts`, and `apps/runtime-web/src/main.ts`.
