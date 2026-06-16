# Open Source Safety Audit

This document tracks blockers before Noah can be published as a public open source repository.

## Current Status

- Status: blocked for public release.
- Last scan date: 2026-06-16.
- Scanner: `gitleaks`.
- Current-tree result: `gitleaks dir . --redact` found no leaks after sanitizing legacy host references.
- Git-history result: `gitleaks detect --redact` still reports `1` redacted historical finding that requires triage.

## Findings

### GL-2026-06-16-001

- Scanner rule: `generic-api-key`.
- File: `docs/staging-migration-2026-03-30.md`.
- Historical commit: `000940b2f9e0bb81548831c74a38e81d4072907a`.
- Current triage: likely false positive on a legacy `sslip.io` staging host string, not an API credential.
- Current-tree mitigation: current `docs/staging-migration-2026-03-30.md` host references were replaced with placeholders.
- Required before public release: confirm no credential is embedded in git history and decide whether a narrow scanner baseline is acceptable for the historical false positive.

## Required Before `v0.1.0`

- Complete secret scan triage.
- Rotate any real credential found during triage.
- Complete asset/license audit in `docs/asset-license-audit.md`.
- Confirm root Apache-2.0 license is acceptable for source code.
- Keep non-redistributable `sense-*` scene bundles out of the public platform HEAD and public Docker images.
- Resolve or explicitly accept git-history exposure for removed private scene assets before making this repository public.
