# State Plane

## Current baseline

- Room state scaffold exists in `apps/room-state`.
- Presence schema models `role`, `mode`, `rootTransform`, `headTransform`, `muted`, and `activeMedia`.
- Join helpers support basic room entry state.

## Pending work

- Real Colyseus room implementation
- Interpolation and reconciliation
- Authoritative ownership rules
- Reconnect and leave cleanup behavior
