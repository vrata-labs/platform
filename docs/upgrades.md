# Upgrades And Rollback

This document describes the target upgrade policy for Noah `0.1` self-host deployments.

## Policy

- Upgrade using explicit SemVer image tags, for example `0.1.1`.
- Do not use `latest` as the upgrade target.
- Back up Postgres and MinIO before every minor upgrade.
- Downgrading database schema is not guaranteed.
- Rollback means returning to the previous app image tag without deleting volumes.

## Backup Before Upgrade

Example Postgres dump from the compose stack:

```bash
set -a
. infra/docker/.env.selfhost
set +a
docker compose --env-file infra/docker/.env.selfhost -f infra/docker/compose.selfhost.yml exec -T postgres pg_dump -U "$POSTGRES_USER" "$POSTGRES_DB" > noah-postgres-backup.sql
```

Back up MinIO data according to your storage backend. For local Docker volumes, snapshot the `minio-data` volume or copy the objects with an S3-compatible client.

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
curl -fsS "$NOAH_APP_BASE_URL/health"
curl -fsS "$NOAH_APP_BASE_URL/rooms/demo-room"
curl -fsS "$NOAH_APP_BASE_URL/control-plane"
```

## Rollback

If smoke fails, set `IMAGE_TAG` back to the previous known-good tag and restart:

```bash
docker compose --env-file infra/docker/.env.selfhost -f infra/docker/compose.selfhost.yml up -d
```

Do not run `down -v` during rollback unless you intentionally want to delete data.

## Migration Status

Current schema setup is bootstrap-oriented and uses idempotent table/column creation in the API storage layer. A dedicated migration runner is a planned requirement before Noah can claim stronger production upgrade guarantees.
