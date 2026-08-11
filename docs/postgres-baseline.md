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
- Existing database-only rows with null version metadata are repaired to `active@0.1.0`. Rows that already have a current version keep that exact version; startup fails rather than inventing a historical `0.1.0` row when the referenced version is missing.
- Deprecated rows and their historical versions remain readable by existing rooms, but are omitted from the default catalog and rejected for room creation. Any other non-null status is rejected as `unsupported_template_status:<templateId>:<status>` instead of being treated as active.
- Every stored template version is shape-, identity-, and SHA-256-validated during startup and again when read. The update/delete rejection trigger function is created in the same schema as `template_versions`, so a dedicated application schema does not require `CREATE` on `public`.
- This is a baseline persistence layer, not a full migration framework yet.

## Template rollback boundary

Wave 1 remains compatible with a pre-Wave 1 API image only while room template versions are null or `0.1.0` and template switches stay between the four baseline template IDs. The rollback-guard image no longer changes a room's template binding and writes explicit metadata when seeding `demo-room`, so it can boot after the compatibility columns become non-null.

Before introducing any template version newer than `0.1.0`, operations must pin the rollback-guard image as the minimum rollback target and remove earlier Wave 1 and pre-Wave 1 images. Earlier images can invent a `0.1.0` child for a newer database-only parent, switch a pinned room's template binding, or fail while seeding `demo-room` after the compatibility metadata becomes non-null.
