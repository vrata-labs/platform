# Backup, Restore, And Rollback

Vrata self-host and production compose profiles use named Docker volumes for persistent state. `tools/backup-restore.mjs` provides the operator path for exporting that state, validating backup artifacts, restoring it, rolling back image tags without deleting volumes, and running smoke checks.

## What Is Backed Up

- Postgres: a `pg_dump --clean --if-exists --no-owner --no-privileges` SQL dump.
- Compose MinIO public storage: mirrored MINIO_BUCKET objects, inventory and download policy metadata when available.
- Private room-plugin storage: a separate ROOM_PLUGIN_BUCKET export, inventory and mandatory anonymous-none policy capture. Every private file, including inventory and policy, participates in the manifest's size/SHA-256 checks.
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

Private storage configuration comes from the resolved Compose API environment, including forwarded defaults, rather than assuming that every env-file variable reaches the API. The supported private provider is minio-default, accessed by the compose minio-bootstrap client with matching API credentials. An external s3-compatible provider or local plugin filesystem is not captured by this tool. A configured unsupported private provider, or plugin rows without captured private storage, fails backup rather than producing a successful incomplete archive.

Stop package writes/deletions for a consistent recovery point. The tool examines room_plugin_packages COPY rows from the exact SQL dump and requires each non-deleted row's backend fingerprint to match the captured namespace. Each ready row must have byte-exact exported content matching its SQL hash and length. Reserved uploads and cleanup-pending deletions may legitimately have no object; their backend must still be covered. A missing bucket, incomplete/failed inventory, unsafe key or anonymous policy other than none also fails backup. Backup does not create missing buckets or repair their policies.

## Validate A Backup

```bash
pnpm backup:validate -- --backup-dir backups/vrata-<timestamp>-<image-tag>
```

Validation checks:

- manifest schema and required source metadata;
- artifact paths cannot escape the backup directory;
- required Postgres and MinIO inventory artifacts exist;
- artifact sizes and SHA-256 checksums match the manifest.
- private inventory and the complete exported private file tree agree, without unmanifested files or symlinks;
- plugin metadata refers to the captured backend, and ready objects match SQL content hashes;
- the captured private policy has no statements granting anonymous access.

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

The Postgres preparation, dump and any schema reinstatement execute in a single psql transaction with startup scripts disabled and ON_ERROR_STOP enabled. A SQL error rolls back all database DDL/data changes, including preparation. This is database atomicity, not an atomic transaction across Postgres and object storage. Restore accepts operator-selected pg_dump SQL archives; it rejects transaction-control escapes, psql include/shell commands and COPY PROGRAM. It never treats dump contents as Node or shell code.

The standalone inspectRestoreDump(filePath) helper tokenizes the supported pg_dump profile, not arbitrary PostgreSQL/PLSQL. Backup requests UTF8 from pg_dump and checks its output before exporting objects or writing a success manifest. Restore decodes the entire SQL stream with fatal UTF-8 validation (including COPY data), pins client_encoding=UTF8 and standard_conforming_strings=on at psql connection startup and in the transaction, and refuses encoding switches/reset/default forms. Canonical UTF8 assignments and SET NAMES UTF8 are supported. Invalid, overlong, truncated or surrogate UTF-8 encodings fail rather than being replaced with a different character.

Identifiers use PostgreSQL's UTF-8 scan character classes: ASCII letters/underscore or non-ASCII characters start identifiers; digits and dollar signs additionally continue them. NBSP is identifier content, not SQL whitespace. Only ASCII case is folded. E-string recognition requires a whole ASCII E identifier at a real token boundary; unsupported numeric/identifier adjacency fails before execution. Plain single-quoted strings and double-quoted identifiers use doubled quotes only; backslashes escape characters only inside E-strings. Dollar-quoted bodies, nested block comments and COPY rows are tracked separately.

COPY has a positive token-kind grammar: COPY table-name [(column-name [, column-name ...])] FROM STDIN, followed by the semicolon and an otherwise whitespace-only line remainder. Names are quoted/unquoted identifiers, optionally schema-qualified. The complete header must be consumed: quoted "stdin", file/program sources, TO, queries, WHERE, options and extra expressions/statements are unsupported. Only then are following lines treated as opaque COPY data. A one-backslash-dot line ends COPY; a two-backslash-dot row remains data.

Retained statement tokens are limited to 16,384 and identifier/dollar-tag lengths to 1,024 characters; only 256 literal-prefix characters are retained for control-statement matching. Longer scalar literals remain opaque and cannot masquerade as short accepted mode values. Function bodies/COPY rows are not accumulated into the token list. The line reader still buffers the current input line; this is bounded token retention, not a claim of a total-process or whole-dump size limit.

Only explicit on assignments to standard_conforming_strings are supported. Off/default/reset-all forms and alternate set_config calls fail before restore SQL; the fixed pg_dump search_path reset remains allowed. Unicode-escape quote forms and top-level newline continuation of E-strings are rejected as unsupported profile syntax. The latter has different server/psql framing behavior; pg_dump emits individual escaped literals or COPY data instead. Direct UTF-8 text, ordinary E-string escapes and dollar-quoted function bodies remain supported. These checks preserve transaction/program boundaries for the supported profile; they do not make arbitrary operator-supplied SQL a sandbox.

For private storage, restore additionally validates the target's provider, normalized endpoint, region, public/private bucket names and backend fingerprint **before changing SQL or objects**. It first restores the private bucket, applies anonymous none before any upload, then performs credentialed reads of the complete restored object set and compares byte lengths/SHA-256 with the archive. The private policy must still be none. Only after these checks does it apply SQL and restore the public bucket using the existing download policy. A private bucket never enters the public restore command.

