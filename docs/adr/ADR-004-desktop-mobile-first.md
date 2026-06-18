# ADR-004: Prioritize desktop and mobile, treat VR as progressive enhancement

## Status

Accepted

## Context

The product is intended for companies and needs the broadest practical access path. WebXR support is still uneven across browsers and devices.

## Decision

Design every room flow to work first on desktop and mobile, then layer VR support on top where available.

## Consequences

- Core adoption does not depend on XR availability.
- `Enter VR` remains a capability flag, not a separate product branch.
- QA and demos can proceed even when XR hardware is unavailable.

## Rejected alternatives

- VR-first runtime: narrows reach and increases support risk.
- Separate VR and non-VR rooms: duplicates the product path.
