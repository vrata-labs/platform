# Room identity v2: coordinated activation contract

Status: implementation in progress after the accepted S2a foundations. This
document specifies the remaining activation work; it does not advertise a
currently available public v2 API.

## One authority

The identity authority row owns Host, Owner, Presenter and the current lifecycle
(lock/end/removal and its audit fields). Writers lock the parent room, verify the
acting identity/epoch and expected authority revision, then commit one transition.
Removal is terminal for that identity. End cannot be undone by unlock. An owner
transfer does not implicitly transfer Host or copy another participant's private
notes. A Host cannot remove the personal Owner.

The frozen legacy room JSON remains migration/recovery evidence. It is not a
second writable role store. Public room/session DTOs project the current authority
into the established participant-ID fields. Generic room metadata updates must
read the raw room record internally and must not write that projection back into
legacy JSON. Memory and PostgreSQL must implement the same rules.

## Admission and continuity

- A new client advertises `identityProtocolVersion=2`. The server assigns both
  identity ID and participant ID. A body/query participant ID is never proof.
- `ri2` proves possession of a room/tenant/epoch-bound identity; it carries no
  role. Current effective permissions come from storage on each authorization.
- V2 state sessions bind protocol version, identity ID and epoch as well as the
  room and participant. A distinct signing domain separates them from legacy
  state tokens. Neither refresh path upgrades a v1 token into identity proof.
- Presenting an invalid, expired, revoked or foreign continuity credential must
  not silently fall back to creating a fresh identity. The response uses the
  published update/recovery contract.
- Repeated admission/renewal for the same valid proof preserves the identity.
  Historical invite provenance cannot reclaim Host after a transfer.
- Existing development role-query behavior, where explicitly enabled by server
  policy, must remain visibly untrusted and must never grant plugin-author rights
  or ownership. Production admission must not trust client role claims.

### Internal V foundations and prepared client (not activated on shared staging)

The Node-only `rs2` session has an HKDF-separated signing key and carries only
tenant/room/identity/participant/epoch, session ID and timestamps. It does not
contain role or permissions. The matching `ri2` room-bound possession credential
is renewed in the tab through an explicit proof, not inferred from a v1 JWT.
The prepared runtime refreshes its session before expiry and reconnects its
room-state socket with the new token. The new HTTP admission branch is reachable
**only** after the global protocol minimum reaches 2; this is not a claim that
the shared staging floor can be raised yet.

`admit` allocates fresh IDs while holding the parent room and invitation row. A
pre-activation invitation is marked protocol 1 and cannot be upgraded to grant
Host/Presenter. New invitations are marked protocol 2 only after activation.
An old personal/legacy Host ID does not become a Host via an invitation, and a
Presenter invitation starts as Member pending a Host transition. Generic
provenance seeding remains private to storage tests and is not exposed by the
identity service. An invalid supplied credential cannot fall back to a fresh
guest identity, and a public participant ID never supplies continuity.

The waiting-room `rw2` proof uses a third HKDF domain. Its raw secret is returned
once to the requesting tab; only the room-bound hash is stored. Initial admission
creates an otherwise unusable pending request. A verifier locks the parent room,
invite and decided waiting request before single-use activation. Approval alone
does not give a room session without the proof. Open waiting entries are capped
at 8 per invitation / 64 per room; expired and consumed pending records may be
deleted without clearing a live proof or active identity. Invites and requests
are linked with room-scoped foreign keys. Admission and waiting proof cannot
be used at minimum 1. Before production activation, guest-identity retention
and per-origin rate limiting are still needed: each credential-less entry can
create a durable identity tombstone, by design of the accepted B guard.

A fresh personal owner gets a newly generated participant ID, room and
owner+Host authority in one Memory operation or one PostgreSQL transaction.
An error inserting authority rolls the entire room back. The old owner ID or
`role=host` request body is never an ownership proof. The prepared personal-room
route and button return and retain the room-bound owner proof in tab storage;
the public ID alone cannot reopen the room. An explicit administrator recovery
endpoint and cross-tab owner hand-off are still outstanding.

