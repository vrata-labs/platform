# ADR-002: Use LiveKit for media plane

## Status

Accepted

## Context

The MVP needs reliable multiparty voice and later screen share. Building and operating a custom SFU or mesh-first multiparty path would slow delivery and increase risk.

## Decision

Use self-hosted `LiveKit` for voice and screen share transport.

## Consequences

- We get a stable path for multiparty media early.
- The API must issue media tokens and manage environment configuration.
- We avoid turning WebRTC experimentation into the product architecture.

## Rejected alternatives

- Custom SFU: unjustified for MVP.
- Browser mesh as core architecture: unreliable for the target room flow.
