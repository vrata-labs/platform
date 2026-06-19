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

After `v0.1.0`, copy the example env file and select a release tag:

```bash
cp infra/docker/.env.selfhost.example infra/docker/.env.selfhost
```

Edit `infra/docker/.env.selfhost` and set real secrets, domains, and `IMAGE_TAG`.

Then run:

```bash
docker compose --env-file infra/docker/.env.selfhost -f infra/docker/compose.selfhost.yml pull
docker compose --env-file infra/docker/.env.selfhost -f infra/docker/compose.selfhost.yml up -d
```

## Required Configuration

- `CONTROL_PLANE_ADMIN_TOKEN`: replace with a strong secret.
- `STATE_TOKEN_SECRET`: replace with a strong secret.
- `REMOTE_BROWSER_TOKEN_SECRET`: replace with a strong secret.
- `VRATA_INTERNAL_SERVICE_TOKEN`: replace with a strong secret.
- `POSTGRES_PASSWORD`: replace with a strong password.
- `MINIO_ROOT_USER` and `MINIO_ROOT_PASSWORD`: replace with production values.
- `VRATA_APP_BASE_URL`, `ROOM_STATE_PUBLIC_URL`, `LIVEKIT_URL`, and `REMOTE_BROWSER_PUBLIC_URL`: set to the URLs that browsers can reach.
- `LIVEKIT_NODE_IP`: set to the public IP address advertised by the LiveKit node. Production preflight rejects loopback, private, reserved, and placeholder values.
- `VRATA_LIVEKIT_TCP_PORT` and `VRATA_LIVEKIT_UDP_PORT`: open these directly on the host for LiveKit WebRTC ICE/TCP fallback and UDP media traffic.

The bundled compose file runs LiveKit in `--dev` mode for the `0.1` beta quickstart, so the local defaults are `LIVEKIT_API_KEY=devkey` and `LIVEKIT_API_SECRET=secret`. Replace this with a hardened LiveKit configuration before exposing a deployment beyond evaluation use.

## Persistent Data

The self-host compose file stores data in Docker volumes:

- `postgres-data` for room/control-plane data;
- `minio-data` for scene bundle objects;
- `caddy-data` and `caddy-config` for Caddy state.

Back up these volumes before upgrades. Use `pnpm backup:compose`, validate the produced manifest with `pnpm backup:validate`, and keep the artifacts outside git. See `docs/backup-restore.md` and `docs/upgrades.md`.

## Adding A Space

The minimal `0.1` flow is API-driven:

- prepare a scene bundle with `scene.json` and assets;
- upload it to MinIO or S3-compatible storage;
- register scene bundle metadata through the API;
- bind the bundle to a room;
- open the room URL and verify diagnostics.

See `docs/scene-bundle-contract.md` for the bundle layout.

## Production Notes

Do not expose a self-hosted deployment with example secrets. The `compose.selfhost.yml` path is for local evaluation and keeps LiveKit in `--dev` mode.

Use the production-safe profile when preparing a public host:

```bash
cp infra/docker/.env.production.example infra/docker/.env.production
```

Edit `infra/docker/.env.production` and replace every `REPLACE_WITH_*` value, example hostname, and public URL. Public browser-facing URLs must use `https://` or `wss://` unless you are doing an explicit loopback-only preflight test with `VRATA_ALLOW_INSECURE_PRODUCTION_URLS=true`.

Run the preflight before starting services:

```bash
node tools/validate-production-config.mjs --env-file infra/docker/.env.production
```

Validate the compose model:

```bash
docker compose --env-file infra/docker/.env.production -f infra/docker/compose.production.yml config
```

Start from source-built images:

```bash
docker compose --env-file infra/docker/.env.production -f infra/docker/compose.production.yml up -d --build
```

Or start from published release images after `v0.1.0`:

```bash
docker compose --env-file infra/docker/.env.production -f infra/docker/compose.production.yml pull
docker compose --env-file infra/docker/.env.production -f infra/docker/compose.production.yml up -d
```

