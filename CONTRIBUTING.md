# Contributing

Vrata is preparing for a public `0.1` beta. Contributions should keep the project easy to self-host, test, and roll back.

## Workflow

- Branch from `main`.
- Keep branches short-lived and focused.
- Open a pull request before merging.
- Keep CI green before review/merge.
- Prefer squash merge unless the PR has a reason to preserve individual commits.
- Release only from SemVer tags such as `v0.1.0`.

## Before Opening A PR

- Run `pnpm lint`.
- Run `pnpm typecheck`.
- Run `pnpm build`.
- Run `pnpm test`.
- Run `pnpm test:e2e` when runtime or user-facing behavior changes.
- Run `pnpm test:e2e:gpu tests/e2e/seat-marker-visual.spec.ts` on a host with a GPU before publishing changes to seating, avatars, seat markers or scene rendering (see Hardware Rendering below).
- Run `docker compose --env-file infra/docker/.env.selfhost.example -f infra/docker/compose.selfhost.yml config` when self-host compose or env files change.

### What The Checks Cover

`lint` is package-defined. In `apps/runtime-web`, both `lint` and `typecheck`
currently run `tsc -p tsconfig.json --noEmit`; they are not independent checks,
and `lint` does not run a separate style linter in that package. Keep both root
commands until a separate change deliberately updates the package contracts.

`pnpm run test:m0.5` remains the standalone local acceptance command: it runs
lint, typecheck, build, unit tests, then the M0.5 browser tests with one worker.
CI runs those prerequisites once in earlier steps, then invokes the same M0.5
browser tests directly. Neither browser suite is removed.

In CI, Playwright rejects `test.only` and refuses to reuse an existing local
server. Local runs may still reuse a development server. The local CI browser
steps set `PLAYWRIGHT_TRACE=1` to retain traces on failure in the existing
Playwright artifacts; staging tracing remains opt-in. Treat traces as
potentially sensitive, and do not publish traces containing real credentials.

### Hardware Rendering

CI runners have no GPU: Chromium renders WebGL in software (SwiftShader), at
about one frame per second in the actual reference rooms. The visual scenarios
of `tests/e2e/seat-marker-visual.spec.ts` detect the WebGL renderer before they
create a room and are skipped on a software renderer; the skip reason names the
renderer. Their non-visual scenarios and the component test run everywhere.
Requirements, deadlines and assertions of the visual scenarios are the same in
every environment.

`playwright.gpu.config.ts` (`pnpm test:e2e:gpu`) reuses `playwright.config.ts`
and changes only the browser launch: full Chromium (`channel: "chromium"`, new
headless) with GPU flags; under WSLg (`/dev/dxg` present) it also sets
`GALLIUM_DRIVER=d3d12` for the browser. It sets
`VRATA_E2E_REQUIRE_HARDWARE_RENDERING=1`, so these scenarios fail instead of
skipping if the browser still renders in software. Install the full browser
with `pnpm exec playwright install chromium`. This run is required before
publishing changes to seating, avatars, seat markers or scene rendering. Specs
that set their own `launchOptions` keep their own launch settings.

## Runtime Boundaries

Runtime local pose, XR input, interaction rays, teleport, seating, and avatar publishing have strict ownership rules. Read `AGENTS.md` and `apps/runtime-web/README.md` before changing those areas.

## Release Impact Checklist

Every PR should state whether it affects:

- self-host setup;
- public images;
- database schema or migration behavior;
- scene bundle compatibility;
- room/API contracts;
- staging deployment;
- upgrade or rollback behavior.

## Security

Do not put secrets, customer assets, private scene assets, or private staging credentials in the repository. See `SECURITY.md`.
