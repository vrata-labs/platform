# Media Plane

## Scope

The media plane owns realtime voice and later screen share transport. It does not own presence, room state, or scene logic.

## `M0` baseline

- `LiveKit` is the transport layer.
- Runtime explicitly requests a media token through `apps/api`.
- Voice join is user-triggered through `Join Audio` UX.
- Spatial audio remains a client-side runtime concern layered on top of remote audio tracks.

## Initial contracts

- `POST /api/tokens/media` returns a placeholder join token and `livekitUrl`.
- Runtime plans a voice session from room manifest + media token.
- Presence schema includes `muted` and `activeMedia` fields for future sync and UI hooks.

## Deferred until next step

- Real `LiveKit` SDK integration
- Join/mute/unmute device lifecycle
- AudioContext graph and `PannerNode` wiring
- Debug panel for participant media state
