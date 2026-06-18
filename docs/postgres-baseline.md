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
- `rooms`
- `assets`
- `runtime_diagnostics`

## Notes

- The API seeds `demo-tenant`, baseline templates, and `demo-room` on first boot.
- This is a baseline persistence layer, not a full migration framework yet.
