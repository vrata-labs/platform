# Vrata runtime-web locomotion refactor prompt

## Status On 2026-05-08

This prompt replaces the old phase checklist. Do not restart phases 0-6. They are closed for the current architecture goal.

Current branch:

```text
deploy/scene-bundles-stage-20260328
```

Current verified runtime HEAD:

```text
ca26095b77c076672acfea72eb6d38e71f8c3bbf extract frame locomotion handlers
```

Current high-level state:

- Local pose ownership is enforced through `apps/runtime-web/src/local/`.
- XR/desktop/touch input is sampled into `RuntimeFrameContext` / `InputIntents`.
- Interaction ray resolving, target resolving, ray view, interaction frame orchestration, and target perform wrapper are extracted from `main.ts`.
- Seating state, seat occupancy helpers, seat anchor read-model/reconcile, seat marker view, and seat reclaim planner are extracted from `main.ts`.
- Runtime commands and command bridge exist; direct seat claim/release/request calls are not in `main.ts`.
- Frame locomotion pipeline exists in `apps/runtime-web/src/locomotion/frame-locomotion.ts`.
- XR control planning is isolated in `apps/runtime-web/src/locomotion/frame-xr-controls.ts`.
- Movement planning is isolated in `apps/runtime-web/src/locomotion/frame-movement.ts`.
- Frame locomotion pipeline boundaries are named as `FrameLocomotionReadModel` and `FrameLocomotionCommandSink`.
- XR control commands and movement commands are planned as ordered command lists before execution.
- Movement stage input is collected after XR/confirm execution so post-confirm seating state is observed.
- Frame command flushing lives in `apps/runtime-web/src/locomotion/frame-command-bridge.ts`.
- `updateMovement(...)` delegates through local `createFrameLocomotionHandlers(frameContext)` instead of an inline handler object.
- `main.ts` remains composition/orchestration root, which is intentional.

## Completed Runtime Commits

```text
d06611077bd3a6b2fc0b15a67e65d5ff11f2da4d refactor runtime local pose ownership
2d997e89e63e715ccaa2fa18b2a44eda0d62a85e route runtime interactions through commands
ce396607dac612ab57e6974589871be5a301b05c isolate runtime command execution bridge
4175c4a8666325d80d85fc2db55cdb11be9ced81 route desktop touch input through intents
e5a5d1165c268b7a4015a69cdb0cd27ef42bfafd sample avatar XR hands from frame context
ec3ee19c35ee04abccd71d801a5b600e8484382f isolate seat occupancy mutations
9666cf534eabd6cd479ccad304e0959b8cc912a8 route interaction confirms through frame context
86cf61580f09f11c37d958fee0e7c9812b89d0b4 extract interaction ray resolver
0b6c96ec85ec24cda97980a883e77a75b8e366be extract interaction target resolver
4544086f8712e196879b9a59258614c1176cabfb extract interaction command planner
a022598f7e609dae86536db05e186672b553d1bf extract interaction ray view
971709817d3bba35dd8d41c413d3def255a158a2 extract interaction frame orchestration
2a4341cdfec678c5f07d553e1758c74eb0348f8a extract seat marker view
baec59fa5bb77749f8e0b89871d18ac8e51d51b3 extract seat anchor reconciliation
7cd0290ae32deff071a864a75f9ddc48a8c50726 extract interaction target performer
f32c2329016a4540987fe7ca1d3aee754aab3e5c extract seat reclaim planner
499b3b4f44ea79f7ff0c2fd83d24505f3a816edf execute frame locomotion pipeline
0eeb36b05334fd4ad9ccaae84a511f90c3444016 route frame pose through runtime commands
e372f86ca894e7eb646dd20a10be8982ae6666fc route snap turn through runtime commands
de53197ddef968254372598d3630613710d7d63f route frame bookkeeping through runtime commands
262a40f7c699003768cefbc8d91db928abd5defa route frame xr state through runtime commands
ec815d23478f6ce6ba42d31af6598a52eed93929 route frame confirm through commands
4fb542a87a6fbbf4179104245734972aa1374c71 move frame command execution into locomotion
18e90c0105d0d90972c9ab566c88293d685774b6 split frame locomotion pipeline stages
0828d0ad1f9a8099c668338c46fa1974251a4f7e plan frame xr control commands
796841382d6403e567c6a8efd6663dc00cd4a1e0 plan frame movement commands
14ab71bb2952873e2c458ad4bf4f7b16dd4ba974 split frame locomotion by domain
33ed6b46eebbfdf98f6a9276425981f048d1b6b5 name frame locomotion boundaries
ac758bdd8ea722e75698535504778949dafb0b22 collect frame movement input after confirm
2c080d4ea1b94e02b6b85508dcc2acd05e8dd2b2 extract frame command bridge
ca26095b77c076672acfea72eb6d38e71f8c3bbf extract frame locomotion handlers
```

