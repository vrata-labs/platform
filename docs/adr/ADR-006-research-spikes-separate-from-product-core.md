# ADR-006: Keep research spikes separate from product core

## Status

Accepted

## Context

The team wants direct understanding of WebRTC, WebXR, WebGL, and spatial audio behavior. That knowledge is useful, but product delivery cannot depend on experimental code paths.

## Decision

Keep low-level experiments in `research/` and prevent them from becoming implicit dependencies of the product runtime.

## Consequences

- Research can inform ADRs and debugging without destabilizing delivery.
- Product implementation remains anchored to the chosen stack.
- Experimental code can be time-boxed and discarded when it stops creating value.

## Rejected alternatives

- Embedding spike code into `apps/runtime-web`: blurs boundaries.
- Delaying research entirely: loses useful implementation knowledge.
