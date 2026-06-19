# Docker Image Scene Deployment

This document describes what must be true for a private scene deployment to use published Vrata Docker images without a platform source checkout.

## What Was Missing

Three source dependencies made private scene deployments rebuild or checkout the platform repository:

- Runtime media surface placement was source-only. Moving the main screen, hiding fallback whiteboard/laptop planes, or matching a screen to a GLB frame required editing `apps/runtime-web/src/main.ts` and rebuilding `@vrata/runtime-web` inside the API image.
- The self-host compose file mixed release image references with local `build:` blocks for `api`, `room-state`, and `remote-browser`, so `docker compose up` still expected platform sources.
- Caddy mounted `../../apps/runtime-web/public` from the source tree even though the release API image already contains the runtime app. Private scene assets only need a static mount at `/assets/scenes`.

## Image-Only Requirements

A Docker-image-only deployment needs only these inputs:

- `infra/docker/compose.selfhost.images.yml`.
- `infra/docker/Caddyfile.selfhost`.
- `infra/docker/minio-bootstrap.sh` and `infra/docker/minio-scene-smoke.json` for the default MinIO bootstrap path.
- An env file based on `infra/docker/.env.selfhost.example` with non-placeholder secrets and a release `IMAGE_TAG`.
- A private scene-assets directory mounted through `VRATA_SCENE_ASSETS_DIR` when serving same-origin scene bundles through Caddy.
- Scene bundle metadata registered through the control-plane API or equivalent automation.

No `apps/`, `packages/`, `pnpm`, TypeScript compiler, or local Docker build context is required for this path.

## Compose Usage

From a directory containing the copied `infra/docker` files:

```bash
cp .env.selfhost.example .env.selfhost
```

Edit `.env.selfhost`:

- replace every `CHANGE_ME` value;
- set `IMAGE_TAG` to the published release tag;
- set browser-reachable `VRATA_APP_BASE_URL`, `ROOM_STATE_PUBLIC_URL`, `LIVEKIT_URL`, and `REMOTE_BROWSER_PUBLIC_URL`;
- set `VRATA_SCENE_ASSETS_DIR` to a directory containing scene bundle folders such as `old-room-v1/scene.json` and `old-room-v1/scene.glb`.

Then run:

```bash
docker compose --env-file .env.selfhost -f compose.selfhost.images.yml pull
docker compose --env-file .env.selfhost -f compose.selfhost.images.yml up -d
```

Smoke checks:

```bash
curl -fsS "$VRATA_APP_BASE_URL/health"
curl -fsS "$VRATA_APP_BASE_URL/control-plane"
curl -fsS "$VRATA_APP_BASE_URL/assets/scenes/<scene-id>/scene.json"
```

## Scene Bundle Responsibilities

The platform image must stay generic. Private scene repositories own:

- GLB or other scene assets;
- `scene.json` metadata;
- attribution and license notes;
- scene-specific surface placement and anchors when supported by the scene bundle contract;
- registration scripts that bind the scene bundle version to a room.

This keeps the public platform image free of proprietary assets while still allowing private rooms to use the published runtime image.