Related test-only stabilization commit:

```text
6ef751f518d77a56288233c90a8b34aae3e32563 stabilize staging scene load waits
```

## Latest Verification

Verification for `ca26095b77c076672acfea72eb6d38e71f8c3bbf`:

```text
Slice 5                                 done
Frame handler helper                    createFrameLocomotionHandlers(frameContext)
Runtime behavior                        unchanged inline handler extraction
pnpm --filter @vrata/runtime-web build  PASS
pnpm --filter @vrata/runtime-web test   PASS, 191 tests
git diff --check                       PASS
pose ownership grep                    PASS, direct writes only in local/player-rig-adapter.ts
renderer.xr.getFrame grep              PASS, only main.ts XR frame sampling
seating Three.js grep                  PASS, no imports in apps/runtime-web/src/seating
main seat command grep                 PASS, no direct sendSeatClaim/sendSeatRelease/requestSeatClaim calls in main.ts
pnpm test:e2e                          PASS, 49 passed / 1 skipped
CI                                      PASS, run 25557503143, https://github.com/psilon2000/vrata/actions/runs/25557503143
Docker Publish                          PASS, run 25557503105, https://github.com/psilon2000/vrata/actions/runs/25557503105
Staging Deploy                          PASS, run 25557694223, https://github.com/psilon2000/vrata/actions/runs/25557694223
Staging smoke                           PASS, /health OK, /rooms/demo-room 200, /control-plane 200
Rollback                                not triggered
```

Verification for `2c080d4ea1b94e02b6b85508dcc2acd05e8dd2b2`:

```text
Slice 4                                 done
Frame command bridge                    apps/runtime-web/src/locomotion/frame-command-bridge.ts
Command flush semantics                 covered by frame locomotion command executor test
Runtime behavior                        unchanged command order and pipeline delegation
pnpm --filter @vrata/runtime-web build  PASS
pnpm --filter @vrata/runtime-web test   PASS, 191 tests
git diff --check                       PASS
pose ownership grep                    PASS, direct writes only in local/player-rig-adapter.ts
renderer.xr.getFrame grep              PASS, only main.ts XR frame sampling
seating Three.js grep                  PASS, no imports in apps/runtime-web/src/seating
main seat command grep                 PASS, no direct sendSeatClaim/sendSeatRelease/requestSeatClaim calls in main.ts
pnpm test:e2e                          PASS, 49 passed / 1 skipped
CI                                      PASS, run 25556640892, https://github.com/psilon2000/vrata/actions/runs/25556640892
Docker Publish                          PASS, run 25556640907, https://github.com/psilon2000/vrata/actions/runs/25556640907
Staging Deploy                          PASS, run 25556820126, https://github.com/psilon2000/vrata/actions/runs/25556820126
Staging smoke                           PASS, /health OK, /rooms/demo-room 200, /control-plane 200
Rollback                                not triggered
```

Verification for `ac758bdd8ea722e75698535504778949dafb0b22`:

```text
Slice 3                                 done
Movement input collection               buildFrameMovementInput(...)
Post-confirm seat state                 covered by flow test
Runtime behavior                        unchanged movement planner behavior
pnpm --filter @vrata/runtime-web build  PASS
pnpm --filter @vrata/runtime-web test   PASS, 191 tests
git diff --check                       PASS
pose ownership grep                    PASS, direct writes only in local/player-rig-adapter.ts
renderer.xr.getFrame grep              PASS, only main.ts XR frame sampling
seating Three.js grep                  PASS, no imports in apps/runtime-web/src/seating
main seat command grep                 PASS, no direct sendSeatClaim/sendSeatRelease/requestSeatClaim calls in main.ts
pnpm test:e2e                          PASS, 49 passed / 1 skipped
CI                                      PASS, run 25555848463, https://github.com/psilon2000/vrata/actions/runs/25555848463
Docker Publish                          PASS, run 25555848513, https://github.com/psilon2000/vrata/actions/runs/25555848513
Staging Deploy                          PASS, run 25556026457, https://github.com/psilon2000/vrata/actions/runs/25556026457
Staging smoke                           PASS, /health OK, /rooms/demo-room 200, /control-plane 200
Rollback                                not triggered
```

