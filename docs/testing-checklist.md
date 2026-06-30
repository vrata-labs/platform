# Testing And Staging Contract

This document is the source of truth for where Vrata tests live, where they run, and where their results are stored.

## Where Tests Live

- Unit and integration tests live next to the code they validate: `apps/**`, `packages/**`, and `tools/*.test.mjs`.
- Browser e2e tests live in `tests/e2e/`.
- Staging-facing e2e tests use the Playwright `@staging` tag and live in `tests/e2e/runtime-staging.spec.ts` or focused staging specs.
- Private scene asset tests use the Playwright `@private-assets` tag and are excluded from public platform CI.
- Product milestone acceptance tests live under `tests/e2e/m0.5/` and `tests/e2e/m1-media/`.
- Asset pipeline validation lives in `packages/asset-pipeline`.

## Where Tests Run

- Pull requests and pushes to integration branches run `.github/workflows/ci.yml`.
- Internal staging rollout and staging verification run `.github/workflows/staging-deploy.yml`.
- Manual staging verification utility runs `.github/workflows/staging-smoke.yml`.
- Public release image publishing runs `.github/workflows/docker-release.yml` after SemVer tags or manual release-candidate dispatch.

## Local Commands

- `pnpm lint`
- `pnpm typecheck`
- `pnpm build`
- `pnpm test`
- `pnpm test:e2e`
- `pnpm test:e2e:private-assets` only when private scene assets are available locally; staging private asset coverage runs through `pnpm test:e2e:staging`.
- `pnpm test:e2e:staging` only after the target commit is deployed to staging.
- Full local staging e2e uses a gitignored `.env.staging.local` for staging-only secrets. Generate it with `pnpm staging:e2e:pull-env -- --ssh <user>@158.160.10.234` when you have SSH access to the staging VM, or create it manually from `.env.staging.local.example`.
- Local staging e2e defaults to `--workers=1` to avoid false negatives in external Rutube/browser transport checks on developer machines. GitHub Actions keeps its normal parallelism, and local runs can still override this with `pnpm test:e2e:staging -- --workers=2`.
- `docker compose --env-file infra/docker/.env.selfhost.example -f infra/docker/compose.selfhost.yml config`

## CI Gate

`.github/workflows/ci.yml` runs:

- lint;
- typecheck;
- build;
- self-host compose config validation;
- unit/integration tests;
- local Playwright e2e excluding `@staging`;
- local Playwright e2e excluding `@private-assets`;
- M0.5 acceptance;
- asset pipeline validation.

The M0.5 release gate includes `tests/e2e/m0.5/reliable-room-scenario.spec.ts`, which creates a clean room and verifies four unique browser participants, cross-client presence, movement visibility, reload stability, stale participant replacement, and late-join state catch-up. Local runs validate voice join when the local LiveKit stack is available and otherwise require an explicit failed audio state while keeping the room usable; staging remains the authoritative successful voice gate.

The M0.5 cross-device gate includes `tests/e2e/m0.5/cross-device-join-flow.spec.ts`, which creates a clean room and verifies desktop, mobile-touch, and VR-mock clients in one shared session. It asserts resolved join modes, non-blocking degraded compatibility diagnostics, touch-control readiness, VR mock diagnostics, and cross-client visibility.

The M0.5 WebXR renderer gate includes `tests/e2e/m0.5/webxr-renderer-wiring.spec.ts`, which verifies the XR renderer/session diagnostics contract, hides the VR entry point when `XR_ENABLED=false`, and confirms failed Enter VR attempts report `xr_enter_failed` without crashing the room.

The public connectivity diagnostics gate is covered by `tests/e2e/runtime.spec.ts` and staging tests. It verifies stable report codes for API reachability (`api_ok` / `api_unreachable`), room-state WSS (`room_state_ws_ok` / `room_state_ws_failed`), microphone denial (`microphone_permission_denied`), LiveKit media (`media_ok`), object storage (`storage_ok` / `storage_unreachable` / `storage_skipped`), admin-detail protection (`admin_details_protected`), timeout handling (`connectivity_check_timeout`), and redacted JSON reports that can be copied into GitHub issues.

## Cross-Device Compatibility Matrix

Use this matrix for manual compatibility checks when real devices are available. Automated CI covers Chrome desktop, mobile emulation, no-WebXR fallback, and VR mock presence; hardware Quest checks remain manual until a real device lab is available.

