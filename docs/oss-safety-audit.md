# Open Source Safety Audit

This document tracks blockers before Noah can be published as a public open source repository.

## Current Status

- Status: direct publication of the existing repository history is blocked; clean public import is the approved public release path.
- Last scan date: 2026-06-16.
- Scanner: `gitleaks`.
- Current-tree result: `gitleaks dir . --redact` found no leaks after sanitizing legacy host references.
- Git-history result: `gitleaks detect --redact` still reports `1` redacted historical finding in repository history.
- Public release decision: do not publish this repository history. Build the public repository from a clean import of the current cleared tree.

## Findings

### GL-2026-06-16-001

- Scanner rule: `generic-api-key`.
- File: `docs/staging-migration-2026-03-30.md`.
- Historical commit: `000940b2f9e0bb81548831c74a38e81d4072907a`.
- Current triage: historical-only scanner match. The current file contains placeholders and current-tree scan is clean. The finding does not block a clean public import because commit `000940b2f9e0bb81548831c74a38e81d4072907a` will not be present in the public repository history.
- Current-tree mitigation: current `docs/staging-migration-2026-03-30.md` host references were replaced with placeholders.
- Required before public release: verify the clean public import with `gitleaks dir . --redact`. If the existing private repository history is ever made public directly, this finding must be re-triaged and any real credential must be rotated first.

## Required Before `v0.1.0`

- Complete secret scan triage for the public release path.
- Rotate any real credential found during triage.
- Complete asset/license audit in `docs/asset-license-audit.md`.
- Confirm root Apache-2.0 license is acceptable for source code.
- Keep non-redistributable `sense-*` scene bundles out of the public platform HEAD and public Docker images.
- Do not make the existing repository history public; publish a clean import/mirror instead.