Verification for `33ed6b46eebbfdf98f6a9276425981f048d1b6b5`:

```text
Slice 2                                 done
Pipeline read model                     FrameLocomotionReadModel
Pipeline command sink                   FrameLocomotionCommandSink
Runtime behavior                        unchanged, type-only boundary naming
pnpm --filter @vrata/runtime-web build  PASS
pnpm --filter @vrata/runtime-web test   PASS, 190 tests
git diff --check                       PASS
pose ownership grep                    PASS, direct writes only in local/player-rig-adapter.ts
renderer.xr.getFrame grep              PASS, only main.ts XR frame sampling
seating Three.js grep                  PASS, no imports in apps/runtime-web/src/seating
main seat command grep                 PASS, no direct sendSeatClaim/sendSeatRelease/requestSeatClaim calls in main.ts
pnpm test:e2e                          PASS, 49 passed / 1 skipped
CI                                      PASS, run 25549311791, https://github.com/psilon2000/vrata/actions/runs/25549311791
Docker Publish                          PASS, run 25549311796, https://github.com/psilon2000/vrata/actions/runs/25549311796
Staging Deploy                          PASS, run 25549481989, https://github.com/psilon2000/vrata/actions/runs/25549481989
Staging smoke                           PASS, /health OK, /rooms/demo-room 200, /control-plane 200
Rollback                                not triggered
```

Verification for `14ab71bb2952873e2c458ad4bf4f7b16dd4ba974`:

```text
Slice 1                                 done
Split XR controls                       apps/runtime-web/src/locomotion/frame-xr-controls.ts
Split movement planning                 apps/runtime-web/src/locomotion/frame-movement.ts
Pipeline entry point                    apps/runtime-web/src/locomotion/frame-locomotion.ts
pnpm --filter @vrata/runtime-web build  PASS
pnpm --filter @vrata/runtime-web test   PASS, 190 tests
git diff --check                       PASS
pose ownership grep                    PASS, direct writes only in local/player-rig-adapter.ts
renderer.xr.getFrame grep              PASS, only main.ts XR frame sampling
seating Three.js grep                  PASS, no imports in apps/runtime-web/src/seating
main seat command grep                 PASS, no direct sendSeatClaim/sendSeatRelease/requestSeatClaim calls in main.ts
pnpm test:e2e                          PASS, 49 passed / 1 skipped
CI                                      PASS, run 25547940990, https://github.com/psilon2000/vrata/actions/runs/25547940990
Docker Publish                          PASS, run 25547940992, retry after transient cr.yandex oauth token EOF, https://github.com/psilon2000/vrata/actions/runs/25547940992
Staging Deploy                          PASS, run 25548273651, https://github.com/psilon2000/vrata/actions/runs/25548273651
Staging smoke                           PASS, /health OK, /rooms/demo-room 200, /control-plane 200
Rollback                                not triggered
```

Verification for `796841382d6403e567c6a8efd6663dc00cd4a1e0`:

```text
pnpm --filter @vrata/runtime-web build  PASS
pnpm --filter @vrata/runtime-web test   PASS, 190 tests
git diff --check                       PASS
pose ownership grep                    PASS, direct writes only in local/player-rig-adapter.ts
renderer.xr.getFrame grep              PASS, only sampleRuntimeFrameContext
seating Three.js grep                  PASS, no imports in apps/runtime-web/src/seating
main seat command grep                 PASS, no direct sendSeatClaim/sendSeatRelease/requestSeatClaim calls in main.ts
pnpm test:e2e                          PASS, 49 passed / 1 skipped
CI                                      PASS, run 25539377718
Docker Publish                          PASS, run 25539377712
Staging Deploy                          PASS, run 25539437797
Staging smoke                           PASS, /health OK, /rooms/demo-room 200, /control-plane 200
Rollback                                not triggered
```

Verification for test-only commit `6ef751f518d77a56288233c90a8b34aae3e32563`:

