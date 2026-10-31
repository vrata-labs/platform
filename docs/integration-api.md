# Integration API (`platform-integration-v1`)

The integration API lets a trusted portal service create and manage rooms on behalf of its own tenants. It is off by default; a self-hosted deployment without the settings below behaves exactly as before.

## Enabling a portal-managed deployment

| Variable | Default | Meaning |
| --- | --- | --- |
| `VRATA_PORTAL_MANAGED` | `false` | Enables `/integration/v1/*` and the managed-resource rules below. |
| `VRATA_ADHOC_ROOMS` | `true`, or `false` when `VRATA_PORTAL_MANAGED=true` | Whether an unknown room id may behave like a room. Production preflight rejects `true` on a portal-managed deployment. |
| `VRATA_INTEGRATION_KEYS` | empty | JSON array of portal **public** keys. A managed API refuses to start in production without at least one valid key. |
| `VRATA_DEMO_POLICIES` | empty | JSON array of portal demo policies (contract `demo-policy`). Empty means no `demo-instance` rooms. The API refuses to start with an invalid policy. |
| `VRATA_RETURN_TARGETS` | empty | JSON object from a `returnContext` kind (`catalog-entry`, `space`, `workspace`, `order`, `preview`) to `{"ru": …, "en": …}` https templates, plus `fallback` `{"ru": …, "en": …}` for other grants. `{id}` stands for the `returnContext` id and may appear once, in the path only; `fallback` has no `{id}`. Empty means the runtime offers no way back. The API refuses to start with an invalid value. |
| `RUNTIME_BASE_URL` | — | Public https origin of the runtime; grant entry URLs are built from it. |
| `LIVEKIT_API_URL` | `LIVEKIT_URL` | Server-side address of the LiveKit HTTP API (for example `http://livekit:7880`), used to create and delete media rooms when the public LiveKit URL exposes only signaling. |

```json
[
  {
    "kid": "portal-stage-2026-10",
    "issuer": "portal:stage",
    "scopes": ["upsertTenant", "createRoom", "getRoom", "updateRoomAccess", "closeRoom", "issueGrant", "revokeGrant", "getUsage", "getOperation", "findOperation"],
    "publicKey": { "kty": "OKP", "crv": "Ed25519", "x": "<base64url public key>" }
  }
]
```

Keys are Ed25519 public JWKs; an entry with private key material (`d`) is rejected. A key with a scope this platform version does not know is rejected too, so new scopes are added to a key only after the platform that knows them is deployed. Two keys of one issuer can be active at once for rotation. Stage and prod use different issuers (`portal:stage`, `portal:prod`) and different keys.

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
| `POST /integration/v1/tenants/{tenantId}/rooms` | `createRoom` | `201` Room. `kind` is `reference` or `demo-instance`; other kinds answer `400`. |
| `GET /integration/v1/tenants/{tenantId}/rooms/{roomId}` | `getRoom` | `200` Room or `404 room_not_found`. |
| `PATCH /integration/v1/tenants/{tenantId}/rooms/{roomId}/access` | `updateRoomAccess` | `200` Room; `expectedRevision` is compared and set atomically. A closed room answers `410 room_closed`. |
| `POST /integration/v1/tenants/{tenantId}/rooms/{roomId}/close` | `closeRoom` | `200` Room with `status: "closed"` and `closedAt`. `expectedRevision` is compared; closing a closed room returns its tombstone. |
| `POST /integration/v1/tenants/{tenantId}/rooms/{roomId}/grants` | `issueGrant` | `201` Grant with `entryUrl`; see Grants. |
| `POST /integration/v1/tenants/{tenantId}/rooms/{roomId}/grants/{grantId}/revoke` | `revokeGrant` | `200` Grant with `revokedAt`; an unknown grant or one of another room answers `404 grant_invalid`. |
| `GET /integration/v1/tenants/{tenantId}/usage?day=YYYY-MM-DD` | `getUsage` | `200 {tenantId, day, participantSeconds, updatedAt?}` for one UTC day. |
| `GET /integration/v1/operations/{operationId}` | `getOperation` | Operation record of this principal. |
| `GET /integration/v1/operations?idempotencyKey=...` | `findOperation` | Operation recorded for the key. |

Request and resource schemas are the portal contract `platform-integration-v1` (room-create-request, room, room-access-update, grant-issue-request, grant, grant-exchange, usage, demo-policy, operation, error). Errors use the envelope `{"error": {"code", "message", "requestId", "retryable", "retryAfterSeconds?", "details?"}}`.

A tenant belongs to the principal that created it: another principal, or a tenant created by an operator, answers `403 tenant_mismatch`. A room is visible only inside its tenant.

For a reference room the server chooses the template version, snapshot and scene: the request names `template.templateId` and must name the version that is current in the catalog, otherwise `422 template_not_allowed`. `personal-room-basic` needs `ownerSubject` and private visibility; the platform uses the subject as the owner participant id. Room ids are server-generated UUIDs.

### Idempotency and crash recovery

Mutations require `Idempotency-Key` (16–64 characters `[A-Za-z0-9_-]`). The platform stores `(principal, key) -> request hash, operation, response` in `integration_operations`:

