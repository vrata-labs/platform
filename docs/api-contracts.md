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

Returns a short-lived signed room session token used by runtime, `apps/room-state`, and media token issuing.

Request:

```json
{
  "roomId": "demo-room",
  "participantId": "p1",
  "displayName": "Guest",
  "requestedRole": "guest"
}
```

Response:

```json
{
  "token": "base64url-payload.hmac-signature",
  "expiresInSeconds": 900,
  "sessionId": "session-id",
  "role": "guest",
  "permissions": ["room.join", "audio.join", "surface.view"]
}
```

Signed payload claims are `tenantId`, `roomId`, `participantId`, `displayName`, `role`, `permissions`, `sessionId`, `iat`, `exp`, and `jti`. The server normalizes permissions from the signed role when validating the token.

### `POST /api/tokens/media`

Returns a media-plane join token payload for `LiveKit`.

Requires `Authorization: Bearer <room-session-token>`. The session token must match the requested room and participant. The API derives publish grants from signed room permissions instead of trusting caller-provided role claims.

Request:

```json
{
  "roomId": "demo-room",
  "participantId": "p1",
  "canPublishAudio": true,
  "canPublishVideo": false
}
```

Runtime-mutating endpoints also require the same session token:

- `PUT /api/rooms/:roomId/presence/:participantId`
- `DELETE /api/rooms/:roomId/presence/:participantId`
- `POST /api/rooms/:roomId/diagnostics`
- `PUT /api/rooms/:roomId/xr-telemetry/:participantId`
- `POST /api/tokens/remote-browser-frame`

Response:

```json
{
  "token": "base64url-encoded-payload",
  "expiresInSeconds": 900,
  "livekitUrl": "ws://localhost:7880"
}
```

## Notes

- Room session tokens are signed with `STATE_TOKEN_SECRET` and expire through the `exp` claim.
- Dev role escalation through `requestedRole` is allowed only when the dev-role query mode is enabled; production-safe configs disable it.
- `schemaVersion` must remain explicit in every manifest.
- Runtime should degrade gracefully if media or XR features are unavailable.
