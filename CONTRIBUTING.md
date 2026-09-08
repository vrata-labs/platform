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
