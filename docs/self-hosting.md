# Self-Hosting

This document describes the target self-host path for Vrata `0.1` beta.

For pinned same-origin sandbox assets, plugin/document restart/restore checks and retryable room cleanup, see [Storage lifecycle](plugin-storage-lifecycle.md).

Until `v0.1.0` is released, public GHCR images may not exist. From a source checkout, use `--build` to build images locally.

## Requirements

- Docker with Compose v2.
- A Linux host or local Docker environment.
- Ports for app, room-state and LiveKit; the bundled S3 storage listens on `127.0.0.1` only. The remote-browser executor remains private to the compose network; Caddy exposes only its token-protected `/frames` WebSocket.
- For public HTTPS deployment: domains or test hostnames for app/state/livekit/browser endpoints.

## Source-Build Quickstart

For a disposable loopback-only four-person meeting with correctly configured local LiveKit, pinned reference template activation, PDF and notes, see [`docs/demo/README.md`](demo/README.md). It uses an overlay and generated credentials instead of the example `--dev` LiveKit stack below.

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
- `REMOTE_BROWSER_INTERNAL_TOKEN`: use a separate strong secret for the experimental executor boundary.
- `POSTGRES_PASSWORD`: replace with a strong password.
- `MINIO_ROOT_USER` and `MINIO_ROOT_PASSWORD`: replace with production values. They are the S3 key of the bundled storage: printable ASCII without double quotes or backslashes, at least 3 and 8 characters long.
- `VRATA_APP_BASE_URL`, `ROOM_STATE_PUBLIC_URL`, `LIVEKIT_URL`, and `REMOTE_BROWSER_PUBLIC_URL`: set to the URLs that browsers can reach.
- `LIVEKIT_NODE_IP`: set to the public IP address advertised by the LiveKit node. Production preflight rejects loopback, private, reserved, and placeholder values.
- `VRATA_LIVEKIT_TCP_PORT` and `VRATA_LIVEKIT_UDP_PORT`: open these directly on the host for LiveKit WebRTC ICE/TCP fallback and UDP media traffic.

The bundled compose file runs LiveKit in `--dev` mode for the `0.1` beta quickstart, so the local defaults are `LIVEKIT_API_KEY=devkey` and `LIVEKIT_API_SECRET=secret`. Replace this with a hardened LiveKit configuration before exposing a deployment beyond evaluation use.

Remote browser is experimental and defaults to `REMOTE_BROWSER_ENABLED=false`. To opt in, set a narrow `REMOTE_BROWSER_ALLOWED_ORIGINS` list and review `REMOTE_BROWSER_MAX_SESSIONS`, `REMOTE_BROWSER_SESSION_TTL_SECONDS`, `REMOTE_BROWSER_CPU_LIMIT`, `REMOTE_BROWSER_MEMORY_LIMIT`, and `REMOTE_BROWSER_PIDS_LIMIT`. Do not expose the executor port directly to untrusted networks.

## Bundled Object Storage

