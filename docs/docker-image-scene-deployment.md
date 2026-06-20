# Docker Image Scene Deployment

This document describes what must be true for a private scene deployment to use published Vrata Docker images without a platform source checkout.

## What Was Missing

Three source dependencies made private scene deployments rebuild or checkout the platform repository:

- Runtime media surface placement was source-only. Moving the main screen, hiding fallback whiteboard/laptop planes, or matching a screen to a GLB frame required editing `apps/runtime-web/src/main.ts` and rebuilding `@vrata/runtime-web` inside the API image.
- The self-host compose file mixed release image references with local `build:` blocks for `api`, `room-state`, and `remote-browser`, so `docker compose up` still expected platform sources.
- Caddy mounted `../../apps/runtime-web/public` from the source tree even though the release API image already contains the runtime app. Private scene assets need an API upload path into object storage, not a platform source checkout or baked Docker image.

## Image-Only Requirements

A Docker-image-only deployment needs only these inputs:

- `infra/docker/compose.selfhost.images.yml`.
- `infra/docker/Caddyfile.selfhost`.
- `infra/docker/minio-bootstrap.sh` and `infra/docker/minio-scene-smoke.json` for the default MinIO bootstrap path.
- An env file based on `infra/docker/.env.selfhost.example` with non-placeholder secrets and a release `IMAGE_TAG`.
- Scene bundle files uploaded through the control-plane API into the configured MinIO/S3-compatible provider.
- Scene bundle metadata registered through the control-plane API or equivalent automation after upload.

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
- set `MINIO_PUBLIC_BASE_URL` to a browser-reachable base URL for uploaded scene bundles. For same-origin local evaluation, use `$VRATA_APP_BASE_URL/scene-bundles` and keep the `/scene-bundles/*` Caddy proxy enabled.
- keep `MINIO_INTERNAL_ENDPOINT=http://minio:9000` for the default bundled MinIO provider, or configure the `SCENE_BUNDLE_S3_*` values for an external S3-compatible provider.

Then run:

```bash
docker compose --env-file .env.selfhost -f compose.selfhost.images.yml pull
docker compose --env-file .env.selfhost -f compose.selfhost.images.yml up -d
```

Smoke checks:

```bash
curl -fsS "$VRATA_APP_BASE_URL/health"
curl -fsS "$VRATA_APP_BASE_URL/control-plane"
```

## Scene Upload Flow

Upload each file with a raw request body and the control-plane admin token:

```bash
curl -fsS -X PUT \
  -H "x-vrata-admin-token: $CONTROL_PLANE_ADMIN_TOKEN" \
  -H "content-type: model/gltf-binary" \
  --data-binary @scene.glb \
  "$VRATA_APP_BASE_URL/api/scene-bundles/old-room/versions/v1/files/scene.glb"
```

The upload endpoint writes to the configured provider under:

```text
scenes/<bundleId>/<version>/<relative-file-path>
```

After uploading `scene.json`, create the scene bundle version with the returned `storageKey`, `publicUrl`, `checksum`, `sizeBytes`, `contentType`, and `provider`, then bind the room through:

```text
POST /api/scene-bundles/<bundleId>/versions
POST /api/rooms/<roomId>/bind-scene-bundle
```

For VR/headset usage, make sure the returned `publicUrl` is HTTPS. The default self-host Caddy config supports this by proxying `/scene-bundles/*` to MinIO, so a stage deployment can set `MINIO_PUBLIC_BASE_URL=https://<stage-domain>/scene-bundles`.

## Scene Bundle Responsibilities

The platform image must stay generic. Private scene repositories own:

- GLB or other scene assets;
- `scene.json` metadata;
- attribution and license notes;
- scene-specific surface placement and anchors when supported by the scene bundle contract;
- upload/registration scripts that publish files through the API and bind the scene bundle version to a room.

This keeps the public platform image free of proprietary assets while still allowing private rooms to use the published runtime image.
