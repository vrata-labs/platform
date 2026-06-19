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
