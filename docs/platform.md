# Noah Platform Beta Scope

Noah `0.1` is a public beta target for a self-hosted immersive room platform. It is intended for evaluation, demos, and early adopters who can tolerate `0.x` changes.

## What “Platform” Means In `0.1`

- A user can deploy Noah on a single host with Docker Compose.
- A user can configure public endpoints, secrets, Postgres, LiveKit, and MinIO/S3-compatible storage.
- A user can create rooms/spaces through the documented API/control-plane path.
- A user can bind a scene bundle to a room.
- A user can update between releases using documented backup, smoke, and rollback steps.

## Stable Enough For `0.1`

- Runtime room boot from room manifests.
- Scene bundle manifest schema `1`.
- Basic room access and realtime presence.
- Docker Compose self-host shape.
- SemVer release tags and image tags after `v0.1.0`.

## Beta / Subject To Change

- Control-plane UX and admin flows.
- Internal API shapes not documented in `docs/api-contracts.md`.
- Database schema management before a dedicated migration system exists.
- Scene authoring pipeline and validation thresholds.
- Remote browser and advanced media surface behavior.

## Not Included In `0.1`

- Production SLA.
- Managed cloud offering.
- Kubernetes or multi-region reference architecture.
- Full world editor.
- Marketplace for scenes/assets.
- Stable plugin API.

## Public Release Gate

Do not publish `v0.1.0` until:

- secret scan is complete;
- code is licensed under Apache-2.0;
- asset licensing is approved;
- non-cleared private/proprietary scene bundles are moved to a private scene-assets repository and excluded from public release artifacts;
- self-host compose has been tested from a clean clone;
- release images are published from a SemVer tag;
- upgrade and rollback rehearsal has passed.