```text
Targeted Hall staging test              PASS
Targeted BlueOffice staging test        PASS
pnpm test:e2e:staging                   PASS, 32 passed
CI                                      PASS, run 25520817975
Docker Publish                          PASS, run 25520817956
Staging Deploy                          PASS, run 25520943172
Rollback                                not triggered
```

## Current Acceptance Invariants

These should stay true after every runtime slice:

```bash
grep -R -E "player\.position\.set|player\.position\.[xyz][[:space:]]*=|player\.rotation\.y[[:space:]]*=" apps/runtime-web/src
```

Expected direct write matches:

```text
apps/runtime-web/src/local/player-rig-adapter.ts:12
apps/runtime-web/src/local/player-rig-adapter.ts:13
```

```bash
grep -R "renderer\.xr\.getFrame" apps/runtime-web/src
```

Expected match:

```text
apps/runtime-web/src/main.ts:2153
```

```bash
grep -R -E "from ['\"]three['\"]|from ['\"]three/" apps/runtime-web/src/seating
```

Expected result:

```text
No matches
```

```bash
grep -R -E "sendSeatClaim|sendSeatRelease|requestSeatClaim\(" apps/runtime-web/src/main.ts
```

Expected result:

```text
No matches
```

## What Is Done By Phase

- Phase 0: done. Baseline and direct pose writes were identified.
- Phase 1: done. `LocalPoseController` / `PlayerRigAdapter` own pose writes.
- Phase 2: done. `RuntimeFrameContext` and `InputIntents` are the input path; XR frame is sampled once.
- Phase 3: done for current behavior. `LocomotionMode`, runtime command path, frame locomotion pipeline, XR control stage, and movement stage exist.
- Phase 4: done for current behavior. Seating state, occupancy mutation helpers, anchor read-model/reconcile, marker view, and reclaim planner are extracted and tested.
- Phase 5: done for current behavior. Interaction ray, target, command planner, view, frame orchestration, and performer are extracted and tested.
- Phase 6: done. Architecture rules are in `AGENTS.md`, root `README.md`, and `apps/runtime-web/README.md`.

## What Actually Remains

No runtime cleanup remains in this plan. Slices 1-5 are complete and verified on staging; Slice 6 is the docs-only completion step.

The remaining guidance is maintenance mode, not another feature rewrite.

Do one slice per commit. Do not combine slices unless the diff is trivial and tests prove no behavior changed.

### Slice 1 - Split Frame Locomotion By Domain (done)

Goal: make `frame-locomotion.ts` a small pipeline/orchestration file instead of a mixed XR + movement + command module.

Progress on 2026-05-08:

- Local implementation complete: XR-control planning moved to `frame-xr-controls.ts`, movement planning moved to `frame-movement.ts`, and `frame-locomotion.ts` remains the pipeline entry point with compatibility re-exports.
- Local verification complete: runtime build/test, invariant greps, and full local e2e passed.
- Commit `14ab71bb2952873e2c458ad4bf4f7b16dd4ba974` pushed; CI, Docker publish, staging deploy gate, and staging smoke passed.

Concrete changes:

- Create `apps/runtime-web/src/locomotion/frame-xr-controls.ts`.
- Move `FrameXrControlPlan`, `FrameXrControlInput`, `FrameXrControlPlanHandlers`, `planFrameXrControls`, `planFrameXrControlCommands`, and `executeFrameXrControlPlan` into `frame-xr-controls.ts`.
- Create `apps/runtime-web/src/locomotion/frame-movement.ts`.
- Move `FrameLocomotionMovementPlan`, `FrameLocomotionMovementInput`, `FrameLocomotionMovementPlanHandlers`, `planFrameLocomotionMovement`, `planFrameLocomotionMovementCommands`, and `executeFrameLocomotionMovementPlan` into `frame-movement.ts`.
- Keep `apps/runtime-web/src/locomotion/frame-locomotion.ts` as the pipeline entry point and re-export moved public symbols if that keeps imports smaller.
- Do not change command order, handler order, type names used by tests, or runtime behavior.

Acceptance for Slice 1:

- Existing `frame-locomotion.test.ts` and `frame-locomotion-flow.test.ts` still pass after import updates.
- `executeFrameLocomotionPipeline(...)` still returns `{ xrControlPlan, movementPlan }`.
- No changes in `main.ts` unless imports need adjusting.

### Slice 2 - Name The Pipeline Boundaries (done)

Goal: make the pipeline contracts explicit without changing execution.

