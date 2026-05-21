# Status

## Current phase

- Active phase: `M1.9 — протокол расширений для независимых разработчиков`
- Overall state: `ready_for_implementation`

## Phase checklist

- [x] Create planning document for `M0 -> M1`
- [x] Create `docs/product-scope.md`
- [x] Create ADR set `001-006`
- [x] Create `docs/architecture.md`
- [x] Create initial monorepo skeleton directories
- [x] Add root workspace files: `package.json`, `pnpm-workspace.yaml`, `.gitignore`
- [x] Add baseline `.env.example`
- [x] Add baseline CI workflow for `lint`, `typecheck`, `build`
- [x] Add package-level app scaffolds
- [x] Validate scripts and CI after first package manifests are added
- [x] Add baseline API contracts document
- [x] Add dev/staging environment notes
- [x] Add basic API server with health, manifest, and token endpoints
- [x] Smoke-test API endpoints locally
- [x] Add runtime boot helpers and manifest loading scaffold
- [x] Add runtime-core lifecycle, overlay, manifest, and quality scaffolds
- [x] Add room-state schema and join helpers scaffold
- [x] Smoke-test runtime boot flow against local API
- [x] Add media-plane scaffold and voice session planning
- [x] Add media token acquisition flow in runtime scaffold
- [x] Add media-plane documentation and env surface
- [x] Smoke-test media token planning against local API
- [x] Add XR detection and hardening scaffolds
- [x] Add feature flag and telemetry helper scaffolds
- [x] Add in-memory control-plane CRUD for tenants, templates, rooms, and assets
- [x] Add template registry and space-manifest scaffold
- [x] Add asset validation and preset scaffolds
- [x] Add unit tests across apps and packages
- [x] Extend CI to run tests and asset-pipeline checks
- [x] Smoke-test control-plane tenant and room creation flow

## Notes

- M1.1 access roles foundation is complete as of 2026-05-12. Deployed commit: `065b6a92a8139fa4f4b3208e8e81b60a4f8ad26a`.
- M1.1 verification: local full suite passed, CI `25726722155` passed, Docker Publish `25726722173` passed, Staging Deploy `25726820329` passed, and `pnpm test:e2e:staging` passed with 33 tests.
- Manual staging QA in `demo-room` confirmed the admin/host role path works normally.
- M1.2 unified surface input protocol is complete as of 2026-05-12. Deployed commit: `c0bda45f541fcba8a89d7830ffef4c38bc3e4605`.
- M1.2 verification: local runtime/shared-types/unit/e2e checks passed, CI `25736402601` passed, Docker Publish `25736402599` passed, Staging Deploy `25736527346` passed, `pnpm test:e2e:staging` passed with 33 tests, and staging `surface-input-protocol` passed with 4 tests.
- M1.3 media surface kernel is complete as of 2026-05-12. Deployed commit: `ce2aa7ef806996d7fc05594009709ecfa7008585`.
- M1.3 verification: local lint/typecheck/build/test/e2e checks passed, CI `25747564664` passed, Docker Publish `25747564641` passed after transient YCR OAuth retry, Staging Deploy `25748083239` passed, `pnpm test:e2e:staging` passed with 33 tests, and staging `media-surface-kernel` passed with 3 tests.
- M1.4 screen share object is complete as of 2026-05-12. Deployed commit: `530ec378c922291ba90d66b61f274ad573695262`.
- M1.4 verification: local lint/typecheck/build/test/e2e checks passed, CI `25754283093` passed, Docker Publish `25754283110` passed, Staging Deploy `25754417823` passed, `pnpm test:e2e:staging` passed with 33 tests, and staging `screen-share-object` passed with 3 tests.
- Post-M1.4 per-surface media audio policy is complete as of 2026-05-13. Final deployed commit: `6293b84fc7ae0f2da8e95830f2a8c5f442fdc9a0`.
- Post-M1.4 audio verification: local runtime build/test passed, local full e2e passed with 78 passed and 1 skipped, CI `25762802250` passed, Docker Publish `25762802227` passed, Staging Deploy `25762892542` passed, `pnpm test:e2e:staging` passed with 33 tests, and staging `screen-share-object` passed with 4 tests.
- M1.5 whiteboard object is complete as of 2026-05-14. Baseline deployed commit: `b3f54520e27cfd15f7b8c504056bd2e7ebb6314f`; final VR pencil Draw-toggle gating deployed commit: `50d1bbc6885e14df61edd93d6ea14c98ddb2c500`.
- M1.5 follow-up fixes completed the product path for web/VR whiteboard drawing: draw input handling, preview texture flicker removal, contact-pencil drawing, hand anchoring, shared hand-pose source, grip-angle tuning, and explicit `Draw: On/Off` gating for pencil visibility and XR drawing.
- M1.5 final verification: local runtime build/test, lint, typecheck, repo build/test, local full e2e, CI `25847859871`, Docker Publish `25847859884`, Staging Deploy `25847941037`, staging deploy gate `33 passed`, workspace `pnpm test:e2e:staging` `33 passed`, and staging `whiteboard-object` `6 passed`.
- M1.6 host web-content broadcast is skipped as a separate implementation phase as of 2026-05-14: the user-facing scenario is already covered by M1.4/post-M1.4 `screen-share`, which shows the host's screen, window, or browser tab as a video stream and explicitly does not provide remote page control.
- M1.7 remote browser object is accepted as complete for this stage as of 2026-05-21. Final deployed commit: `c6023ec1ae4e3ba4d75e7bb284be2bdb30f01828`.
- M1.7 result: `remote-browser` works as a server-side browser executor with allowlisted URL opening, authoritative surface input, LiveKit viewport publishing, and normal remote audio playback path. The final audio fix exposes the PulseAudio monitor as a Chromium-compatible input source instead of accepting muted/video-only success.
- M1.7 verification: focused local remote-browser/runtime checks passed, Docker audio probe passed, full local E2E passed with `90 passed` using `--workers=2`, CI `26223417565` passed, Docker Publish `26223417566` passed, Staging Deploy `26223562956` passed, and the staging gate passed with `35 passed` on deployed SHA `c6023ec1ae4e3ba4d75e7bb284be2bdb30f01828`.
- M1.7 accepted limitations: audio can still stutter on VR and mobile under real device conditions. Treat this as a QoS/performance follow-up, not a blocker for starting M1.8, unless it regresses the core media-surface flow.
- M1.8 multi-surface layouts are complete as of 2026-05-21. Final deployed commit: `e7a3187b89a4f16a441e22909339436d9c62e697`.
- M1.8 result: the first product slice adds default independent surfaces `debug-main`, `whiteboard-wall`, and `laptop-screen`; a runtime surface selector; per-surface active object/texture routing; legacy room default-surface repair; and hit-surface-based input routing for screen share, whiteboard, and remote browser.
- M1.8 verification: package-specific builds/tests/lint for touched packages passed; root `pnpm run lint`, `pnpm run typecheck`, `pnpm run build`, and `pnpm run test` passed; related M1 media specs passed (`18 passed` including M1.8); full local E2E with `--workers=2` passed (`90 passed`, `1 skipped`); CI `26237312112` passed; Docker Publish `26237312118` passed; Staging Deploy `26237508379` passed; staging gate passed with `35 passed`; and focused staging `multi-surface-layouts` passed with `1 passed`.
- M1.8 rollback/retry notes: no rollback and no deploy retry were needed.
- Next focus: M1.9 extension protocol.

