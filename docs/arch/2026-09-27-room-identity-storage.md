# Room identity v2: storage and credential foundations

## Scope of T01a-S2a

This preparatory slice provides a Node-only credential codec, an internal identity service, and equivalent Memory/PostgreSQL authority and one-time recovery operations. API startup installs additive tables and guards. It does **not** activate v2 admission, HTTP recovery, token refresh or WebSocket authentication. Existing public v1 issuance is still vulnerable to identity-by-ID until the coordinated S2b switch. No plugin-author endpoint may rely on it.

`createRoomIdentityService` is not called by legacy routes. Its `admitFromVerifiedAccess` input represents an admission already validated by the server, not a client body or a role copied from a v1 JWT. Likewise, recovery issuance must receive the actual authenticated platform-admin actor, never client-supplied actor metadata. The service itself rejects room-session actors, including an actor claiming an admin role.

## Credentials and proof

- Node-only export: `@vrata/shared-types/identity-credential`; the browser root entry does not import the crypto implementation.
- Identity credential: `ri2.<base64url-json>.<signature>`, with version 2, purpose, tenant/room, server-generated identity ID, participant ID, auth epoch, issuance/expiry and random nonce. No embedded roles or permissions.
- HMAC keys are derived with HKDF into separate identity and recovery domains. The configured root secret must have at least 32 UTF-8 bytes; there is no development-secret fallback in this codec.
- The default identity credential lifetime is 900 s, capped at 24 h. Verification requires the expected room and tenant and bounded, canonical payload/signature encoding.
- A valid signature is only proof of possession. Every authority resolution checks the stored identity, participant binding, epoch, revocation and room state. Privileged writes must validate current authority inside their transaction, not rely on a previous read snapshot.
- Renewing a verified v2 credential retains identity/participant/epoch but produces a new nonce. Legacy session tokens are not a renewal or recovery credential and cannot be converted by this service.

## Stored records and transaction boundaries

Three room-scoped tables are added: `room_identities_v2`, `room_identity_authority_v2`, `room_identity_recoveries_v2`. Foreign keys include tenant and room. Identity participant IDs are unique within that scope; room deletion cascades metadata.

Identity admission produces fresh server UUIDs. Provenance, base role and binding fields are immutable. Effective host/presenter/owner assignment lives in the authority row rather than the legacy JSON. An accepted host invite can initialise an empty host slot **only at authority revision 0**. It cannot reclaim a vacancy after transfer or revocation. Revoking an unrelated non-authority identity does not consume that initial assignment opportunity.

Every PostgreSQL writer locks the parent room row first, then reads and applies the complete operation in one transaction. Claim/transfer use CAS revision, and acting identity proof is checked again under that lock. Recovery/transfer/revoke therefore cannot overwrite each other using stale state. Read-only resolution uses a repeatable-read snapshot. The Memory adapter performs read/reduce/commit synchronously without an intervening await and clones externally returned values.

The PostgreSQL schema checks required column types/nullability, keys, foreign keys and check-constraint definitions on startup, rather than silently accepting weakened pre-existing tables. Trigger source and execution metadata are checked before reuse. Guards prevent identity rebinding/epoch decrease, recovery reset or retargeting, and authority revision decrease. Direct deletion of identity/tombstone or authority rows is blocked while their parent room exists; the normal room-delete cascade remains available.

## One-time administrator recovery

- Format: `rr2.<recovery-id>.<256-bit-random-secret>`. Only a room/tenant-bound HMAC hash is stored, with target participant, role, expiry, issuer and consumed marker.
- Maximum lifetime: 15 min. Recovery is not a rotating refresh-token family.
- Issuance records the current authority revision and target epoch. Consumption rechecks them and the target role binding before any mutation.
- Consumption of an existing active identity increments its epoch. Consumption for a legacy owner/host creates a new identity bound to the administrator-approved legacy participant ID, preserving private-note ownership. A public participant ID alone cannot do this.
- The consumed marker, identity epoch/creation and role binding commit atomically. Eight concurrent attempts with one secret yield one winner. Reuse is rejected without revoking that winner or bumping its epoch again.
- A role transfer invalidates an outstanding recovery for the former holder. Two separately issued secrets for the same old revision cannot successively roll credentials forward.
- Host recovery with no existing v2 target is restricted to authority revision 0. Frozen legacy host JSON cannot fill later vacancies after v2 transfer/revocation. Owner recovery is separately bound to the immutable personal-room owner and preserves an already-assigned host.
- Explicitly revoked identities are terminal tombstones; this recovery operation does not revive them. A fresh administrator-authorised reassignment/rebind is a separate S2b operation and must preserve epoch isolation. Do not clear `revokedAt` or recycle a tombstoned participant ID through ordinary admission.

## Single authority boundary during migration

After a room obtains a v2 authority row, generic legacy `updateRoom` cannot change tenant, room type, owner participant ID or session-control JSON. A PostgreSQL trigger protects the boundary even from an older application build and a legacy UPDATE already queued behind the first identity transaction. The Memory adapter checks the same final semantic fields before writing.

Before creating the boundary, sparse legacy session-control JSON is normalised to the existing defaults under the room lock. Ordinary name/theme/assets/features changes therefore remain usable. Temporary disable denies access while disabled; enable does not itself revoke or recreate identity. Deletion removes the entire identity namespace.

Boundary rejection is exposed by the current API as HTTP 409 with the previously published `identity_required` / `identity_upgrade_required` contract. This is a fail-closed compatibility response, not a claim that a v2 client is already available.

S2b must implement typed atomic transitions for **all** lifecycle commands, including lock/unlock, end, remove, owner/host transfer and presenter assignment. It must update live WS authority and adopt server-issued participant IDs before enabling enforcement. The legacy JSON must not become a second writable authority store. Fresh personal-owner bootstrap must be coupled to room creation; callers cannot obtain it by setting provenance on ordinary identity admission.

## Verification

The shared Memory/PostgreSQL contract covers identity spoof inputs, v1 token rejection, fresh-role resolution with unchanged credentials, CAS races, eight-way recovery, expiry/replay/cross-room checks, transfer/recovery and revoke/transfer races, metadata/lifecycle separation and cascading deletion. PostgreSQL checks additionally cover restart, injected consumption failure rollback, direct SQL immutability, weakened-schema rejection, a queued legacy UPDATE race and the pinned legacy rollback build.

API integration verifies that the boundary returns the expected 409 and still allows ordinary metadata updates. These tests validate internal primitives and schema compatibility. They do not close the original plan's public REST/WS anti-laundering, duplicate identity, waiting-room ownership or real-device acceptance gates; those require S2b and subsequent stages.

API test files run sequentially because their PostgreSQL fixtures share the existing database-wide migration advisory lock. Otherwise independent fixture initialisations queue behind each other and can exhaust an unrelated migration test's 120 s deadline. Explicit parallel transactions inside the identity and migration tests remain concurrent; their race assertions and time limits are unchanged.
