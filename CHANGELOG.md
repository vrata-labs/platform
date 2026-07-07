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
- Public connectivity diagnostics page with stable API/WSS/microphone/LiveKit/storage codes and a redacted JSON report for GitHub issues.
- Compose backup/restore/rollback automation with checksum manifests, restore smoke checks, and retention pruning.
- Private room access mode with public/unlisted/private visibility, expiring/revokable invite links, waiting-room approvals, access-denied UX, metrics, and audit entries for invite create/revoke/use.
- Host controls for small meetings with trusted host/admin lock, unlock, participant removal, host transfer, session end, runtime HUD states, metrics, and audit entries.
- Runtime HUD scene attribution block for scene bundle credits.
- Scene bundle validator CLI via `vrata scenes validate <path>` with JSON output and shared server-side scene bundle reference validation.
- Control-plane scene bundle zip upload with server-side validation, MinIO/S3-compatible publishing, metadata registration, preview display, and room binding.
- Control-plane room creation now supports operator-friendly slugs, pre-publish preview, selected scene bundle binding, private-room invite generation, duplicate slug validation, copy room URL, and creation metrics.
- Runtime guest onboarding for external invite links with display name entry, join-muted preference, microphone check, without-audio entry, compatibility warnings, controls hints, and clearer expired/revoked invite messages.
- Control-plane admin dashboard now verifies admin sessions, shows room status and bound scene bundle labels, supports invite management and room disable/enable lifecycle, and blocks disabled-room runtime access with `room_disabled`.
- Persistent runtime notes panel with room/private scopes, autosave/retry states, sanitized Markdown preview, notes API persistence, permissions, metrics, and audit events.

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
