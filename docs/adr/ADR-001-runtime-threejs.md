# ADR-001: Use Three.js for runtime core

## Status

Accepted

## Context

The product needs a controllable web runtime for desktop, mobile, and WebXR, with direct ownership over lifecycle, quality profiles, asset loading, and scene composition.

## Decision

Use `Three.js` on top of `WebGL2` as the runtime foundation.

## Consequences

- We retain direct control over render lifecycle and WebXR integration.
- We avoid coupling the product runtime to a higher-level scene framework.
- We accept a higher implementation burden than declarative 3D wrappers.

## Rejected alternatives

- `A-Frame` as core runtime: faster for demos, but too opinionated for the product path.
- Custom low-level renderer: too expensive and not required for MVP value.
