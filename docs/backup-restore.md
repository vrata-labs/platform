# Backup, Restore, And Rollback

Vrata self-host and production compose profiles use named Docker volumes for persistent state. `tools/backup-restore.mjs` provides the operator path for exporting that state, validating backup artifacts, restoring it, rolling back image tags without deleting volumes, and running smoke checks.

## What Is Backed Up

- Postgres: a `pg_dump --clean --if-exists --no-owner --no-privileges` SQL dump.
- MinIO/S3-compatible compose storage: mirrored bucket objects, an object inventory file, and bucket download policy metadata when available.
- Platform metadata: manifest schema version, created timestamp, Vrata package version, `IMAGE_TAG`, git commit, compose profile, compose/env file names, artifact sizes, and SHA-256 checksums.
- Compose image snapshot: `docker compose images` output for operator diagnostics.

Backups are written under `backups/` by default. That directory is ignored by git because backup artifacts can contain private room metadata and scene assets.

## Create A Backup

From the repository root:

```bash
pnpm backup:compose -- --env-file infra/docker/.env.selfhost --compose-file infra/docker/compose.selfhost.yml --output-dir backups
```

For the production-safe profile, use `infra/docker/.env.production` and `infra/docker/compose.production.yml`.

The command fails non-zero if Postgres dump, MinIO mirror, image snapshot, or manifest writing fails. Logs print paths and stable failure codes only; secret values from the env file are redacted from command stderr.

## Validate A Backup

```bash
pnpm backup:validate -- --backup-dir backups/vrata-<timestamp>-<image-tag>
```

Validation checks:

- manifest schema and required source metadata;
- artifact paths cannot escape the backup directory;
- required Postgres and MinIO inventory artifacts exist;
- artifact sizes and SHA-256 checksums match the manifest.

Corrupt or incomplete manifests fail non-zero before restore starts.

## Restore

Restore is destructive for the target deployment state: it applies the SQL dump to Postgres and mirrors the backed-up object set back into MinIO with `--remove`.

Do not run restore against a production host unless you have explicitly chosen that backup as the recovery point.

```bash
pnpm restore:compose -- \
  --backup-dir backups/vrata-<timestamp>-<image-tag> \
  --env-file infra/docker/.env.selfhost \
  --compose-file infra/docker/compose.selfhost.yml \
  --smoke-base-url http://127.0.0.1:4000 \
  --smoke-room-id demo-room \
  --confirm-restore
```

Restore always validates the manifest first. After applying the dump and objects, it runs smoke checks against `/health`, `/rooms/:roomId`, `/api/rooms/:roomId/manifest`, and the manifest scene bundle URL when one is present.

## Rollback Image Tag

Rollback is config/image-only. It validates the target tag and smoke URL before editing the env file, updates `IMAGE_TAG`, pulls app service images, and runs `docker compose up -d --no-build`. It does not run `docker compose down -v`, and it does not delete Postgres or MinIO volumes.

```bash
pnpm rollback:compose -- \
  --previous-image-tag 0.1.0 \
  --env-file infra/docker/.env.selfhost \
  --compose-file infra/docker/compose.selfhost.yml \
  --smoke-base-url http://127.0.0.1:4000 \
  --smoke-room-id demo-room \
  --confirm-rollback
```

The previous env file is copied to `backups/rollback-env/` before `IMAGE_TAG` is changed. `latest` is rejected as a rollback target; use an explicit SemVer or immutable SHA tag.

## Smoke Only

```bash
pnpm smoke:compose -- --smoke-base-url http://127.0.0.1:4000 --smoke-room-id demo-room
```

Use this after manual recovery steps or storage maintenance.

## Retention

Dry-run old backup deletion:

```bash
pnpm backup:prune -- --output-dir backups --retention-days 14
```

Apply deletion:

```bash
pnpm backup:prune -- --output-dir backups --retention-days 14 --confirm-prune
```

`VRATA_BACKUP_RETENTION_DAYS` can provide the default retention window. The prune command only considers directories whose names start with `vrata-`.

## Disaster Path

1. Stop writes to the affected deployment if possible.
2. Pick the newest verified backup whose manifest passes `pnpm backup:validate`.
3. Restore with `--confirm-restore` and a reachable `--smoke-base-url`.
4. If the app image is the problem rather than data, use `pnpm rollback:compose` with the previous explicit image tag.
5. Run the smoke command and record the backup directory, restored `IMAGE_TAG`, git commit, and smoke result in the incident notes.

## Limitations

- Point-in-time recovery and incremental object backups are out of scope for `0.1`.
- Downgrading database schema is not guaranteed. Backups are mandatory before minor upgrades.
- The scripts target the compose-managed Postgres and MinIO profiles. External managed databases or object stores need provider-specific snapshots in addition to this runbook.
