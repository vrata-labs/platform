# Status

## Current phase

- Active phase: `M1.5 — интерактивная доска`
- Overall state: `in_progress`

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
- Next focus: M1.5 whiteboard object on the media surface kernel.

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
