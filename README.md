# Vrata

Vrata is a web-native immersive room platform. The project is moving toward a public open source `0.1` beta focused on self-hosted rooms, browser-first access, scene bundles, real-time presence, voice, and extensible collaboration surfaces.

`0.1` is not a production SLA release. Treat it as an early platform baseline for experimentation, demos, and self-hosted evaluation.

## What Vrata Includes

- Web runtime in `apps/runtime-web` built around Three.js and WebXR progressive enhancement.
- API/control plane in `apps/api` and `apps/control-plane` for rooms, templates, assets, and scene bundle metadata.
- Realtime room state in `apps/room-state`.
- LiveKit-based media integration for voice and room media features.
- Remote browser service in `apps/remote-browser` for web surface streaming experiments.
- Docker Compose infrastructure for local/staging today and self-hosting as the public `0.1` target.

## Beta Platform Scope

For `0.1`, “platform” means a user can:

- clone the repository or pull public Docker images after the first public release;
- run the stack on a single host with Docker Compose;
- configure domains, secrets, Postgres, LiveKit, and MinIO/S3-compatible storage;
- add rooms/spaces through the documented API/control-plane path;
- bind custom scene bundles to rooms;
- update between SemVer releases with backup and rollback instructions.

See `docs/platform.md` for the stability boundary and known beta limitations.

## Quickstart Status

The public self-host path is being prepared. Until `v0.1.0` is released, use the source-build self-host path from `docs/self-hosting.md` rather than expecting published GHCR images to exist.

```bash
pnpm install --frozen-lockfile
pnpm lint
pnpm typecheck
pnpm build
pnpm test
pnpm test:e2e
```

Self-host compose config check:

```bash
docker compose --env-file infra/docker/.env.selfhost.example -f infra/docker/compose.selfhost.yml config
```

## Documentation

- `docs/platform.md` - public beta platform scope and stability policy.
- `docs/self-hosting.md` - Docker Compose self-host setup.
- `docs/upgrades.md` - backup, upgrade, smoke, and rollback flow.
- `docs/releases.md` - SemVer and release process.
- `docs/testing-checklist.md` - where tests live, run, and store artifacts.
- `docs/ci-cd.md` - GitHub Actions and staging/release operations.
- `docs/product-scope.md` - product hypothesis and MVP scope.
- `docs/architecture.md` - layer map.
- `docs/scene-bundle-contract.md` - scene bundle runtime contract.
- `docs/api-contracts.md` - API contracts.
- `docs/security.md` and `SECURITY.md` - security baseline and reporting policy.
- `docs/asset-license-audit.md` - asset provenance and public release blockers.
- `docs/scene-assets-repository.md` - boundary between platform code and private scene assets.

## Development Workflow

Vrata uses GitHub Flow for the public path:

- create a short-lived branch from `main`;
- open a pull request;
- keep CI green;
- squash/merge to `main` after review;
- release from SemVer tags such as `v0.1.0`.

See `CONTRIBUTING.md` for details.

## License

Vrata source code is licensed under Apache-2.0. See `LICENSE`.

Bundled assets may have separate licensing requirements. Public release remains blocked until the asset license audit is complete and non-redistributable assets are removed or isolated.
