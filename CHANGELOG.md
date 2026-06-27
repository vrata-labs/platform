# Changelog

All notable changes for public Vrata releases will be documented in this file.

Vrata uses SemVer: `MAJOR.MINOR.PATCH`. Until `1.0.0`, breaking changes can happen in minor versions, but they must be called out in release notes and upgrade docs.

## Unreleased

### Added

- Public open source readiness plan.
- Initial public repository hygiene docs and self-hosting contract.
- Apache-2.0 source code license.
- Signed room session tokens for runtime, room-state, media token issuing, diagnostics, XR telemetry, and remote-browser frame token issuing.
- Deny-by-default control-plane AuthN/AuthZ with explicit permissions and structured audit logging.
- Observability baseline with request IDs, live/ready health endpoints, metrics endpoints, runtime report IDs, and diagnostics redaction.
- Compose backup/restore/rollback automation with checksum manifests, restore smoke checks, and retention pruning.
- Runtime HUD scene attribution block for scene bundle credits.

### Known Limitations

- Asset license audit is still pending.
- Public GHCR release images are not published yet.
- `v0.1.0` is not tagged yet.

## 0.1.0 - Planned

### Added

- First public beta self-host release.
- Docker Compose self-host path.
- GHCR images tagged by SemVer and git SHA.
- Documented backup, upgrade, smoke, and rollback flow.