The compose service `minio` runs [SeaweedFS](https://github.com/seaweedfs/seaweedfs) (Apache-2.0) with its S3 gateway on port 9000, pinned by image digest. MinIO community was archived with unpatched advisories and its images are no longer published, so it is not used any more. The service name, the port, the `MINIO_*` variables and the `minio-default` provider are kept for compatibility: the API endpoint and the room-plugin storage fingerprint stay `http://minio:9000`.

- `infra/docker/storage-server.sh` starts the server with one S3 identity, `MINIO_ROOT_USER`/`MINIO_ROOT_PASSWORD`. The API and the bootstrap share it, so the API key can also manage buckets and policies.
- `minio-bootstrap` and the backup tool use the `mc` client from `pgsty/mc` (the maintained multi-arch build of the pgsty MinIO fork, AGPL-3.0, pinned by digest): upstream MinIO no longer publishes client images. Bootstrap creates the public `MINIO_BUCKET` with an anonymous download policy and the private `ROOM_PLUGIN_BUCKET` without any policy, retrying for about a minute while the storage warms up.
- Master, volume and filer listen on loopback inside the container; other containers reach only the S3 API and its gRPC port. Self-host publishes the S3 port on `127.0.0.1` for `MINIO_PUBLIC_BASE_URL=http://127.0.0.1:9000`; production and staging publish public objects through Caddy, which passes only `GET`/`HEAD` (and CORS `OPTIONS`) of non-empty keys in the public bucket without a query and refuses the `documents/` prefix.
- For about half a minute after a start the storage refuses writes (its filer lock is not ready yet); conditional writes stay atomic, refused requests are retried by the client.

## Room Document Storage

Room documents (PDF, images, video) are stored in the private `ROOM_PLUGIN_BUCKET` under `documents/<tenant>/<room>/<document>/<file>` and are released only by the API, after the room access checks, from signed reads. The public `MINIO_BUCKET` (or `SCENE_BUNDLE_S3_BUCKET`) holds scene bundles only. For the `s3-compatible` provider the operator creates `ROOM_PLUGIN_BUCKET` without anonymous access before uploading documents (see `infra/docker/room-plugin-storage.md`); without it uploads and reads answer `document_storage_unavailable`.

Releases before this change wrote documents to the public bucket. While such objects remain, the API reads them with signed requests when the private object is missing and counts these reads in `vrata_document_legacy_reads_total`. After upgrading, move them and delete the public copies from the API container:

```sh
docker compose --env-file infra/docker/.env.production -f infra/docker/compose.production.yml exec -T -w /app api node apps/api/dist/document-storage-move.js
docker compose --env-file infra/docker/.env.production -f infra/docker/compose.production.yml exec -T -w /app api node apps/api/dist/document-storage-move.js --confirm
```

The first command only counts. `--confirm` copies each live document after checking its recorded checksum, deletes the public copy after a signed read of the private copy matches, deletes copies of deleted documents and objects of deleted rooms, lists the public prefix again and checks with a fixture object that documents are not served anonymously. Objects without a row younger than 15 minutes are kept for the next run (a writer of the previous release may not have committed its row yet). The output is counts only; a non-zero exit names a checksum mismatch, a conflicting private object or a failed operation, which leave the public copy for the operator. `--verify` runs only the privacy check. The check fetches the public storage address from inside the API container; where `MINIO_PUBLIC_BASE_URL` is a loopback address of the host (the self-host default), it fails until `ROOM_PLUGIN_ANONYMOUS_ENDPOINT` names an address reachable from the container, as for the room plugin probe. Caddy refuses only the default `documents/` prefix; if the API runs with another `MINIO_DOCUMENT_PREFIX`, refuse that prefix of the public bucket in the proxy until the move reports nothing remaining. In local development without object storage, documents live in `apps/.room-document-objects` (or `DOCUMENT_LOCAL_UPLOAD_ROOT`, which must lie outside every directory the API serves statically); the previous `apps/runtime-web/public/assets/uploaded-documents` is read-only legacy and is not served.

Rolling back to a release from before this change after the move leaves moved documents unreadable (`document_storage_unavailable`) until the upgrade is applied again; no data is lost.

## Persistent Data

The self-host compose file stores data in Docker volumes:

- `postgres-data` for room/control-plane data;
- `storage-data` for scene bundle, document and room-plugin objects;
- `caddy-data` and `caddy-config` for Caddy state.

Back up these volumes before upgrades. Use `pnpm backup:compose`, validate the produced manifest with `pnpm backup:validate`, and keep the artifacts outside git. See `docs/backup-restore.md` and `docs/upgrades.md`.

## Adding A Space

The minimal `0.1` flow is API-driven:

- prepare a scene bundle with `scene.json` and assets;
- upload it to the bundled or another S3-compatible storage;
- register scene bundle metadata through the API;
- bind the bundle to a room;
- open the room URL and verify diagnostics.

See `docs/scene-bundle-contract.md` for the bundle layout.

A deployment managed by a portal additionally sets `VRATA_PORTAL_MANAGED=true` and `VRATA_INTEGRATION_KEYS`; see [integration API](./integration-api.md). Without them the platform keeps self-hosted behavior, including rooms for unknown ids.

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
curl -fsS "$VRATA_APP_BASE_URL/diagnostics"
curl -fsS "$CONTROL_PLANE_PUBLIC_URL"
```

Production preflight blocks startup when it detects missing required variables, public `http://` / `ws://` URLs, wildcard CORS, dev-role query mode, placeholder secrets, weak secrets, duplicate secret values, invalid LiveKit public IP/ports, a `LIVEKIT_URL` host that does not match `VRATA_LIVEKIT_DOMAIN`, or a portal-managed deployment with ad-hoc rooms or without valid integration public keys. Diagnostics include variable names and reason codes only; secret values must not be printed.

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

The API `/health` and `/health/ready` payloads expose non-secret LiveKit deployment diagnostics under `dependencies.livekitConfig`: signaling TLS status, configured host, TURN enabled flag, TURN domain, TURN ports, and relay range. Runtime diagnostics posted to `POST /api/rooms/:roomId/diagnostics` include `media.webrtc` with transport states, selected ICE candidate pair state, candidate types, and TURN relay availability/use booleans. The runtime snapshot intentionally omits raw ICE candidate addresses and ports.

After public DNS/HTTPS is configured, open `$VRATA_APP_BASE_URL/diagnostics?roomId=demo-room&autorun=1` in a browser. Use `skipMic=1` when you need to avoid a microphone permission prompt but still want API, room-state WSS, storage, LiveKit, and WebRTC/TURN checks. Copy the JSON report into support issues; token-like query values and secret-like keys are redacted.

`POST /api/tokens/media` and `POST /api/tokens/remote-browser-media` return `livekit_config_invalid` in production if LiveKit URL/key/secret are missing, insecure, or still using dev credentials.

Rollback for this profile is metadata/config-only: restore the previous `.env.production` and image tag through `pnpm rollback:compose`, then smoke the app URL. If the production profile itself is the problem, stop it and return to the previously used documented compose file. This task does not introduce point-in-time database recovery.

## Room Identity v2 Activation

A new installation starts at identity floor 1: rooms accept the legacy protocol, in which the browser chooses its participant ID, and room plugins are unavailable. Floor 2 makes the server issue every participant ID and identity credential. Raising the floor is a separate operator step and cannot be undone.

Before activation:

- Run images that carry the identity v2 boundary: the `api` and `room-state` images have the label `io.vrata.identity-protocol-floor-guard=1` (check with `docker image inspect`).
- `STATE_TOKEN_SECRET` is at least 32 bytes and the same for `api` and `room-state` (the compose files pass one variable to both). Production preflight (`node tools/validate-production-config.mjs`) enforces the length; v2 sessions cannot be signed with a shorter secret.
- Take and validate a backup (`pnpm backup:compose`, `pnpm backup:validate`).

Run a dry run and then the activation inside the running API container, with the env and compose files of your deployment:

```bash
docker compose --env-file infra/docker/.env.production -f infra/docker/compose.production.yml exec -T -w /app api node apps/api/dist/identity/activate-v2.js --dry-run
docker compose --env-file infra/docker/.env.production -f infra/docker/compose.production.yml exec -T -w /app api node apps/api/dist/identity/activate-v2.js --confirm-irreversible
```

Each prints one JSON line. The dry run changes nothing and reports the current floor (`before`), room counts (`audit`: all, disabled, locked, ended and identity-bound rooms) and whether the secret is usable (`secretReady`). The activation refuses with `identity_activation_secret_too_short` before it connects to the database if the secret is too short; on success it prints `"after":2` and `"raised":true`, and a repeated run changes nothing (`"raised":false`). Saved lock, end and disable decisions are kept. `GET /health` then reports `features.identityProtocolVersion: 2`.

What people see:

- Open tabs stop with "Update required to rejoin this room". **Update and rejoin** reloads the page, and the new session receives a server-issued participant ID.
- A host or personal-room owner known only by a legacy participant ID gets the role back with an administrator recovery code: `POST /api/rooms/<roomId>/identity-recovery` with the `x-vrata-admin-token` header and `{"participantId": "<legacy participant ID>", "role": "host"}` (or `"owner"`). The code is returned once, is single-use and expires after ten minutes. Deliver it outside the app; the person enters it under **Recover room access** in the room and keeps the legacy participant ID.
- Room materials such as notes and documents are kept.

Two further media boundaries are optional, irreversible and require floor 2:

- Media codec 3: run `node apps/api/dist/identity/activate-media-codec.js` with `--dry-run` and then `--confirm-irreversible` in the same way. Codec-2 media grants are no longer issued and codec-2 media rooms are retired; open tabs lose their media connection once and join audio again. `GET /health` then reports `features.mediaIdentityCodec: 3`.
- Media namespace rotation, after a restore onto the same LiveKit server or for a clone: see [Media Namespace After Restore Or Clone](backup-restore.md#media-namespace-after-restore-or-clone).

After activation, roll back only to images that support every raised boundary. `pnpm rollback:compose` checks this before it changes anything: it requires an immutable 40-character SHA image tag and refuses images without the matching `io.vrata.*` labels (identity floor guard, frame-token codec, media identity codec, and the media codec boundary or namespace rotation once those were raised). See [Upgrades And Rollback](upgrades.md).