- the same key and body return the stored response (`idempotency-replayed: true`), including recorded failures;
- the same key with another body answers `409 idempotency_key_reused`;
- a key whose request is still running answers `409 idempotency_in_progress` with `details.operationId`, `retryable: true`.

The resource id is assigned when the operation starts, and a room or access change records the operation that produced it. If a request commits and then dies before recording the result, its 30-second lease expires and a retry with the same key finishes the same operation: it returns the committed room or revision instead of creating a second room or reporting a revision conflict. Operation records are kept indefinitely in this version.

### Demo instances

`kind: "demo-instance"` takes `demoPolicyId` of a policy in `VRATA_DEMO_POLICIES` and a template the policy lists (`meeting-room-basic` or `presentation-room-basic`); otherwise `400` or `422 template_not_allowed`. A demo instance has no owner, is private, has no grace period, and `accessUntil` may be at most the policy lifetime away. The room keeps the policy's participant limit, idle timeout and features; a policy without voice gets no microphone in media tokens. Quotas, creation rate, the kill switch and the media budget are the portal's.

### Grants

A grant is a one-time or bounded entry into a managed room (contract section 7). A guest grant has no subject: `purpose: "visit"` with one use, or `purpose: "invite"` with up to 50. A `member`, `presenter` or `host` grant is for a portal account: it needs `subject` (`acct_<ULID>`) and is always a one-use `visit`; the portal issues one per entry. A personal room admits no guests and no account but its `ownerSubject`.