The internal `/api/internal/identity-session/verify` checks its authenticated
service caller, global minimum, current epoch/revocation and authority before
returning the effective role and signed scene context. At floor 2, room-state
can connect an `rs2` socket only after this call, verifies again before each
privileged command, and never applies a delayed older authority revision over a
newer one. The live role transfer/revoke path is tested with real API, room-state
and PostgreSQL in an isolated schema. The prepared runtime adopts the server ID
before joining room-state, publishing presence or using identity-bound
seating/avatar objects; a browser test covers fresh entry and reload. REST session verification,
session-control commands and the LiveKit/browser-executor namespace have a
prepared v2 branch. These pieces do not activate v2 on the shared staging host:
private-owner lifecycle, recovery, abuse controls and complete REST/write
enforcement remain part of the activation gate.

### Waiting room

An unauthenticated client must not poll somebody else's approved participant ID.
Pending admission needs a server-assigned identity and secret continuity proof.
Proof of a pending identity is not a room session: no manifest/private content,
media token, presence, author permission or WebSocket admission is granted until
approval. Admission checks the exact invite/request binding and consumes that
approval atomically, including concurrent polling. A public request ID or old JWT
does not authorize consumption. Expiry, rejection, revoke and cross-room replay
are negative cases.

### Personal owner and recovery

A fresh owner identity is created atomically with its personal room. Supplying an
existing owner ID cannot reopen that room. The creation response delivers the
owner's proof once to the authorized creator; subsequent entry presents proof.
An administrator creating a room on another person's behalf needs an explicit
owner hand-off rather than a public ID being treated as a login secret.

Legacy owners/hosts use the existing admin-only, one-use `rr2` recovery. Recovery
retains the approved legacy participant ID for existing private notes, consumes
the marker atomically and rotates the epoch. The HTTP recovery endpoint must
verify the real admin actor for issuance and avoid logging raw credentials.

## API and live room-state boundary

The common API session verifier and control-plane actor resolver must both use
fresh authority. This covers notes, documents, presence, telemetry, media/frame
tokens, invites and lifecycle actions, not only future plugin routes. Both
`POST /api/tokens/state` and `GET /api/rooms/:id/session-control` are included.

Room-state must resolve authority through the authenticated internal API on
connect/reconnect and on privileged commands; a cached role from connect is not
authorization. Unavailable authority fails closed. Live sessions must lose stale
privileges without reconnect; expired/revoked/v1 sessions close with the published
denial contract. Slow revalidation must not permit out-of-order writes, a closed
socket to rejoin, or unbounded message queues. Read-only avatar/pose delivery and
privileged effects require separate rate/queue handling, not an unbounded HTTP
request per incoming pose frame.

## Runtime adoption

Adopt the admitted participant ID before initializing identity-bound seating,
avatar, notes, presence and transports. The existing early `const participantId`
and constructor captures in `main.ts` need an explicit initialization boundary.
There must be no frame or network publisher using an unadmitted temporary ID.
Keep credentials in room-keyed tab storage, separate from public identifiers and
debug output. Refresh updates the credential without changing identity. A new
client talking to an older API follows the compatibility matrix and does not
claim v2/plugin capabilities. Recovery and update retain the S1 draft safeguards.

## Rollout and rollback prerequisite

The accepted S2a rollback image still authenticates legacy state JWTs. Its SQL
boundary protects legacy lifecycle writes, but does not make its old REST/WS
verifiers safe after v2 activation. Therefore the activation rollout must first
establish a **rollback-capable server boundary**: a legacy build encountering v2
authority must fail closed for issuance, refresh, protected REST and WS actions.
This prerequisite must be published and verified before activating new clients.
The capability becomes public only when issuance, lifecycle, HTTP/WS authority
and runtime adoption are all ready. No permanent v1 bypass flag is introduced.

### Boundary image B

The preparatory image installs the singleton `room_identity_protocol_policy` at
minimum 1. The stored minimum cannot be decreased, deleted or truncated. An
activation transaction first installs the known activated room guard and raises
the minimum to 2 under the migration advisory lock; a bare SQL raise without that
guard is rejected. Existing released guard bodies stay byte-identical at minimum
1. At minimum 2, the released pre-boundary API fails its schema guard check.

