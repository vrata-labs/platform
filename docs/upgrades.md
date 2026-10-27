# Upgrades And Rollback

This document describes the target upgrade policy for Vrata `0.1` self-host deployments.

## Policy

- Upgrade using explicit SemVer image tags, for example `0.1.1`.
- Do not use `latest` as the upgrade target.
- Back up Postgres and object storage before every minor upgrade.
- Downgrading database schema is not guaranteed.
- Rollback means returning to the previous app image tag without deleting volumes.

## Moving From Bundled MinIO To SeaweedFS

Current compose files run SeaweedFS in the `minio` service and keep objects in the new `storage-data` volume; the old `minio-data` volume is left untouched and no longer mounted. Endpoint, region and bucket names stay the same, so a backup taken before the upgrade restores into the new storage:

1. On the old release, stop writes and run `pnpm backup:compose` and `pnpm backup:validate` as below. Its `minio-bootstrap` service must still have its `mc` image locally: the upstream MinIO images can no longer be pulled.
2. Upgrade the checkout and env, then start the new stack. Bootstrap creates both buckets in the empty storage.
3. Run `pnpm restore:compose` with that backup (see `docs/backup-restore.md`), then check rooms, scene bundles, documents and room plugins.
4. Remove the `minio-data` volume only after the restored deployment is verified.

Rolling back across this switch by image tag is not supported: an older checkout starts MinIO, whose images can no longer be pulled, on the old `minio-data` volume without the objects written since. Restore the pre-upgrade backup on the old release instead.

## Backup Before Upgrade

Create and validate a compose backup before changing image tags:

```bash
pnpm backup:compose -- --env-file infra/docker/.env.selfhost --compose-file infra/docker/compose.selfhost.yml --output-dir backups
pnpm backup:validate -- --backup-dir backups/vrata-<timestamp>-<image-tag>
```

The backup command exports Postgres, MinIO bucket objects, object inventory, bucket policy metadata when available, image metadata, and a checksum manifest. See `docs/backup-restore.md` for restore and disaster recovery details.

## Upgrade

Edit `infra/docker/.env.selfhost`:

```text
IMAGE_TAG=0.1.1
```

Then run:

```bash
docker compose --env-file infra/docker/.env.selfhost -f infra/docker/compose.selfhost.yml pull
docker compose --env-file infra/docker/.env.selfhost -f infra/docker/compose.selfhost.yml up -d
```

Smoke checks:

```bash
curl -fsS "$VRATA_APP_BASE_URL/health"
curl -fsS "$VRATA_APP_BASE_URL/rooms/demo-room"
curl -fsS "$VRATA_APP_BASE_URL/control-plane"
```

An upgrade never raises the room identity floor. Activating identity v2 (and the optional media boundaries) is a separate irreversible step that also restricts later rollback targets; see [Room Identity v2 Activation](self-hosting.md#room-identity-v2-activation).

## Rollback

If smoke fails, set `IMAGE_TAG` back to the previous known-good tag and restart:

```bash
pnpm rollback:compose -- \
  --previous-image-tag 0.1.0 \
  --env-file infra/docker/.env.selfhost \
  --compose-file infra/docker/compose.selfhost.yml \
  --smoke-base-url "$VRATA_APP_BASE_URL" \
  --confirm-rollback
```

Do not run `down -v` during rollback unless you intentionally want to delete data.

## Migration Status

Current schema setup is bootstrap-oriented and uses idempotent table/column creation in the API storage layer. A dedicated migration runner is a planned requirement before Vrata can claim stronger production upgrade guarantees.