- M0.5 focuses on acceptance of the existing basic multi-user presence path: diagnostics, pose orientation, remote visibility, join/leave cleanup, voice state, spatial-audio diagnostics, and XR-mode simulation.
- M0.5 explicitly excludes humanoid avatars, new room templates, and control-plane expansion.
- Current repository state is greenfield with docs and skeleton only.
- `Phase 1` should stay time-boxed and must not redefine the product stack.
- `Phase 0` is complete enough to move into `M0` foundation work.
- Current API tokens are placeholder payloads and must be replaced with signed integrations before production use.
- Current progress now includes a public staging room shell with Three.js runtime, presence sync, LiveKit-backed audio join flow, and HTTPS via `sslip.io`.
- Voice transport is wired for staging; browser E2E now covers room load and two-participant presence. Persistent storage, auth, richer XR locomotion, and production hardening are still pending.
- GitHub repository published: `https://github.com/psilon2000/noah`
- Current staging room URL: `https://epdt15bceu6l26iqkk9n.158.160.66.37.sslip.io/rooms/demo-room`
- Current staging control-plane URL: `https://epdt15bceu6l26iqkk9n.158.160.66.37.sslip.io/control-plane`
- Current staging API health endpoint: `https://epdt15bceu6l26iqkk9n.158.160.66.37.sslip.io/health`
- Current staging LiveKit endpoint: `wss://livekit-epdt15bceu6l26iqkk9n.158.160.66.37.sslip.io`
- Current staging control-plane admin token: `noah-stage-admin`

## Latest manual QA

- Scenario: `Quest 2 VR + web desktop`
- Result: two-way room presence works; VR movement works; web and VR clients now see each other's motion more smoothly than before.
- Improvement confirmed: previous severe self-avatar jitter and remote teleporting were reduced after buffered motion and XR input fixes.
- Remaining issue: motion is better but still not perfectly smooth; voice behavior still needs deeper validation/tuning.
- Next focus: validate the explicit root/head/body replication model in staging and then revisit spatial audio / voice diagnostics.

## Current hardening snapshot

- Control-plane mutating endpoints now require admin token when `CONTROL_PLANE_ADMIN_TOKEN` is set.
- Staging runs with `Postgres` enabled for control-plane persistence.
- Browser E2E currently covers room boot, presence, diagnostics, control-plane creation, secured creation, token persistence, and mock screen share flow.
