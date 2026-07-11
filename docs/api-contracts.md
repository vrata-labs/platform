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

Signed payload claims are `tenantId`, `roomId`, `participantId`, `displayName`, `role`, optional `roleSource`, `permissions`, `sessionId`, `iat`, `exp`, and `jti`. The server normalizes permissions from the signed role when validating the token.

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

### Control-plane AuthN/AuthZ

Control-plane protected actions are deny-by-default. They require either `x-vrata-admin-token: <CONTROL_PLANE_ADMIN_TOKEN>` or `Authorization: Bearer <room-session-token>`.

Only the `CONTROL_PLANE_ADMIN_TOKEN` header is an operator/admin identity. Signed room-session tokens can authorize only explicitly allowed room-scoped actions; a room-session role named `admin` is not treated as a control-plane admin.

Host-owned control-plane actions require a trusted room-session role source. Tokens minted through dev-role query mode are valid runtime tokens but are denied for control-plane host-owned actions.

Missing identity returns `401` with `reason: "missing_identity"`. A valid identity without the declared permission returns `403` with `reason: "permission_denied"`.

The current permission matrix is documented in [`docs/security/permissions.md`](./security/permissions.md). The protected endpoint groups are:

- tenant writes
- room create/update/delete
- host-own-room scene-bundle binding
- asset writes
- scene-bundle writes
- XR telemetry admin/host-own-room reads
- control-plane audit reads

Every protected authorization decision writes a control-plane audit entry with `requestId`, `actor`, `action`, `object`, `permission`, and `result`. Operators can inspect the bounded in-memory log with `GET /api/audit/control-plane` using an admin identity.

### Room documents and PDF presentation

- `GET /api/rooms/:roomId/documents` requires `document.view`.
- `POST /api/rooms/:roomId/documents` requires `document.upload`. PDF uploads are parsed before storage and return `422` with `corrupt_pdf`, `encrypted_pdf_unsupported`, or `pdf_page_limit_exceeded` when rejected.
- `GET /api/rooms/:roomId/documents/:documentId/download` requires `document.download` and returns an attachment.
- `POST /api/rooms/:roomId/documents/:documentId/surface` requires `document.present`; only validated PDFs can be bound.
- `GET /api/rooms/:roomId/documents/:documentId/presentation` requires `surface.view`, returns an inline PDF only while the document is bound, and is used by in-room viewers including guests.
- `DELETE /api/rooms/:roomId/documents/:documentId` requires `document.delete`, removes active presentation objects through the internal room-state API, deletes the blob, and soft-deletes metadata.

The `presenter`, `host`, and operator `admin` roles have `document.present`. Members and guests remain view-only for presentation state. Configure upload size with `DOCUMENT_UPLOAD_MAX_BYTES` and page count with `PDF_PRESENTATION_MAX_PAGES`.

## Notes

- Room session tokens are signed with `STATE_TOKEN_SECRET` and expire through the `exp` claim.
- Dev role escalation through `requestedRole` is allowed only when the dev-role query mode is enabled; production-safe configs disable it.
- `schemaVersion` must remain explicit in every manifest.
- Runtime should degrade gracefully if media or XR features are unavailable.
