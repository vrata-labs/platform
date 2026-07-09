# CI/CD Operations

Vrata keeps test and deployment automation in the repository and executes it in GitHub Actions.

## Source Of Truth

- Workflow definitions: `.github/workflows/`.
- Test specs: `tests/e2e/`, `apps/**`, `packages/**`, and `tools/*.test.mjs`.
- Test contract: `docs/testing-checklist.md`.
- Self-host deployment contract: `infra/docker/compose.selfhost.yml` and `docs/self-hosting.md`.
- Internal staging rollout contract: `.github/workflows/staging-deploy.yml` and `infra/docker/rollout-staging-images.sh`.
- Private scene asset tests are tagged `@private-assets` and are not part of public platform CI.
- Private scene assets can be synced into an internal platform checkout with `tools/sync-private-scene-assets.mjs` after the private scene-assets repository is checked out.
- Staging deploy checks out `psilon2000/noah-scene-assets-private` with the read-only `PRIVATE_SCENE_ASSETS_DEPLOY_KEY` secret and uploads `assets/` to the staging host before rollout.

## GitHub Actions Roles

- `CI`: required PR/push verification.
- `Docker Publish`: internal YCR image publishing for staging.
- `Staging Deploy`: internal staging deploy and verification gate with rollback.
- `Staging Smoke`: manual staging verification utility.
- `Docker Release`: public GHCR image publishing for SemVer tags and release candidates.

## Where Results Are Stored

- Workflow logs and summaries are stored in GitHub Actions runs.
- Playwright HTML/JSON/failure artifacts are uploaded to each relevant workflow run.
- Staging successful SHA is stored on the staging VM at `/opt/noah/infra/docker/.staging-successful-image-tag`.
- Private staging scene assets are uploaded to the staging VM at `/opt/noah-private-scene-assets/assets` before each rollout.
- Local full staging e2e loads `.env.staging.local` through `pnpm test:e2e:staging`; populate it with `pnpm staging:e2e:pull-env -- --ssh <user>@158.160.10.234` or set `STAGING_ADMIN_TOKEN` directly in the shell.
- Release notes and changelog live in GitHub Releases and `CHANGELOG.md`.
- Compose backup manifests and local rollback env snapshots are written under `backups/` and must stay out of git.

## Environments

- Local developer environment: runs source-built tests and non-staging e2e.
- Internal staging: current managed validation host for deployed commits.
- Public self-host: target user deployment path for `v0.1.0`.

## Policy

- Do not treat local tests as staging verification for runtime/deploy changes.
- Do not run `pnpm test:e2e:staging` as validation of a new change before that exact commit is deployed.
- Do not publish public GHCR release images before the code license, asset audit, and release gate are complete.
- Do not make public CI depend on private `sense-*` scene assets; use `pnpm test:e2e:private-assets` in private asset/staging contexts only.
- Do not add private scene assets back to public release images; staging-only sync must stay outside public release workflows.
- Keep artifacts short-lived and avoid writing secrets to browser-visible output.
- Run `pnpm backup:compose` before self-host minor upgrades, validate the manifest, and use `pnpm rollback:compose` instead of `docker compose down -v` when reverting image tags.