| Client | Expected mode | Expected controls | Expected VR button | Required result |
| --- | --- | --- | --- | --- |
| Chrome desktop | `desktop` | keyboard and mouse | active only when WebXR is supported | room joins, diagnostics show `clientCompatibility.resolvedJoinMode=desktop` |
| Mobile Chrome/Safari | `mobile` | left-drag move, right-drag look | disabled/hidden when WebXR is unavailable | room joins without XR crash, diagnostics show touch controls supported |
| Quest Browser | `desktop` before session, `vr` after user gesture | Enter VR then XR controllers | active when WebXR immersive VR is supported | room joins before VR, then publishes `mode=vr` after Enter VR |
| Browser without microphone | desktop or mobile | normal navigation controls | unchanged by audio capability | room joins with audio disabled/degraded, diagnostics include `audio_input_unavailable` |
| Browser without WebXR | desktop or mobile | normal non-XR controls | disabled with VR unavailable messaging | room joins without XR crash, diagnostics include `xr_unavailable` |

## Manual WebXR Checklist

Run this checklist on a real WebXR-compatible headset before public demos and release candidates that include VR changes:

| Check | Expected result |
| --- | --- |
| Enter VR from a loaded room | `xrSession.sessionState=active`, `mode=vr`, room remains connected |
| Move or turn in VR | desktop observer sees XR root/head movement, diagnostics increment `xrSession.transformSyncCount` |
| Observe desktop participant from VR | non-XR participant remains visible in `remoteParticipants` and in scene |
| Exit VR | `xrSession.sessionState=idle`, room-state/audio session remains connected |
| Deny or fail Enter VR | room stays usable, diagnostics show `xr_enter_failed`, no white screen |

## Manual 3-4 Participant Checklist

Use this checklist before public demos and release candidates when real devices are available:

- Create or select one clean meeting room on staging.
- Join as host on desktop, member on a second desktop/browser, guest on mobile, and guest/member in VR or a fourth browser.
- Confirm every participant sees the other three in diagnostics: `remoteAvatarCount=3`, stable `participantId`s, and no duplicate stale rows after 30 seconds.
- Move participant A and confirm B/C/D see root/head movement update without large jumps or stale diagnostics.
- Join audio on at least two participants and confirm remote mic status becomes live/speaking plus `subscribedAudioCount>=1` for the listener.
- Reload one non-host participant and confirm the other participants stay connected and the reloaded participant returns with the expected identity for same-browser reload.
- Close and reopen one participant in a fresh browser context and confirm stale participant removal plus replacement visibility.
- Join a late fourth participant after movement/audio are already active and confirm it receives current presence, visuals, and audio joined/muted state.
- Save the staging deploy run URL, Playwright artifact URL if present, browser/device list, room id, and any diagnostics report ids in the release notes.

## Staging Gate

`.github/workflows/staging-deploy.yml` is the source of truth for internal staging rollout verification.

It runs after the internal Docker publish workflow succeeds and then:

- checks out and uploads private scene assets for internal staging only;
- deploys immutable SHA-tagged images;
- patches canonical staging scene bundle URLs;
- checks `/health`, `/rooms/demo-room`, and `/control-plane`;
- runs `pnpm test:e2e:staging` against the public staging URL;
- persists the successful SHA;
- rolls back automatically on verification failure.

## Test Artifacts

Playwright writes reports to stable paths:

- HTML report: `playwright-report/<report-name>/`;
- JSON report: `test-results/<report-name>.json`;
- failure output: `test-results/<report-name>/`.

The default Playwright test timeout is `45s`; this keeps the full browser suite reliable under CI parallelism while still failing genuinely stuck flows quickly.

GitHub Actions uploads these paths as artifacts with 14-day retention:

- `playwright-local-<run-id>-<attempt>` from CI;
- `playwright-staging-gate-<run-id>-<attempt>` from staging deploy;
- `playwright-staging-smoke-<run-id>-<attempt>` from manual staging smoke.

Do not put secrets in page-visible test output. Runtime access tokens are redacted from `__VRATA_DEBUG__`; keep that invariant before adding new uploaded artifacts. Playwright traces are disabled by default and should only be enabled deliberately with `PLAYWRIGHT_TRACE=1` for short-lived debugging.

## Public Release Requirement

Before a public `v0.1.0` release, the release commit must have:

- green CI;
- green internal staging gate;
- green self-host compose config validation;
- available Playwright artifacts for any failing/retried runs;
- documented upgrade and rollback rehearsal.
