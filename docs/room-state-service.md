# Room State Service

## Current baseline

- `apps/room-state` now exposes a lightweight authoritative room-state service over WebSocket.
- Clients connect with `roomId` and `participantId` query params.
- The server keeps room state in memory and broadcasts `room_state` snapshots after joins, updates, and disconnects.

## Purpose

- This is the first step away from purely API-polled presence.
- It creates a dedicated state authority for realtime room membership and participant transforms.

## Current shape

- Health endpoint: `/health`
- WebSocket message in:
  - `participant_update`
- WebSocket message out:
  - `room_state`

## Next step

- Wire runtime to consume this room-state service as the primary realtime channel.
- Keep API presence endpoints as fallback/diagnostic path until the migration is complete.