Progress on 2026-05-08:

- Type-only implementation complete: `FrameLocomotionReadModel` and `FrameLocomotionCommandSink` now name the pipeline boundary contracts.
- Local verification complete: runtime build/test, invariant greps, and full local e2e passed.
- Commit `33ed6b46eebbfdf98f6a9276425981f048d1b6b5` pushed; CI, Docker publish, staging deploy gate, and staging smoke passed.

Concrete changes:

- In `frame-locomotion.ts`, replace the current intersection-style `FrameLocomotionPipelineHandlers` with named interfaces.
- Add `FrameLocomotionReadModel` for getters: `getYaw`, `getPose`, `getCurrentSeatId`, `getSeatRootPosition`, `getSeatYaw`, `getLastAppliedSeatLockId`, `getCameraForward`, `getDesktopFastMove`, `getBotMove`.
- Add `FrameLocomotionCommandSink` for `executeCommands`.
- Define `FrameLocomotionPipelineHandlers = FrameLocomotionReadModel & FrameLocomotionCommandSink` only if that reduces import churn.
- Do not move logic in this slice.

Acceptance for Slice 2:

- Type-only cleanup; runtime diff should be behavior-free.
- Unit and flow tests pass unchanged or with import-only adjustments.

### Slice 3 - Extract Movement Stage Input Collection (done)

Goal: isolate the rule that movement stage reads seat/pose state after the XR/confirm stage has run.

Progress on 2026-05-08:

- Local implementation complete: `buildFrameMovementInput(...)` collects movement-stage read-model state after XR/confirm command execution.
- Flow regression added for movement planning after a confirm-triggered seat release.
- Local verification complete: runtime build/test, invariant greps, and full local e2e passed.
- Commit `ac758bdd8ea722e75698535504778949dafb0b22` pushed; CI, Docker publish, staging deploy gate, and staging smoke passed.

Concrete changes:

- Add a helper in `frame-locomotion.ts` or `frame-movement.ts`: `buildFrameMovementInput(input, readModel): FrameLocomotionMovementInput`.
- The helper must call `getCurrentSeatId()` inside movement stage, after `executeFrameXrControlStage(...)` has completed.
- Use the helper from `executeFrameMovementStage(...)`.
- Add or update a flow test to prove movement stage observes post-confirm seat state when confirm interaction changes seating state before movement planning.
- Do not change `planFrameLocomotionMovement(...)` behavior.

Acceptance for Slice 3:

- Existing seated lock, snap-turn, ray-intent suppression, teleport-from-seated, and seat claim/release tests still pass.
- New test fails if movement input is collected before XR/confirm command execution.

### Slice 4 - Move Frame Command Bridge To Its Own File (done)

Goal: separate frame-only command flushing from locomotion planning.

Progress on 2026-05-08:

- Local implementation complete: `FrameLocomotionCommand`, `FrameLocomotionCommandHandlers`, and `executeFrameLocomotionCommands(...)` moved to `frame-command-bridge.ts`.
- `frame-locomotion.ts` keeps compatibility re-exports while movement, XR controls, tests, and `main.ts` import the bridge directly.
- Local verification complete: runtime build/test, invariant greps, and full local e2e passed.
- Commit `2c080d4ea1b94e02b6b85508dcc2acd05e8dd2b2` pushed; CI, Docker publish, staging deploy gate, and staging smoke passed.

Concrete changes:

- Create `apps/runtime-web/src/locomotion/frame-command-bridge.ts`.
- Move `FrameLocomotionCommand`, `FrameLocomotionCommandHandlers`, and `executeFrameLocomotionCommands(...)` there.
- Keep re-exports from `frame-locomotion.ts` if needed to avoid a noisy import diff.
- Move the existing flush-order unit test with the implementation or update imports only.
- Do not change the flush semantics around `{ type: "confirm_interaction_target" }`.

Acceptance for Slice 4:

- The test `frame locomotion command executor flushes runtime commands around frame confirm` still proves runtime commands flush before and after confirm.
- `main.ts` still delegates through the same command execution path.

### Slice 5 - Reduce `main.ts` Frame Locomotion Boilerplate Locally (done)

Goal: make `updateMovement(...)` a short orchestration call without moving domain logic back into `main.ts`.

Progress on 2026-05-08:

