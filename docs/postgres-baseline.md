# Postgres Baseline

## Scope

`apps/api` now supports persistent storage for:

- tenants
- templates
- rooms
- assets
- runtime diagnostics

Presence remains ephemeral and in-memory for now because it is realtime session state rather than control-plane data.

## Activation

- If `POSTGRES_URL` is unset, API uses in-memory storage.
- If `POSTGRES_URL` is set, API initializes Postgres tables automatically on boot.

## Tables

- `tenants`
- `templates`
- `template_versions`
- `rooms`
- `assets`
- `runtime_diagnostics`

## Notes

- The API seeds `demo-tenant`, baseline templates, and `demo-room` on first boot.
- A clean catalog contains only the four platform template IDs. During the Wave 1 migration, an additional template ID is versioned only when that row already exists in `templates`; this preserves rooms created by the old API without making new database-only IDs available by default.
- Existing database-only rows with null metadata are repaired to `active@0.1.0`. Deprecated rows remain listed in Wave 1. Any other non-null status is rejected as `unsupported_template_status:<templateId>:<status>` instead of being treated as active.
- Every stored template version is shape-, identity-, and SHA-256-validated during startup and again when read. The update/delete rejection trigger function is created in the same schema as `template_versions`, so a dedicated application schema does not require `CREATE` on `public`.
- This is a baseline persistence layer, not a full migration framework yet.

## Template rollback boundary

Wave 1 remains compatible with a pre-Wave 1 API image only while room template versions are null or `0.1.0` and template switches stay between the four baseline template IDs. The old update shape changes only `template_id`; the composite foreign key remains valid because every baseline ID has version `0.1.0`.

Before introducing any template version newer than `0.1.0`, operations must remove the pre-Wave 1 image from the rollback targets. A room pinned to a newer version cannot be switched by that image to a template without the same version, and Wave 1 intentionally adds no compatibility workaround for that future case.
