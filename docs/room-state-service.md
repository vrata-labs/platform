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

Media surfaces are included in each full snapshot, together with `serverTimeMs`. The built-in `pdf-presentation`, `image-viewer`, and `video-player` objects store authoritative presentation state. Video state stores a playback position plus a server-time anchor rather than trusting client timestamps. Mutations use the existing revisioned `surface_patch_object_state` command and require `document.present`; viewers receive the same state without control permission.

Document deletion calls `DELETE /api/internal/rooms/:roomId/documents/:documentId/media-objects` with the internal service token. The room-state service removes matching PDF/image/video objects, frees their surfaces, and broadcasts the updated snapshot. The legacy `/presentation` cleanup alias remains accepted during the API/room-state rollout boundary.

Room state is currently process-memory state. Late join is supported while the service remains alive, but active presentation/page state is not restored after a room-state process restart.

## Next step

- Wire runtime to consume this room-state service as the primary realtime channel.
- Keep API presence endpoints as fallback/diagnostic path until the migration is complete.