- Local implementation complete: the existing inline frame-locomotion handler object moved into local `createFrameLocomotionHandlers(frameContext)`.
- `updateMovement(...)` now only builds pipeline input and passes `createFrameLocomotionHandlers(frameContext)`.
- Local verification complete: runtime build/test, invariant greps, and full local e2e passed.
- Commit `ca26095b77c076672acfea72eb6d38e71f8c3bbf` pushed; CI, Docker publish, staging deploy gate, and staging smoke passed.

Concrete changes:

- In `main.ts`, extract a local helper `createFrameLocomotionHandlers(frameContext: RuntimeFrameContext): FrameLocomotionPipelineHandlers`.
- Move only the handler object currently inline in `updateMovement(...)` into that helper.
- Keep all existing closures and side effects identical.
- Do not move this helper into another module unless the dependency list is already small; otherwise keep it local to avoid a fake abstraction.

Acceptance for Slice 5:

- `updateMovement(...)` should only call `executeFrameLocomotionPipeline(...)` with input and `createFrameLocomotionHandlers(frameContext)`.
- No behavior changes, no new public API, no changes to interaction or seating logic.

### Slice 6 - Documentation Completion Commit (done)

Goal: mark the refactor as complete enough for normal feature work.

Progress on 2026-05-08:

- Runtime cleanup complete through final verified runtime commit `ca26095b77c076672acfea72eb6d38e71f8c3bbf`.
- Slices 1-5 each have local verification, CI, Docker publish, staging deploy gate, public smoke, and rollback status recorded above.
- This slice is docs-only; no staging deploy is required.

Concrete changes:

- Update this file with the final commit SHA and verification results.
- If Slice 1-5 are done, add a short "maintenance mode" section: future changes should add tests to the specific domain module, not add logic to `main.ts`.
- Do not mix docs completion with runtime code changes.

Acceptance for Slice 6:

- Docs-only commit.
- No staging deploy required for docs-only update.

## Maintenance Mode

- Future runtime behavior changes should add or update tests in the specific domain module they touch: local pose, input, locomotion, interaction, seating, runtime commands, or avatar transport.
- Keep `main.ts` as composition/orchestration. Do not add new domain behavior there when it belongs in a domain module.
- Keep frame locomotion changes mechanical unless there is a separate product or bugfix requirement with its own tests.
- Preserve the current acceptance invariants for pose ownership, XR frame sampling, seating `three` imports, and main seat command routing.
- Runtime changes still require local verification, commit/push, CI, Docker publish, staging deploy gate, public smoke, and rollback status.
- Docs-only updates do not require staging deploy.

## Explicit Non-Goals From Here

- Do not rewrite all of `updateMovement(...)` in one commit.
- Do not change scene loading, scene bundles, material handling, or staging assets while doing locomotion cleanup.
- Do not add feature flags for this refactor.
- Do not change public room-state protocol unless a separate product requirement appears.
- Do not move room-state connection callbacks out of `main.ts` just to reduce line count; only extract pure planning/read-model code.
- Do not reintroduce direct pose writes outside `apps/runtime-web/src/local/`.
- Do not add `three` imports to `apps/runtime-web/src/seating/`.

## Definition Of Done For Runtime Slices

Run locally before commit:

```bash
pnpm --filter @vrata/runtime-web build
pnpm --filter @vrata/runtime-web test
git diff --check
grep -R -E "player\.position\.set|player\.position\.[xyz][[:space:]]*=|player\.rotation\.y[[:space:]]*=" apps/runtime-web/src
grep -R "renderer\.xr\.getFrame" apps/runtime-web/src
grep -R -E "from ['\"]three['\"]|from ['\"]three/" apps/runtime-web/src/seating
grep -R -E "sendSeatClaim|sendSeatRelease|requestSeatClaim\(" apps/runtime-web/src/main.ts
pnpm test:e2e
```

After commit/push for runtime slices:

```text
CI must pass.
Docker Publish must pass.
Staging Deploy gate must pass.
Post-deploy smoke must cover /health, /rooms/demo-room, and /control-plane.
If the staging gate flakes, inspect failure context first; retry only when diagnostics show transient scene/RTC startup behavior.
```

Docs-only changes do not need staging deploy.

## Next Agent Instruction

Do not restart the locomotion refactor slices. For future runtime work, follow Maintenance Mode and preserve the acceptance invariants. If a required change looks like it will modify runtime behavior, split it into a separate bugfix or feature task with its own tests.