### Archive Compatibility And Backend Identity

Archives without private storage retain schemaVersion 1 and the existing minio/ layout. They can still validate/restore without ROOM_PLUGIN_BUCKET configured, and do not replace any private bucket on the target. A schema-1 archive containing plugin package rows is rejected: its SQL alone is not a complete plugin backup.

For a pre-T04 archive restored onto a newer database, a read-only catalog preflight must find either no plugin tables or all three known ordinary tables: room_plugin_bindings, room_plugin_packages and room_plugin_state. In the upgraded case all three must be completely empty, including reserved/unsettled upload metadata and deletion state. Partial plugin schemas, unknown extra public relations, an external/mismatched API database, nonempty plugin tables or an unavailable current schema installer stop restore before DDL or bucket policy/object changes. A legacy archive is not a recovery point for a target with live plugin packages.

When the three empty tables are absent from the archive, restore locks them, rechecks emptiness and drops only those tables without CASCADE. After the legacy dump, it reinstates plugin schema using the current API image's fixed compiled installRoomPluginSchema module with a recording executor. Preparation, dump and the recorded installer SQL share the same transaction. A local public search_path is restored before the installer because pg_dump clears it. The running current API container must provide that module; no backup-supplied module or generic extra-table migration is executed.

Archives capturing private storage use schemaVersion 2. Public artifacts retain their existing paths. Additional artifacts live in room-plugins/objects/, room-plugins/objects.jsonl and room-plugins/bucket-policy.json; roomPlugins records the credential-free provider/locator, fingerprint, anonymousPolicy and metadataCount. Missing or inconsistent v2 fields fail validation.

Credential rotation and public URL changes do not change the plugin fingerprint. Changing endpoint, region or private bucket requires an explicit migration; restore does not rewrite immutable package fingerprints or redirect metadata to a new locator. Recovery into a fresh isolated MinIO data directory behind the **same locator** is supported. Neither the API fingerprint nor this tool proves continuity of a physical volume/bucket: no physical backend-ID policy is introduced here. The operator must select the correct recovery target and stop concurrent writes.

### Backup Regression Checks

```sh
node --test tools/backup-restore.test.mjs
node --test tools/backup-restore-legacy.postgres.test.mjs
```

The default suite uses temporary file trees and injected Compose operations. An optional real Postgres/MinIO backup-to-fresh-target check accepts a sealed JSON fixture file through VRATA_TEST_BACKUP_FIXTURE_JSON. Its contract is:

- fixtureOnly: true; fixtureRoot: an absolute disposable directory under /tmp/opencode/;
- source and target: objects containing envFile and composeFile paths under fixtureRoot; target also supplies smokeBaseUrl;
- both pre-provisioned Compose projects are named vrata-backup-fixture-*, have no external/shared volumes or bind mounts outside fixtureRoot, and use API MINIO_ENDPOINT=http://minio:9000;
- source already contains room-plugin package metadata plus private bytes; target is disposable and uses the same bucket locator (a different data directory is permitted);
- privateAnonymousUrl, privateSignedReadUrl and publicSceneUrl are loopback target URLs; privateSignedReadUrl is a valid presigned GET;
- privateSha256 and publicSceneSha256 are the expected content hashes.

Keep the fixture JSON/env files private (mode 0600). The test does not print their contents or signed URLs, provision infrastructure or delete volumes. It checks restored signed bytes, anonymous HTTP 403 and public scene HTTP 200, then removes only its temporary backup output.

The real legacy regression accepts VRATA_TEST_BACKUP_LEGACY_FIXTURE_JSON with fixtureOnly, fixtureRoot, target and legacyBackupDir. It uses the same disposable/loopback/Compose ownership contract, requires an actual schema-1 archive from baseline 81c14b6ac8dbc537892f7b1f342ca8f718fdf0a6 and an initially empty T04 plugin schema. The disposable source additionally supplies public."заметки_lexer" (id integer primary key, body text), with id=1 and body="Привет 👋 ぃ\\ Unicode notes and backslashes\\", to verify a real UTF8/backslash pg_dump roundtrip. Native PostgreSQL/psql probes establish literal/COPY interpretation and demonstrate file-COPY/WHERE, UTF8/NBSP identifiers, SJIS bytes, backslash COMMIT and shell payloads using session-local temporary objects and fixed harmless commands. For encoding changes the native oracle sends SET before the next query, matching psql's statement dispatch rather than parsing the entire script upfront in one pg query. Checksum-valid archives containing those payloads must be rejected before DDL. Valid literal SQL is also exercised with off/SJIS connection defaults and an injected failure; all public data and schema/index OIDs/definitions must roll back exactly.

The same regression inserts a real unsettled package reservation after the read-only empty preflight but before restore locks. The locked DO recheck must reject it with the row and private policy unchanged. Only the fixture creator settles/deletes that owned reservation, knowing it never started PUT. The test then restores successfully, verifies current API create/read and private package storage, and proves a nonempty target is rejected without metadata/policy changes. Proof booleans are retained in sql-parser-proof.json. Only the test's own temporary failure archive is removed; the fixture owner tears down the disposable projects.

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
- The scripts target the compose-managed Postgres and MinIO profiles, not arbitrary S3 providers. External managed databases or object stores need provider-specific snapshots; uncaptured room-plugin storage cannot be silently skipped.
