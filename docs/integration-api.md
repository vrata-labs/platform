# Integration API (`platform-integration-v1`)

The integration API lets a trusted portal service create and manage rooms on behalf of its own tenants. It is off by default; a self-hosted deployment without the settings below behaves exactly as before.

## Enabling a portal-managed deployment

| Variable | Default | Meaning |
| --- | --- | --- |
| `VRATA_PORTAL_MANAGED` | `false` | Enables `/integration/v1/*` and the managed-resource rules below. |
| `VRATA_ADHOC_ROOMS` | `true`, or `false` when `VRATA_PORTAL_MANAGED=true` | Whether an unknown room id may behave like a room. Production preflight rejects `true` on a portal-managed deployment. |
| `VRATA_INTEGRATION_KEYS` | empty | JSON array of portal **public** keys. A managed API refuses to start in production without at least one valid key. |

```json
[
  {
    "kid": "portal-stage-2026-10",
    "issuer": "portal:stage",
    "scopes": ["upsertTenant", "createRoom", "getRoom", "updateRoomAccess", "getOperation", "findOperation"],
    "publicKey": { "kty": "OKP", "crv": "Ed25519", "x": "<base64url public key>" }
  }
]
```

Keys are Ed25519 public JWKs; an entry with private key material (`d`) is rejected. Two keys of one issuer can be active at once for rotation. Stage and prod use different issuers (`portal:stage`, `portal:prod`) and different keys.

The public ingress never routes `/integration/*` (all bundled Caddyfiles answer `404`). The portal calls the API over the target's internal network, for example the API's direct port.

## Authentication

Every request carries `Authorization: Bearer <JWS>`: a compact JWS with header `{"alg":"EdDSA","kid":"..."}` and claims:

| Claim | Rule |
| --- | --- |
| `iss` | Equals the issuer configured for `kid`; becomes the principal and the tenants' `managedBy`. |
| `aud` | `platform-integration-v1` (string or array). |
| `iat`, `exp` | Integers; `exp - iat <= 60`, 15 seconds of clock skew. |
| `jti` | 16–128 characters `[A-Za-z0-9_-]`; accepted once per principal within its lifetime (stored in PostgreSQL). |
| `scope` | Array or space-separated list of operation ids. Only scopes also granted to the key count. |

A rejected assertion answers `401 unauthenticated` with `details.reason`; a missing scope answers `403 forbidden_scope`.

## Operations

| Method and path | Scope | Result |
| --- | --- | --- |
| `PUT /integration/v1/tenants/{tenantId}` | `upsertTenant` | `200 {tenantId, managedBy, revision}`; creates `pt_<ULID>` tenants or renames them. |
| `POST /integration/v1/tenants/{tenantId}/rooms` | `createRoom` | `201` Room. Only `kind: "reference"` is supported; other kinds answer `400`. |
| `GET /integration/v1/tenants/{tenantId}/rooms/{roomId}` | `getRoom` | `200` Room or `404 room_not_found`. |
| `PATCH /integration/v1/tenants/{tenantId}/rooms/{roomId}/access` | `updateRoomAccess` | `200` Room; `expectedRevision` is compared and set atomically. |
| `GET /integration/v1/operations/{operationId}` | `getOperation` | Operation record of this principal. |
| `GET /integration/v1/operations?idempotencyKey=...` | `findOperation` | Operation recorded for the key. |

Request and resource schemas are the portal contract `platform-integration-v1` (room-create-request, room, room-access-update, operation, error). Errors use the envelope `{"error": {"code", "message", "requestId", "retryable", "retryAfterSeconds?", "details?"}}`.

A tenant belongs to the principal that created it: another principal, or a tenant created by an operator, answers `403 tenant_mismatch`. A room is visible only inside its tenant.

For a reference room the server chooses the template version, snapshot and scene: the request names `template.templateId` and must name the version that is current in the catalog, otherwise `422 template_not_allowed`. `personal-room-basic` needs `ownerSubject` and private visibility; the platform uses the subject as the owner participant id. Room ids are server-generated UUIDs.

### Idempotency and crash recovery

Mutations require `Idempotency-Key` (16–64 characters `[A-Za-z0-9_-]`). The platform stores `(principal, key) -> request hash, operation, response` in `integration_operations`:

- the same key and body return the stored response (`idempotency-replayed: true`), including recorded failures;
- the same key with another body answers `409 idempotency_key_reused`;
- a key whose request is still running answers `409 idempotency_in_progress` with `details.operationId`, `retryable: true`.

The resource id is assigned when the operation starts, and a room or access change records the operation that produced it. If a request commits and then dies before recording the result, its 30-second lease expires and a retry with the same key finishes the same operation: it returns the committed room or revision instead of creating a second room or reporting a revision conflict. Operation records are kept indefinitely in this version.

## Rules for managed rooms

- **Access window.** `effectiveCutoff = accessUntil + graceSeconds`. From the cutoff, new and renewed state tokens, session-control token renewal, media tokens, presence updates and remote-browser tokens answer `410 access_expired`; a paused room answers `423 room_paused`. Every state and media token issued for a managed room expires no later than the cutoff, so the room-state service stops accepting it too. Extending `accessUntil` reopens issuing. Ending sessions that are already connected is not part of this version.
- **No ad-hoc rooms.** With `VRATA_ADHOC_ROOMS=false`, an unknown room id answers `404 room_not_found` on `/api/rooms/{roomId}/*`, `POST /api/tokens/state`, `POST /api/tokens/media` and the remote-browser token endpoints.
- **No side doors.** The admin token and anonymous endpoints cannot create, change or delete managed resources. `POST/PATCH/DELETE /api/tenants` for a managed tenant (or a new `pt_` tenant id), `POST /api/rooms` and `POST /api/personal-room` in a managed tenant, and `PATCH/DELETE /api/rooms/{roomId}`, `disable`/`enable`, `bind-scene-bundle` and invite creation for a managed room answer `403` with `reason: "managed_resource"`. PostgreSQL foreign keys also keep managed tenants and rooms from being deleted directly.

Grants and their exchange, demo rooms, closing rooms with tombstones and media epochs are later contract tasks; until then legacy room entry rules apply inside the access window.
