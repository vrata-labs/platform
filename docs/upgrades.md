# Upgrades And Rollback

This document describes the target upgrade policy for Vrata `0.1` self-host deployments.

## Policy

- Upgrade using explicit SemVer image tags, for example `0.1.1`.
- Do not use `latest` as the upgrade target.
- Back up Postgres and MinIO before every minor upgrade.
- Downgrading database schema is not guaranteed.
- Rollback means returning to the previous app image tag without deleting volumes.

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