B consults the global minimum and independently rejects legacy access to rooms
that already have v2 authority. At minimum 2 it mints no session, identity,
personal-owner or media credential, and it consumes no recovery secret. Both
refresh routes and protected REST deny with the published upgrade DTO. Real
platform-admin metadata access, static pages and health remain available. A lost
policy read fails closed. Ordinary entry resumes by deploying a v2-capable image,
not by lowering the minimum.

B's room-state reads the policy through the authenticated internal API at connect
and before every effect-bearing command. Idle/pose-only sessions are checked each
second, with a five-second RPC timeout; this is a bounded six-second invalidation
window, not an instantaneous cutoff for pose delivery. Only a confirmed global
minimum ≥2 is cached. Commands keep arrival order, pending messages are bounded
to 128 / 256 KiB, and disposal prevents late admission or mutation. API outage
closes affected sockets with a retryable code; activation closes them with 4406.
API and room-state both reject missing/default production signing secrets.

The staging operator explicitly approved replacement of the development signing
key, including invalidation of old state tokens **and invite links** (the legacy
invite hash uses the same key). Manual deployment can pass
`rotate_dev_state_secret=true`. The preserved helper generates the replacement
on the staging host, changes only the development/missing key, writes atomically
with mode 0600, and never returns the key to CI. Retry preserves an already
configured key. Image rollback does not restore the development secret; old
invites must be reissued. A token signed with the obsolete development key is
classified only for upgrade denial and is never authenticated or renewed.

Rollout preparation requires the boundary capability if the minimum is ≥2 **or
any authority binding exists**, including bindings prepared at minimum 1.
Staging uses the target commit's `identityProtocolFloorGuard` contract before
checkout/rollout and before rollback; its policy lookup works while the API is
down. It also checks matching configured API/room-state signing secrets before
changing services, without printing the values. Production/self-host
`rollback:compose` checks the persistent policy and both target image labels
before editing its env file. Protected rollbacks require immutable full SHA tags.
The supplied probes require the API URL to match the bundled PostgreSQL database,
role and default namespace; external/custom-schema configurations fail closed and
need a matching policy probe instead of treating an unrelated empty database as
minimum 1.
For a direct production/self-host image change, run the same preflight first:

```sh
node tools/identity-rollback-guard.mjs --env-file infra/docker/.env.production --compose-file infra/docker/compose.production.yml --image-tag <full-sha>
```

Both API and room-state images must carry `io.vrata.identity-protocol-floor-guard=1`.
Raw Docker commands that bypass the supplied preflight are not a supported v2
rollback procedure. A database restore is a separate destructive operation: the
T15 restore procedure must retain the protocol floor and compatible images and
address restored credential epochs; image rollback does not lower the floor.

### Activation prerequisites for V

V must raise the persistent minimum before accepting admission or creating the
first public v2 binding. Its lifecycle rules enforce saved end/removal decisions
independently of UI feature flags. Before raising the floor, inspect legacy
lifecycle data in any deployment where host controls had been disabled; silently
clearing an old `endedAt` is not an accepted migration.

The full activation must also isolate old downstream media credentials. Legacy
LiveKit credentials are not invalidated by a room-state close; a versioned media
room namespace (and the corresponding remote-browser media binding) or another
verified server-side admission boundary is required before claiming that legacy
identities cannot impersonate participants in a v2 meeting. This is activation
work, not a guarantee provided by the preparatory B image.
Remote-browser frame signing uses a separate key. New staging defaults must never
copy the state-session signing key into that executor; existing frame-key
configuration and already-issued downstream credentials need their own checks
during V activation.

Before activation, test that the exact rollback image rejects legacy elevation
against a database that has crossed the v2 boundary, preserves room materials,
and permits a return to the v2 image. Merely testing SQL immutability or a green
health endpoint is not sufficient for this authentication rollback contract.

## Acceptance

Public API/WS tests must cover victim-ID spoofing (guest, invite, waiting-room and
owner), both v1 refresh paths, real recovery success and replay, owner bootstrap,
reload/reconnect, Host transfer, Presenter changes and live stale-socket denial.
The shared storage suite covers concurrency, epoch/revision and migration. The
client suite covers ID adoption before first publish, tab/room isolation, late
responses and drafts. Activation requires final local E2E, CI/image publication,
exact-SHA staging verification and recorded rollback behavior.
