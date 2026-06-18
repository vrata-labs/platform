# API Contracts

## Overview

The API layer starts as the boundary between runtime, room state, and media services. `M0` contracts are intentionally narrow and versioned through manifest schema.

## Endpoints

### `GET /health`

Returns service liveness for local and staging smoke checks.

Response:

```json
{
  "status": "ok",
  "service": "api",
  "port": 4000
}
```

### `GET /api/rooms/:roomId/manifest`

Returns the room manifest used by runtime boot.

Response shape:

```json
{
  "schemaVersion": 1,
  "tenantId": "demo-tenant",
  "roomId": "demo-room",
  "template": "meeting-room-basic",
  "features": {
    "voice": true,
    "spatialAudio": true,
    "screenShare": false
  },
  "quality": {
    "default": "desktop-standard",
    "mobile": "mobile-lite",
    "xr": "xr"
  },
  "access": {
    "joinMode": "link",
    "guestAllowed": true
  }
}
```

### `POST /api/tokens/state`

Returns a state-plane join token payload for `apps/room-state`.

Request:

```json
{
  "roomId": "demo-room",
  "participantId": "p1",
  "role": "guest"
}
```

Response:

```json
{
  "token": "base64url-encoded-payload",
  "expiresInSeconds": 900
}
```

### `POST /api/tokens/media`

Returns a media-plane join token payload for `LiveKit`.

Request:

```json
{
  "roomId": "demo-room",
  "participantId": "p1",
  "canPublishAudio": true,
  "canPublishVideo": false
}
```

Response:

```json
{
  "token": "base64url-encoded-payload",
  "expiresInSeconds": 900,
  "livekitUrl": "ws://localhost:7880"
}
```

## Notes

- Current token implementation is a dev-safe placeholder, not signed production auth.
- `schemaVersion` must remain explicit in every manifest.
- Runtime should degrade gracefully if media or XR features are unavailable.
