# CI/CD Operations

Vrata keeps test and deployment automation in the repository and executes it in GitHub Actions.

## Source Of Truth

- Workflow definitions: `.github/workflows/`.
- Test specs: `tests/e2e/`, `apps/**`, `packages/**`, and `tools/*.test.mjs`.
- Test contract: `docs/testing-checklist.md`.
- Self-host deployment contract: `infra/docker/compose.selfhost.yml` and `docs/self-hosting.md`.
- Private scene asset tests are tagged `@private-assets` and are not part of public platform CI.
- Private scene assets can be synced into a maintainer checkout with `tools/sync-private-scene-assets.mjs` after a private scene-assets repository is checked out.
- Internal maintainer staging is intentionally separate from the public self-host contract and is not required for external users.

## GitHub Actions Roles

- `CI`: required PR/push verification.
- `Docker Release`: public GHCR image publishing for SemVer tags and release candidates.

## Where Results Are Stored

- Workflow logs and summaries are stored in GitHub Actions runs.
- Playwright HTML/JSON/failure artifacts are uploaded to each relevant workflow run.
- Release notes and changelog live in GitHub Releases and `CHANGELOG.md`.

## Environments

- Local developer environment: runs source-built tests and non-staging e2e.
- Public self-host: target user deployment path for `v0.1.0`.
- Maintainer staging, if used, is outside the public self-host contract.

## Policy

- Do not publish public GHCR release images before the code license, asset audit, and release gate are complete.
- Do not make public CI depend on private `sense-*` scene assets; use `pnpm test:e2e:private-assets` in private asset/staging contexts only.
- Do not add private scene assets back to public release images; staging-only sync must stay outside public release workflows.
- Keep artifacts short-lived and avoid writing secrets to browser-visible output.