Smoke checks:

```bash
curl -fsS "$VRATA_APP_BASE_URL/health"
curl -fsS "$VRATA_APP_BASE_URL/rooms/demo-room"
curl -fsS "$CONTROL_PLANE_PUBLIC_URL"
```

Production preflight blocks startup when it detects missing required variables, public `http://` / `ws://` URLs, wildcard CORS, dev-role query mode, placeholder secrets, weak secrets, duplicate secret values, invalid LiveKit public IP/ports, or a `LIVEKIT_URL` host that does not match `VRATA_LIVEKIT_DOMAIN`. Diagnostics include variable names and reason codes only; secret values must not be printed.

## LiveKit / TURN Network Profile

The production compose profile runs LiveKit from an explicit `LIVEKIT_CONFIG` body instead of `--dev`. Caddy terminates HTTPS for the signaling endpoint at `LIVEKIT_URL`, for example `wss://livekit.example.com`, and forwards it to `livekit:7880`.

Open these inbound ports on the host or cloud firewall:

- `80/tcp` and `443/tcp` for Caddy ACME and HTTPS application traffic.
- `VRATA_LIVEKIT_TCP_PORT/tcp`, default `7881/tcp`, for WebRTC ICE/TCP fallback.
- `VRATA_LIVEKIT_UDP_PORT/udp`, default `7882/udp`, for direct UDP media.
- `LIVEKIT_TURN_TLS_PORT/tcp`, default `5349/tcp`, only when `LIVEKIT_TURN_ENABLED=true`.
- `LIVEKIT_TURN_UDP_PORT/udp`, default `3478/udp`, only when `LIVEKIT_TURN_ENABLED=true`.
- `LIVEKIT_TURN_RELAY_RANGE_START-LIVEKIT_TURN_RELAY_RANGE_END/udp`, default `50000-50100/udp`, only when `LIVEKIT_TURN_ENABLED=true` and your firewall requires an explicit relay range.

DNS requirements:

- `VRATA_APP_DOMAIN` points to the public host.
- `VRATA_STATE_DOMAIN` points to the same host unless room-state is split out.
- `VRATA_LIVEKIT_DOMAIN` points to the same host or the LiveKit host and must match `LIVEKIT_URL`.
- `LIVEKIT_TURN_DOMAIN` should be a separate hostname when TURN/TLS is enabled.

TURN/TLS options:

- Leave `LIVEKIT_TURN_ENABLED=false` for a public signaling-only profile.
- Set `LIVEKIT_TURN_ENABLED=true` to advertise LiveKit embedded TURN.
- With `LIVEKIT_TURN_EXTERNAL_TLS=true`, terminate TURN/TLS at an external layer-4 load balancer and forward to `LIVEKIT_TURN_TLS_PORT`.
- With `LIVEKIT_TURN_EXTERNAL_TLS=false`, provide `LIVEKIT_TURN_CERT_FILE` and `LIVEKIT_TURN_KEY_FILE` inside the LiveKit container through a compose override or host mount.
- Do not reuse `VRATA_LIVEKIT_DOMAIN` as `LIVEKIT_TURN_DOMAIN`; production preflight rejects this to keep signaling and TURN/TLS routing explicit.

The API `/health` and `/health/ready` payloads expose non-secret LiveKit diagnostics under `dependencies.livekitConfig`: signaling TLS status, configured host, TURN enabled flag, TURN domain, TURN ports, and relay range. `POST /api/tokens/media` and `POST /api/tokens/remote-browser-media` return `livekit_config_invalid` in production if LiveKit URL/key/secret are missing, insecure, or still using dev credentials.

Rollback for this profile is metadata/config-only: restore the previous `.env.production` and image tag through `pnpm rollback:compose`, then smoke the app URL. If the production profile itself is the problem, stop it and return to the previously used documented compose file. This task does not introduce point-in-time database recovery.
