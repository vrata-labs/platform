# Media Plane

## Scope

The media plane owns realtime voice and later screen share transport. It does not own presence, room state, or scene logic.

## `M0` baseline

- `LiveKit` is the transport layer.
- Runtime explicitly requests a media token through `apps/api`.
- Voice join is user-triggered through `Join Audio` UX.
- Spatial audio remains a client-side runtime concern layered on top of remote audio tracks.

## Initial contracts

- `POST /api/tokens/media` returns a server-issued `LiveKit` token and `livekitUrl` after validating the room session token.
- Runtime plans a voice session from room manifest + media token, then connects with the `livekit-client` SDK.
- `Join Audio` publishes the local microphone only after a user gesture; the same control becomes `Leave Audio` after a successful join.
- `Leave Audio` unpublishes the local microphone track and leaves the media room available for passive receive/screen-share use.
- Presence schema includes `muted` and `activeMedia` fields for future sync and UI hooks.

## Implemented runtime diagnostics

- Local media debug state: `not_joined`, `joining`, `joined`, `muted`, `degraded`, `failed`.
- Local publish state: `publishedAudio`, `audioSource`, and microphone level.
- Remote receive state: `subscribedAudioCount`, speaker level, and spatial audio source attachment.
- WebRTC/TURN transport diagnostics in the runtime debug payload and public diagnostics page.
