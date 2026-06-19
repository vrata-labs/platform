# Self-Hosting

This document describes the target self-host path for Vrata `0.1` beta.

Until `v0.1.0` is released, public GHCR images may not exist. From a source checkout, use `--build` to build images locally.

## Requirements

- Docker with Compose v2.
- A Linux host or local Docker environment.
- Ports for app, room-state, LiveKit, remote-browser, and MinIO.
- For public HTTPS deployment: domains or test hostnames for app/state/livekit/browser endpoints.

## Source-Build Quickstart

From the repository root:

```bash
docker compose --env-file infra/docker/.env.selfhost.example -f infra/docker/compose.selfhost.yml config
docker compose --env-file infra/docker/.env.selfhost.example -f infra/docker/compose.selfhost.yml up -d --build
```

Smoke checks:

```bash
curl -fsS http://127.0.0.1:4000/health
curl -fsS http://127.0.0.1:4000/rooms/demo-room
curl -fsS http://127.0.0.1:4000/control-plane
```

Teardown for local evaluation:

```bash
docker compose --env-file infra/docker/.env.selfhost.example -f infra/docker/compose.selfhost.yml down
```

To remove persistent data from a test deployment:

```bash
docker compose --env-file infra/docker/.env.selfhost.example -f infra/docker/compose.selfhost.yml down -v
```

## Release Image Path

After `v0.1.0`, use the image-only compose file when you want to deploy from published images without a source checkout. Copy the `infra/docker` directory or release deployment bundle to the target host, then copy the example env file and select a release tag:

```bash
cp .env.selfhost.example .env.selfhost
```

Edit `.env.selfhost` and set real secrets, domains, `IMAGE_TAG`, and optionally `VRATA_SCENE_ASSETS_DIR` for same-origin private scene bundles.

Then run:

```bash
docker compose --env-file .env.selfhost -f compose.selfhost.images.yml pull
docker compose --env-file .env.selfhost -f compose.selfhost.images.yml up -d
```

See `docs/docker-image-scene-deployment.md` for the minimal file set and scene asset responsibilities.

## Required Configuration

- `CONTROL_PLANE_ADMIN_TOKEN`: replace with a strong secret.
- `STATE_TOKEN_SECRET`: replace with a strong secret.
- `REMOTE_BROWSER_TOKEN_SECRET`: replace with a strong secret.
- `VRATA_INTERNAL_SERVICE_TOKEN`: replace with a strong secret.
- `POSTGRES_PASSWORD`: replace with a strong password.
- `MINIO_ROOT_USER` and `MINIO_ROOT_PASSWORD`: replace with production values.
- `VRATA_APP_BASE_URL`, `ROOM_STATE_PUBLIC_URL`, `LIVEKIT_URL`, and `REMOTE_BROWSER_PUBLIC_URL`: set to the URLs that browsers can reach.

The bundled compose file runs LiveKit in `--dev` mode for the `0.1` beta quickstart, so the local defaults are `LIVEKIT_API_KEY=devkey` and `LIVEKIT_API_SECRET=secret`. Replace this with a hardened LiveKit configuration before exposing a deployment beyond evaluation use.

## Persistent Data

The self-host compose file stores data in Docker volumes:

- `postgres-data` for room/control-plane data;
- `minio-data` for scene bundle objects;
- `caddy-data` and `caddy-config` for Caddy state.

Back up these volumes before upgrades. See `docs/upgrades.md`.

## Adding A Space

The minimal `0.1` flow is API-driven:

- prepare a scene bundle with `scene.json` and assets;
- upload it to MinIO or S3-compatible storage;
- register scene bundle metadata through the API;
- bind the bundle to a room;
- open the room URL and verify diagnostics.

See `docs/scene-bundle-contract.md` for the bundle layout.

## Production Notes

Do not expose a self-hosted deployment with example secrets. The `0.1` beta does not yet provide a complete production hardening guide.
