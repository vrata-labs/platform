# ADR-005: Use shared managed infrastructure for MVP

## Status

Accepted

## Context

The product needs room creation, branding, and deployment semantics early, but standing up isolated infrastructure per tenant would slow the MVP without validating core product value.

## Decision

Use a shared managed deployment model for MVP and represent "deploy" as logical publication of tenant/template/room configuration.

## Consequences

- We can ship self-service room creation earlier.
- The control plane focuses on manifests, links, assets, and policies.
- Future self-hosted or isolated tenant deployments remain a later track.

## Rejected alternatives

- Per-tenant infrastructure from day one: too much operational weight.
- Manual engineer-driven room provisioning: not enough product leverage for M1.
