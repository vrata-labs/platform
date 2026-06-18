# ADR-003: Use Colyseus for authoritative room state

## Status

Accepted

## Context

The product needs a separate source of truth for participant presence, transforms, and room logic. Media transport should not also own gameplay-style state.

## Decision

Use `Colyseus` as the authoritative state plane for room state and presence.

## Consequences

- Presence and transforms remain independent from media transport.
- We can model room logic explicitly and keep runtime sync predictable.
- We add a dedicated state service to local and staging infrastructure.

## Rejected alternatives

- Reusing media signaling as room state transport: mixes responsibilities.
- Fully client-authoritative sync: too fragile for the planned product flow.