- The code has 256 bits, is returned once in `entryUrl = <RUNTIME_BASE_URL>/rooms/{roomId}#grant=<code>` and is stored only as an HMAC under a key derived from `STATE_TOKEN_SECRET`, also in the operation record. A replay of the issuing request returns the grant without `entryUrl`; the portal revokes such a grant and issues a new one.
- `expiresAt` is clamped to the room's effective cutoff.
- `POST /api/room-grants/exchange {roomId, code, displayName?}` (browser, no assertion) consumes one use under a lock of the room and creates a room identity v2 with provenance `grant`; it reads the grant again after recording the identity, so a revoke that ran meanwhile revokes it either way. The answer carries `participantId`, `identityCredential` (ri2), `sessionToken` (rs2), `sessionExpiresAt`, `cutoff`, `returnContext` and `returnUrls` `{ru, en}` — the way back the platform made of `returnContext` with `VRATA_RETURN_TARGETS` (the fallback when its kind is not configured; absent without the variable). A grant never carries a URL, and the runtime never builds one, so the way back cannot point outside the portal. Errors: `409 grant_invalid` (unknown, expired, used up or another room's code), `410 grant_revoked`, `410 room_closed` / `access_expired`, `423 room_paused`, `503 capacity_full` (the uses of all grants of a demo instance reached its participant limit), `429 rate_limited`, `503 dependency_unavailable` before identity v2 is active.
- The runtime reads `#grant=` at load, removes it from the address at once and keeps it in the tab until the exchange. Then it renews the identity like any v2 identity.
- Revoking a grant revokes every identity that entered with it, then rotates the media epoch. A revoke interrupted on its way is finished by the enforcer; finishing it twice asks for one rotation.

### Account entries

- **One participant per account and generation.** The exchange of an account grant runs in one transaction under the room lock: if the account has an active identity in the room, the exchange returns a new credential and session for it — the same `participantId`, notes and role on a second device; otherwise it creates the next generation, a new identity with a new `participantId` `acct_<ULID>`. The participant id is random per room and generation and never equals the subject, so rooms cannot match an account; the subject stays in the identity's provenance and is never returned. A revoked or removed identity never returns (identity v2 revocation is terminal), so after a revoke or a host's removal the account comes back only as a new participant, without the personal data of the old one.
- **Roles.** The answer carries the role the room gives now. A `host` grant makes the account host only as the first host of the room (authority revision 0, like a host invite); later the host changes by the host's transfer. A `presenter` grant takes a free presenter slot for a new generation only; a returning generation keeps the host's decisions. A guest of a grant can never be made host, neither by the host nor by an administrator.
- **Personal rooms.** The owner of a managed personal room is its `ownerSubject`: every generation of that account takes the vacant owner slot. No participant id stands for the owner in the room record, so the manifest and session control do not show the subject.
- **Revoke ends the account's access.** The first revoke of an account grant also revokes every other grant the account has in the room, used or not; a repeat takes nothing more. A generation belongs to the revoked access exactly when the grant that created it is revoked, so the revoke ends it at once and a late finisher (the enforcer) never ends a generation created by a grant issued afterwards. An exchange finishes any such revoke of its account before it admits, and a stalled exchange that finds its grant revoked withdraws only an identity it created itself. A failed exchange gives the use back; an account generation is not withdrawn for a failed link, since another device may already use it and the revoke finds it by the account.
- **Rollback.** A build without account grants enters an already issued account grant as a guest and revokes grants one by one, so an open grant of an account would still enter after its access was revoked. Once account grants are issued, roll a portal-managed deployment back only to builds with them, or have the portal revoke every open account grant first.

## Rules for managed rooms

- **Entry.** A managed room admits new identities only through a grant exchange, which needs identity v2. An anonymous guest of an unlisted room and the floor-1 `POST /api/tokens/state` answer `403 grant_required`; invites cannot be created for managed rooms.
- **Access window.** `effectiveCutoff = accessUntil + graceSeconds`. From the cutoff, new and renewed state tokens, session-control, media tokens, presence updates and remote-browser tokens answer `410 access_expired`; a paused room answers `423 room_paused`. Every state, room session and media token issued for a managed room expires no later than the cutoff. A room session that is still valid does not outlast the window either: every request with an rs2 of a paused or expired room — notes, documents, personal-state, spaces, presence, session-control, the plugin API — answers `423 room_paused` or `410 access_expired` at once, with `error: "room_access_denied"`. Extending `accessUntil` reopens issuing.
- **Close.** A closed room is a tombstone: `410 room_closed` on grants, exchange, tokens and every `/api/rooms/{roomId}/*` route, it is never reopened, and its id is not reused. Closing also moves `accessUntil` to the close time, and a database trigger refuses any later change of its status or window, so a platform build that does not know the closed status sees the room as expired and cannot reopen it. Such a build does not run the enforcer, though: roll back a portal-managed deployment only to builds with it.
- **Live sessions.** Room-state re-verifies every socket each second through the API (5-second timeout); for a closed, expired or paused room, or a revoked identity, the verification fails and the socket closes within a few seconds. Session-control answers the same reasons, and the runtime shows that the room has ended.
- **Media epochs.** A managed room has one LiveKit room per access epoch: `<prefix>v2:<namespace>:<roomId>:<epoch>`. The API creates it (`CreateRoom`) when it issues a media token, so portal targets run LiveKit with `room.auto_create: false`. When access is withdrawn (cutoff, pause, close) or a used grant is revoked, the room moves to a new epoch and the LiveKit room of the old one is deleted, which disconnects everyone; a JWT for the old name then joins nothing. A pause, a close and any change after a lapsed window record the rotation request in the same transaction, so a later change cannot hide it from the enforcer; a revoke asks for it only after the identities of the grant are revoked. While LiveKit is unavailable new media tokens answer `503` and the deletion is retried; each pass also deletes any LiveKit room of a managed room that is not on its current epoch (for example one recreated by a delayed `CreateRoom`).
- **Enforcement.** A loop in the API (every 10 seconds and right after access changes, one process at a time under a PostgreSQL advisory lock) rotates epochs, deletes old LiveKit rooms, and closes a demo instance nobody has been connected to for its idle timeout. Room-state verifications count as presence: they give the last activity and the participant-seconds reported by `getUsage`; seconds that could not be written are retried as computed. Usage can be overcounted, never silently dropped: with several API processes each counts the sessions it verified, and a write whose acknowledgement was lost is retried.
- **No ad-hoc rooms.** With `VRATA_ADHOC_ROOMS=false`, an unknown room id answers `404 room_not_found` on `/api/rooms/{roomId}/*`, `POST /api/tokens/state`, `POST /api/tokens/media` and the remote-browser token endpoints.
- **No side doors.** The admin token and anonymous endpoints cannot create, change or delete managed resources. `POST/PATCH/DELETE /api/tenants` for a managed tenant (or a new `pt_` tenant id), `POST /api/rooms` and `POST /api/personal-room` in a managed tenant, and `PATCH/DELETE /api/rooms/{roomId}`, `disable`/`enable`, `bind-scene-bundle` and invite creation for a managed room answer `403` with `reason: "managed_resource"`. PostgreSQL foreign keys also keep managed tenants and rooms from being deleted directly.
- **No public catalogue.** `GET /api/tenants`, `GET /api/assets` and `GET /api/rooms` leave out managed tenants, their assets and their rooms for every caller except the admin token, including a room session of one of those rooms. A stand-alone platform without managed tenants answers as before. Scene bundles have no tenant yet; tenant bundles and the same filter come with custom bundles. The record of a managed room (`GET /api/rooms/{roomId}`: its name and access window) is for a session of that room and the admin token only, even when the room is unlisted; the manifest stays readable for the runtime's boot and carries no name, participants or access window.
- **Entry-point matrix.** `managed-access-matrix.postgres.test.ts` runs every room-scoped route against callers outside the room (anonymous, a session of another room of the same tenant, of another tenant, a revoked one) and inside it (guest, member, host): outsiders are refused and see none of the room's data, host operations need the host, routes closed for managed rooms stay closed. Its registry is checked against the route patterns of the build, so a new room route needs a row there.
- **Legacy rooms and links.** Nothing from before the portal is assigned to an account: a legacy personal room, a remembered participant id or an old room link never becomes a managed room or a grant, and a grant opens only the managed room it was issued for. A legacy personal room is recovered only through the administrator recovery of room identity v2 (`POST /api/rooms/{roomId}/identity-recovery`), never by matching a participant id from the browser.

Preview rooms, custom bundles and restoring epochs after a backup are later contract tasks.
