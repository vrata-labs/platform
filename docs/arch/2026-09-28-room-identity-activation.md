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
be used at minimum 1. Every new v2 admission consumes a persistent,
privacy-preserving origin budget shared by all API replicas: 180 new room
entries/minute and 3,000/day, or 20 personal rooms/hour and 100/day. A valid
identity proof, approved waiting proof and administrator recovery do not
consume this new-identity budget. Caddy overwrites the client-IP and proxy
authentication headers; the API trusts this address only with a separate
32+-character `VRATA_IDENTITY_PROXY_TOKEN` and otherwise hashes the direct
transport peer. It never stores the raw address. Staging provisions this token
idempotently on the host before rollout without publishing or rotating it on
retry. It does not share the room-state service token or state JWT key. A custom
reverse proxy must provide the same verified
peer boundary; without it, all clients behind that proxy share one budget.

The B rollback contract prohibits deleting identity rows while their room
exists. Thus v2 caps each room at 10,000 durable identities and 50,000 total
waiting entries; renewing an existing proof works at capacity. Closed admission
windows are pruned, while identity and waiting records remain until their room
is deleted. Operators must replace or retire a room before its lifetime cap;
silently purging an identity with a live possession proof would break continuity
and rollback guarantees. A long-lived-room archival policy remains part of
the full activation review.

A fresh personal owner gets a newly generated participant ID, room and
owner+Host authority in one Memory operation or one PostgreSQL transaction.
An error inserting authority rolls the entire room back. The old owner ID or
`role=host` request body is never an ownership proof. The prepared personal-room
route and button return and retain the room-bound owner proof in tab storage;
the public ID alone cannot reopen the room. A current owner or administrator
can explicitly hand off ownership to another proof-bound identity already
admitted to the same personal room.

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
complete effect-bearing REST/media enforcement and room archival policy
remain part of the activation gate.

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
At floor 2, the recipient first joins that private personal room via a v2
invitation and receives its own room-bound proof. The administrator or current
owner then submits `POST /api/rooms/:id/owner/transfer` with that recipient's
server-issued participant ID and the current authority revision. The parent
room lock and CAS recheck that both actor and recipient remain active and
room-scoped. The owner slot changes atomically; the independent Host slot is
not silently transferred. A Member who owns a personal room can use its room
controls through current ownership authority, not a forged Host role. The
former owner loses private owner access even if its old session is still valid.
Missing/stale revision, unknown or cross-room IDs and an old owner's second
transfer are rejected. An owner may be offline after accepting the invite;
an administrator's authenticated hand-off does not require live presence.

Legacy owners/hosts use the existing admin-only, one-use `rr2` recovery. Recovery
retains the approved legacy participant ID for existing private notes, consumes
the marker atomically and rotates the epoch. The HTTP recovery endpoint must
verify the real admin actor for issuance and avoid logging raw credentials.

The prepared route is `POST /api/rooms/:id/identity-recovery`, authenticated
only by the control-plane administrator token. The administrator supplies the
current legacy `participantId` and `role=host|owner`; storage checks the room,
role binding and authority revision. A ten-minute `rr2` proof is returned once
with `Cache-Control: no-store`, then delivered to the intended person outside
the app. The person pastes it into **Recover room access**, which makes an
explicit proof-only `POST /api/tokens/state` and reloads after saving the new
room-keyed identity in tab storage. Never put the recovery code in a room URL,
invite or diagnostic report. Replay, expiry, wrong-room redemption and a copied
public participant ID are denied in the isolated PostgreSQL/browser checks.

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

### Prepared REST effect boundaries

Request-entry authentication is not a commit fence: body parsing, document
inspection, S3 and local JWT signing can outlive a role or epoch change. For
v2 note save/delete/restore and document publication/surface binding/deletion,
the prepared API rechecks current permission and session expiry under a short
parent-room `FOR SHARE` transaction at READ COMMITTED. Identity writers take
`FOR UPDATE` on that same room. Both the authority read and DB mutation use
one connection and one transaction; no second pool connection is required.
The callback exposes only the DB methods supported inside this fence. Memory
uses a synchronous check followed by the synchronous in-memory mutation.

Upload object I/O runs before the DB fence; denial rolls back publication and
attempts removal of the unreferenced object. For both protocols, document deletion
first commits a tombstone, then runs room-state/S3 cleanup outside the fence.
A cleanup failure returns 503 but no longer exposes document content; an
authorized Host or administrator can retry DELETE on the retained tombstone.
This does not implement a background orphan collector.

Media/frame tokens are signed privately, then re-resolved against fresh
authority immediately before release. A revoked epoch or changed role/owner
discards the prepared token. Executor media also rechecks room lifecycle and
live executor binding. Open frame sockets close when their token expires,
including early-timer rescheduling, and must obtain a newly authorized token.
An already-issued self-hosted LiveKit JWT is **not** revoked by these checks:
participant removal does not invalidate it, and LiveKit proactively refreshes
connected participants' tokens. Current source grants, server-side participant
eviction/rejoin enforcement and expiry in the remaining lifecycle mutations
still require an explicit activation gate.

### Prepared personal-state and private response release

Personal state follows the room's current owner authority. The dedicated GET
and PUT recheck `ownerOnly` under the parent-room fence; PUT takes
`FOR NO KEY UPDATE` before reading authority and updates only `personal_state`
on that same connection. The scoped updater rejects invocation under a shared
fence. Other room PATCH operations retain current personal state unless an
explicit state patch was requested, avoiding lost owner writes from a stale
metadata snapshot. Generic room metadata/open/reopen/bind responses exclude
`personalState` for room sessions, including owners; verified administrators
retain their administrative access. Owners use the dedicated endpoint.

Notes and exports prepare data outside the fence, then recheck the live proof
and `notes.view` immediately before synchronous response release. Private notes
remain participant-bound, independent of personal-room ownership. Documents
load object bytes outside the fence, then recheck permission, tombstone and,
for surface content, the current surface/kind on the fenced connection. No
transaction waits for S3 or network flush. Once bytes were queued while access
was valid they cannot be recalled; a later revoke is ordered after that release.
After-send commit failures cannot write a second response or be audited as an
authority denial. The held-room HTTP tests wait for actual database blocking
before changing owner/epoch/tombstone/surface, and check that denied responses
contain neither the prepared private data nor attachment headers.

### Prepared scene, presence and invitation metadata fences

Host-controlled metadata now uses a fresh Host-or-Owner predicate, independent
of a cached HTTP role. A personal Owner admitted as Member can still bind a
scene and manage invites/waiting requests; a former Host without ownership
cannot. The scene setter changes only its URL and the derived roomConfig URL,
not status/visibility or immutable template versions. It checks reference
template restrictions and the current template CAS on the fenced connection.
The persisted snapshot and Memory projection stay consistent. Parent-room
writes take the no-key-update lock up front, with no S3 or asset fetch inside.

Manifest and presence reads revalidate identity/protocol authority at response
release; legacy visibility/disabled checks still use the earlier room snapshot.
Presence PUT
updates the process-local map synchronously inside the fence using the fresh
role/permissions and server-owned participant ID/time. A role demotion alone
does not invalidate identity or force recovery. Remove/end cannot be followed
by an old request resurrecting presence. Self-only DELETE stays a cleanup action.
This is a single-API map; distributed presence and load under a larger topology
need separate validation. The eight-participant HTTP burst checks progress, not
a performance SLA or a claim of cross-replica consistency.

Invite/waiting lists, revocation and approval/rejection use the same fence and
connection, including finalized-decision retry. Repeat revocation retains the
original actor/time. Existing invite creation keeps its own atomic authority
check.

### Prepared session expiry at the mutation boundary

Every room-session mutation actor carries a required server-derived
`expiresAtSeconds`, distinct from the durable identity credential. Lifecycle
and invite routes construct it from verified v2 HTTP context, never from body
fields. Transition checks use the one reducer-time clock sample after loading
under the parent-room lock; the load-time pending-capacity timestamp is not an
authorization clock. Invite checks and createdAt use the injected clock sampled
after all awaited authority reads. PostgreSQL permission/expiry failures use
typed storage errors, matching Memory instead of turning an access denial into
500. Exact expiry is denied; administrator actors have no room-session deadline.

Late expiry yields `identity_session_expired` with HTTP 401, including fenced
private responses. It does not revoke identity or consume recovery: an active
RI2 proof can issue a new session. Error precedence keeps a blocked room blocked,
and expiry precedes authority-revision conflict in a transition. The HTTP tests
use otherwise-valid commands/live revisions and also send a forged future body
deadline, proving that stalled body and lock waits cannot extend the session.
Entry, lifecycle/invite and effect-fence 401 responses now use
`error=identity_session_expired`; entry/effect responses also include
`reason=identity_session_expired`, while lifecycle/invite responses may omit it.
A MAC-verified,
correctly scoped expired RS2 is classified only after checking current identity
epoch and room authority; it never becomes an authenticated request context.
Bad MAC, wrong scope, removed identity and stale epoch retain recovery refusal.
Current clients do not interpret renewable expiry as a recovery gate; a shared
retry-on-expiry client policy remains separate work.

Legacy floor1 requests admitted before
cutover use the prepared policy-row fence for the scoped callbacks below;
entry checks alone do not close the remaining unscoped paths. RI2 claimHost/transferHost
helpers now carry the original credential deadline into the locked reducer, but
remain unwired; adding routes still requires their complete actor/admission contract.
Media and other activation gates remain open; this slice does not raise floor 2.

### Original possession deadlines across awaited reads and mutations

RI2 renewal in the prepared `POST /api/tokens/state` path captures the original
MAC-verified expiry before awaiting storage. If that deadline passes during pool
acquisition or the authority read, renewal fails with `identity_not_active` and
HTTP 409 `identity_recovery_required`, without issuing a fresh identity/session.
It does not revoke the underlying identity or rotate its epoch. This differs from
RS2 session expiry, which remains HTTP 401 and can be renewed with independently
valid possession proof.

`renewCredential`, `issueSession` and paired `renewSession` check their original
deadline(s) after the awaited read, using one final clock sample for both validation
and synchronous signing. Paired renewal preserves the session ID and requires both
original RI2 and RS2 deadlines. Resolve-only helpers return null rather than an
expired authenticated snapshot; HTTP session resolution retains its current-epoch
expired-session classification. An altered storage argument cannot widen the
original captured expiry.

Host claim/transfer storage commands require a deadline-bearing proof. They copy
the original proof primitives before waiting, then check possession expiry inside
the synchronous reducer after the parent-room load/lock and before CAS or mutation.
Exact expiry is refused; expiry takes precedence over a stale revision, while a
blocked room retains its existing refusal. There is no post-COMMIT denial of an
already-authorized mutation. Missing deadlines do not mean unlimited lifetime.

These checks do not supply new HTTP endpoints, solve administrator legacy owner
seeding/PATCH, change media credential expiry, or activate the shared floor 2.

### Prepared legacy policy fence (bounded coverage)

Non-administrator v1 room effects now lock the existing room first, then the
protocol policy FOR SHARE at READ COMMITTED. The same connection checks floor 1
and absence of identity-authority bindings before the DB-only callback. Raising
the floor takes a bounded EXCLUSIVE policy-table lock before updating the row,
so new readers queue behind activation rather than starving it. A reader that
waits sees the committed v2 policy and fails with upgrade refusal. The operation
never holds this fence during body parsing, S3 or room-state RPC.

Only whitelisted DB methods and synchronous releaseResponse are exposed at
runtime. Memory rechecks each operation/release after await gaps; PostgreSQL
callbacks use the held connection and an explicit legacy waiting-decision mode.
Facades expire after the callback and disallow operations after response release.
Pool acquisition failures, recognized lock/connection errors and uncertain
COMMIT outcomes are retryable 503, distinct from business conflicts; other
pre-COMMIT transport errors are not claimed universally normalized.
The idle backend timeout has a checked-out-client listener and destroys failed
connections; a dead fence cannot send a response after observing that failure.

Coverage is the existing notes/document publication/surface/private-state
callbacks, invite/waiting lists and decisions, scene binding, and ordinary
manifest/room/presence write/release branches (including anonymous readers of
existing rooms). Anonymous bound-room reads were already rejected at entry;
this also closes a request that became bound while in flight. A missing-room
manifest is built from the same checked snapshot, including explicit null, and
never substitutes a new private record via a second read. Virtual v1 fallback
presence now uses the separate virtual effect and live namespace described below; a cached v2
request whose room disappeared returns 404 rather than that fallback. Response audit
records successful release even if COMMIT subsequently fails; that operational
failure is not a retroactive authority denial. Administrators retain their explicit
bypass. Legacy owner/host TOCTOU within floor 1 is not identity-v2 security.

Upload compensation must not equate a missing COMMIT acknowledgement with a
confirmed rollback. After explicit COMMIT starts, unknown client/TLS/proxy/read
timeout failures preserve the blob; only a real server rejection proves failure.
Administrative autocommit document writes carry the same uncertainty marker.
HTTP error mapping retains its cause, returns 503 and increments the uncertain
upload metric. A possibly committed row must never point at a compensatingly
deleted file. An unreferenced retained object needs later reconciliation; this
does not add a background orphan collector or automatic retry/idempotency.

Before activation, remaining gates are downstream credential/source grants,
frame credentials/TTL, bootstrap reconciliation/retirement and the other media obligations
above. Administrative legacy owner evidence is fenced by the creation contract
below; the whole cutover is still not ready.

### Prepared document deletion and personal bootstrap

DELETE now commits one authorized tombstone intent for every protocol, then
performs media/blob cleanup without a fence. A failed cleanup returns 503 but
the document remains hidden; a later authorized retry reads the marker under
the fence. Concurrent retries do not overwrite deletion provenance or count
another transition. Once intent committed before cutover, its cleanup may finish
after activation; a new legacy retry must still pass the new policy. Uncertain
commit or authority denial never starts cleanup. Operators may retry hidden
documents; no background cleanup job or purgedAt lifecycle is claimed.

Legacy personal creation takes a rooms ROW EXCLUSIVE relation lock before
policy FOR SHARE, requires floor 1 and performs current-template lookup/INSERT
on that same connection. A competing deterministic ID reopens the same-owner
room after a savepoint rollback; a different owner/tenant/type remains a conflict.
Reopen and new-room replies prepare their manifest outside locks, then check
current owner/type/tenant/disabled and policy/binding at synchronous release.
Creation committed before raise can leave an ordinary unbound legacy room, but
it cannot emit an old-owner reply after raise or create one after the v2 boundary.

V2 owned bootstrap uses the same relation/policy order and single-client template
path, then atomically inserts room/identity/authority. Lost commit returns 503
without an identityCredential; possible orphan room and duplicate retry remain
an idempotency/reconciliation obligation. Administrative provisioning follows the
separate metadata-only creation and invited-recipient handoff contract below.

V2 personal reopen now verifies the original RI2 possession proof, then rechecks
room type/tenant, lifecycle, current Owner and epoch under the parent-room shared
fence. Renewal signing and response release are synchronous with that checked
state, using the same PostgreSQL client. The original credential deadline is
checked after lock waits; a prepared reply cannot extend an expired proof or
return private metadata to a former Owner. Disabled/end return 403 without
turning a still-valid credential into a recovery requirement.

### Administrative provisioning and frozen legacy evidence

The authenticated control-plane create path uses `createAdministrativeRoom`.
At floor 1 the existing owner/Host/Presenter metadata seed remains compatible;
different room IDs with the same owner do not deduplicate, and an existing slug
cannot be overwritten. At floor 2 non-null raw owner/Host/Presenter seeds fail
with the existing 409 upgrade contract. Standard rooms and private personal rooms
without an owner are permitted. This response is an administrative metadata receipt,
not an identity grant: no identity, Owner or Host slot is automatically created.

PostgreSQL takes the rooms relation ROW EXCLUSIVE lock before policy FOR SHARE,
then current-template lookup and conditional INSERT use the same borrowed client.
The policy read at this boundary is authoritative; a body/draft flag cannot relax
it. Creation waiting behind activation sees the new floor and rejects legacy seeds.
A creation committed before activation may return its admin metadata receipt later;
manifest preparation is outside the fence. Unknown COMMIT returns 503 without a
room/proof success body. A possibly committed row is retained and can be reconciled
through admin GET; no automatic retry or false rollback is claimed.

At floor 2 the intended recipient joins the ownerless private room through a v2
Member invitation. The administrator explicitly transfers ownership to that
server-issued, room-admitted participant using the current authority revision.
The recipient remains Member with current ownership authority; the independent
Host slot is unchanged. Public IDs are not login proofs, and `rr2` is not used to
manufacture new legacy owner evidence after cutover.

Template materialization has a separate server-only nullable-owner allowance;
missing/null owners are accepted only on the permitted path, malformed non-null
IDs remain invalid. An ownerless persisted personal reference remains editable
before and after handoff without putting authority into immutable template hashes.
Private visibility, guest denial, locked assets and template binding are preserved.

Existing Memory and PostgreSQL PATCH guards already freeze persisted legacy tenant/type/
owner/session-control changes at cutover; their published 409 contract is retained.
Metadata-only PostgreSQL updates no longer rewrite frozen type/owner/control from
a prior snapshot. Unrequested protected type/owner/session-control and personal-state
columns retain the current stored values, including sparse legacy JSON, and the
returned DTO uses those actual stored values. Other metadata retains its existing
last-writer behavior. If the
room type changed after reading the snapshot, an original-type CAS rejects the
stale write with the existing 409 binding conflict; a fresh retry constructs
consistent visibility, guest access and roomConfig. Explicit normal type changes
compare against the original type rather than the requested final one.

The existing control-plane form consumes an optional authenticated protocol hint,
defaulting to floor 1 for an older API. In v2 it sends a null owner, displays the
explicit handoff guidance and creates a Member invite. Automatic and manual/retry
invitation paths share this recipient policy, including after a follow-up failure
or invite expiry. The administrator item GET additionally supplies a read-only
currentOwnerParticipantId from v2 authority (the raw frozen owner stays unchanged).
Selection/polling and invitation actions refresh this context; once ownership is
assigned, ordinary invitations return to the prior Guest default. Explicit admin
Member invitations remain supported. The field is not added to public/session
responses or the room list. A stale v1 draft refreshes
the hint after server refusal without auto-resubmission. Follow-up failure after
201 is reported as follow-up failure, not failed creation. The hint is not authority;
the server creation fence remains mandatory. The ownership transfer API exists;
this slice does not add an automatic ownership transfer or a new transfer panel.
Already-issued invite links survive sanitized list refreshes only in page memory
for the same live invitation in the same room; revocation/expiry/room change removes
them. The server does not reissue secrets, and no browser-state persistence is added.
An unavailable list read keeps current invitation metadata; rendering independently
removes secret links whose known expiry has passed. Its old cached
snapshot is not replayed as fresh data over a newer external revocation. A delayed
create acknowledgement cannot undo revoked metadata already observed for that ID.
Successful list reads also share a request sequence across polling/access refresh;
an older success cannot overwrite a newer applied list from another-tab revocation.
Room metadata presentation has the same successful-read ordering; delayed polls
display Owner from the currently accepted room rather than their earlier local copy.
Confirmed create/revoke advances a local invitation mutation revision; a list
read before that revision is discarded and refreshed. Revoke immediately applies
the returned revoked metadata and removes the secret link, so failed follow-up
reads cannot undo the confirmed result. The chosen invitation is captured before
rendering and stays selected. The readonly owner presentation is stripped from
untrusted create/PATCH input and common room DTOs before the admin item projection.
Update remains disabled until normal selection has initialized the editable form
for that room/generation. A poll may update metadata but cannot enable a form that
still contains the previous room's fields. The handler enforces the same readiness
check, and a completed PATCH does not reselect a room the administrator left.

Known separate metadata issue: PostgreSQL generic tenant PATCH can report a changed
tenant in its DTO without moving the stored row when no authority is bound. This
pre-existing false-success/parity defect is not fixed by provisioning; it is not a
tenant migration feature and remains an activation/metadata obligation.
Likewise, generic metadata PATCH and concurrent disable/enable can overwrite each
other's unprotected metadata/status snapshot. This pre-existing concurrency issue
is separate from the protected identity-column preservation described above.

### Persisted diagnostics and XR telemetry

For a persisted room, POST diagnostics and PUT XR telemetry carry the original
verified session into the existing room effect fence. PostgreSQL INSERT and
retention DELETE use the same borrowed client as the parent-room lock. Persisting
callbacks select the upfront write-lock mode so concurrent writers cannot delete
the same oldest snapshot row and exceed the retention cap; idle XR keeps shared
mode. The lock pins role, epoch and lifecycle; the original session deadline is checked before
each scoped operation and after an awaited write callback, before COMMIT. An
authorized read that already synchronously released its response is not denied
again after sending it. No network or blob operation is added inside this fence.

Memory stages cloned diagnostics and XR records per callback, preserving write
order and event creation time. Callback failure or a failed final original-authority
check discards the stage. A successful stage appends synchronously onto the current
arrays, applying the existing 200-diagnostic/1,000-XR retention without replacing
another callback's committed records. This staging covers telemetry, not rollback
of every other Memory effect.

Diagnostic logs, counters and the screen-share session projection are published
only after successful persistence. XR updates use a FIFO per room/participant;
classification uses the last committed predecessor, and live/latest/history are
updated only after a successful fence. Idle updates still authorize at queue head
without persisting another event. Pending work, including the active call, is
bounded to 32 per participant, 256 per room and 512 per API service; overflow returns HTTP 429
`xr_telemetry_queue_full`. A failed call releases capacity and does not poison its
successor. Payloads and commit callback records are separate private clones.

Ready pair heads take one room turn and one of two API-service execution slots
before the callback can borrow a database connection. A room runs one telemetry
callback at a time; other participants' ready heads can run before that same
participant's next queued sample. Waiting samples do not occupy database clients.
The production API has one telemetry service per process, so at most two of its
telemetry callbacks hold or wait for pool connections. Authority and the original
deadline are still checked after this wait. Failure releases both scheduling
levels. Runtime sampling is unchanged; bounded overload returns 429 and may drop
telemetry samples rather than consuming the entire shared database pool.

HTTP write success completes the already-authorized committed operation; it does
not grant new access and does not acquire a second fence after COMMIT. A rejected
or unconfirmed COMMIT returns failure without publishing in-process success
projections. A genuinely lost acknowledgement may still leave durable rows;
neither an error response nor the absence of a live projection proves rollback.

GET XR history prepares its private snapshot outside the lock, then synchronously
releases it under fresh current Host or personal Owner authority and the original
deadline. Verified administrator access remains a separate bypass. Identical live
and PostgreSQL jsonb copies deduplicate independently of object key order,
including nested objects; distinct values, array order and same-time events remain
significant. Existing 80-event history and latest-selection rules are preserved.

These persisted paths are complemented by the virtual data-effect boundary below;
token issuance and other activation gates remain open.
The shared staging minimum remains 1, with no new authority binding.
Room deletion currently does not purge persisted diagnostics/XR rows or the live
XR projection. Per-room write retention does not trim deleted random room IDs.
Round-trip acceptance removes its room, tenant and invitation but retains one row
in each telemetry table; room retirement needs a separate retention/cleanup policy.

### Virtual-room data effects

An absent room ID remains a supported floor-1 fallback, but it does not confer
authority on a persisted room. `withLegacyVirtualRoomEffect` checks floor 1,
absence in every tenant and absence of authority bindings. Its frozen narrow
facade permits telemetry writes in write mode, or one synchronous terminal
response/map release in read mode; it never creates a room. Arguments stay bound
to the captured room ID. The original MAC-verified legacy session expiry is copied
before waits and checked at effect entry, each operation and before write COMMIT.
Malformed deadlines are not an unlimited lifetime. An appearing persisted room
returns retryable 409 `room_state_changed`, expiry returns 401, and cutover returns
the existing upgrade refusal. Unavailable fences/unknown COMMIT return 503.
Virtual-data route room IDs are bounded to 1–200 characters without controls before
session/boundary/database lookups. Invalid IDs or malformed path escapes return
bare 404 `room_not_found`, not an internal failure or a response containing the input.

PostgreSQL virtual writes take a short rooms relation SHARE lock before policy
FOR SHARE, ordering against all room INSERT paths. Same-room telemetry uses a
transaction advisory lock to serialize INSERT/retention, on that same borrowed
client. The relation lock temporarily blocks other room writes; no body parsing,
blob operation or network request belongs inside it. Non-writing presence/poll
effects take rooms ACCESS SHARE before policy FOR SHARE, matching schema init's
rooms-before-policy order without blocking ordinary room writes. They take one
absence observation and do not pin
absence against a later INSERT and may release only separate virtual state, not
persisted-room data. Memory rechecks state around operations and stages telemetry
until successful final validation. Unawaited SQL is drained and rejects the callback,
so it cannot continue after transaction closure. A timely terminal read release is
not denied retroactively after a later await or clock advance.

Virtual presence and XR live buffers are separate from persisted-room buffers.
Presence PUT/DELETE publishes or removes only inside the appropriate synchronous
effect release. Persisted presence DELETE is now fenced as well. Virtual XR uses
the same commit-first FIFO pipeline as persisted XR: no live/history projection
is applied after rejected or unconfirmed COMMIT. Both namespaces share one backend
scheduler, preserving the existing 32-per-pair, 256-per-room, 512-per-service limits,
one executing callback per room and two execution slots across the API. Aggregate
presence metrics include both live namespaces.

Anonymous/legacy missing-room manifest and presence reads release under the virtual
floor fence; verified administrators keep their explicit bypass. Missing-room XR
history is not released to a formerly trusted Host whose room was deleted; after
the ordinary permission check non-admin access returns 404. Admin history access
retains DB/virtual diagnostics. A cached v2 session whose room disappears receives
the existing fail-closed refusal rather than a v1 fallback.

This data-effect boundary is complemented by the virtual state-token release below.
Downstream frame/media credentials, bootstrap reconciliation
and retirement remain gates. Diagnostic/XR rows written before a room is created,
or retained after deletion, still use the same database room ID; later authorized
admin/Host readers can observe them. Durable row cleanup/namespace retirement is
not provided by live-buffer separation and must be resolved before full activation.

### Virtual legacy state-token sign and release

At floor 1 an absent-room `POST /api/tokens/state` now uses an explicit
`pinAbsence` mode. It is a read-only credential release: no telemetry writes,
exactly one synchronous release, and no successful callback result without release.
The original mode flags are captured before pool/lock waits; `pinAbsence` cannot
be combined with `roomWrite` or silently downgraded by mutating caller options.

PostgreSQL issuance takes rooms SHARE before policy FOR SHARE, preserving schema
init's lock order and excluding every room INSERT, in every tenant, until release
and transaction completion. Ordinary virtual presence/poll reads still take ACCESS
SHARE. Memory checks current floor, binding and any-tenant room absence immediately
before the synchronous release. A room created while issuance waits causes 409
`room_state_changed`; a floor increase causes the existing upgrade refusal.

The handler validates floor-1 body/claims before room and binding lookups, preserving
nullish room/participant/display defaults. Invalid room IDs receive bare 404, invalid
participant/display values receive 400 `invalid_state_token_request`. The v2
admission branch and its refusal classification are unchanged. Virtual issuance
does not fetch scene surfaces, create a room, trust an Owner or mint a v2 identity.
Default Guest and explicitly enabled dev-query provenance retain their prior meaning.
Captured primitive claims are signed inside the one release using its current clock,
so asynchronous admission waits do not consume the newly issued token's lifetime.

The broad SHARE lock is limited to this short sign-and-release; body parsing and
network preparation must remain outside it. The existing bounded lock timeout is
retained. A response signed/released under the pin is not retroactively withdrawn
when the read-only transaction's COMMIT acknowledgement fails afterwards.
The virtual issuer marks completion only after its synchronous send returns. A
subsequent fence-completion failure is counted by the fixed, unlabelled
`vrata_api_virtual_state_release_completion_failures_total` counter; it neither
destroys the queued reply nor increments request failures. Pre-send/sign/send errors
still propagate normally. No arbitrary driver message, cause or credential is logged
by this completion path, and database resource cleanup still finishes normally.

This closes in-flight virtual mint/release races. Persisted issuance/renewal uses
the read-only snapshot boundary below, and its admission writes use the guarded
commit boundary that follows. Frame/media, bootstrap reconciliation and durable
retirement remain gates. The shared floor 2 is not activated.

### Persisted legacy state-token sign and renewal

Both persisted-room `POST /api/tokens/state` and legacy room-session
`GET /api/rooms/:id/session-control` release credentials through
`releaseLegacyRoomCredential`. PostgreSQL holds the parent row FOR SHARE, then
policy FOR SHARE, then the exact invite and waiting rows FOR SHARE, on one borrowed
client. Child locks also order against admin autocommit revoke/decision updates.
The method exposes one fresh snapshot to one synchronous callback, no DB/network
callback or write. Memory reads and clones all three maps and invokes the callback
in the same synchronous turn, without an await between fresh authorization and send.

The pure validator covers existing bearer, public/default admission, the raw legacy
personal-owner compatibility path, an invite and an approved waiting request. One
participant ID is chosen for every check, waiting row and token: explicit body ID,
otherwise the valid scoped bearer's ID, otherwise one UUID. An explicit different
subject, invalid MAC or unsupported legacy subject never inherits a bearer's role.
An authentic expired MAC is refused with the existing v1 401
`session_token_invalid` / `expired_token` on POST and at the late GET check,
including foreign-scope expired proofs; the codec checks expiry before scope.
GET retains `unauthorized` / `expired_token` when its entry actor check refuses an
already-expired proof. No silently renewed default Guest is created from it.

A private/personal room requires trusted legacy provenance for bearer renewal;
default/dev-query virtual or public tokens need independent fresh admission. A
legitimate private Guest admitted by invite remains trusted and can renew. This is
floor-1 compatibility, not v2 identity/Owner proof. Raw personal Owner admission
keeps its existing floor-1 semantics and remains independent of Host assignment.

The initial decision freezes its source, role, provenance, subject and scene/template
binding. Network surface preparation is outside locks. The final callback rechecks
the original MAC, deadline, current room/lifecycle, invite revocation/expiry and
waiting decision. It refuses any role/source/binding drift with a scalar conflict.
Every allowed token is signed from fresh data at the callback's current clock,
including the old no-Host/Host-claim branch. GET preserves its session ID and obtains
current surfaces instead of copying them indefinitely from the old token. Blocked
GET replies preserve the existing 200 blocked/no-token shape; expiry or wrong scope
never receives room state from the final callback. Admin and v2 GET flows retain
their existing responses.

Successful legacy URL-manifest loads are shared between POST and GET for five
seconds, with one in-flight load per normalized URL. The resolver is bounded to
128 successful entries and 128 distinct pending fetches; caller surface arrays are
separate copies. A valid manifest without surfaces is an intentional empty success,
distinct from timeout/HTTP/parse/capacity failure. Failed or expired successes are
not used as stale grants. A confirmed bearer renewal returns retryable 503
`scene_media_surfaces_unavailable` without a token on load failure; it does not
erase a formerly issued surface claim or count a successful admission. Cold fresh
legacy admissions retain the prior no-surface fallback. Existing reference contexts
require no manifest fetch, and rebound URLs use a new cache key.

The release selector preserves any string tenant key already accepted by the saved
legacy catalog. It imposes no new tenant-length limit; exact saved tenant equality
still bounds the room and child-row reads. Room and subject IDs retain their existing
supported namespaces.

Successful sends are terminal even when the subsequent read-only COMMIT fails:
`vrata_api_legacy_state_release_completion_failures_total` records the operational
failure without destroying the queued reply or counting a failed request. Errors
before/during send still propagate. Allowed invite audit and personal opens are
counted after the actual release; no raw bearer, invite or driver cause is emitted.

The Host claim and pending waiting request now commit through the guarded write
below before any receipt or read-only credential release. A token denied after a
successful claim COMMIT may still leave the earlier authorized claim persisted.
Existing trusted proofs across same-ID room recreation, invite revocation of
already-issued tokens and a virtual token's public-room lock bypass remain
legacy-compatibility gaps. Shared floor 2 and frame/media/bootstrap/retirement work
are not completed by these floor-1 compatibility boundaries.

### Guarded legacy admission mutations

`writeLegacyAdmission` handles only a conditional first Host claim or a canonical
pending waiting row. The initial pure plan freezes request/subject, source/binding,
mode and the source's original expiry before pool waits. A separately MAC-verified
presented bearer contributes only its own expiry, even if its scope/role does not
authorize the selected invite. No unchecked bearer field supplies identity or role.
Fresh invite expiry may shorten that pair, never extend it.

PostgreSQL takes the parent first: FOR NO KEY UPDATE for a Host claim, FOR SHARE
for pending; then policy FOR SHARE, invite FOR SHARE and waiting FOR SHARE on one
client. Memory checks, decides and publishes one staged map mutation synchronously.
The callback receives fresh clones and the store's instant, returns a closed pure
intent, and cannot supply a new Host or waiting ID. Promise/unknown/wrong-mode
answers reject before a write. Source, role, lifecycle, binding or approval drift
gets the existing refusal, never a hidden grant or reset of a decided request.

Host SQL updates only `hostParticipantId` if missing, null or empty; it never copies
a stale full `sessionControl`. Every other control key and room column is preserved.
The same subject's already-held seat is idempotent; another winner is a conflict.
Pending INSERT fixes status to `pending`, uses the natural `(inviteId, participantId)`
key and `ON CONFLICT DO NOTHING`, then reselects/re-decides once if necessary.
Existing display name, status and decision metadata are never overwritten. Existing
pending202 replies also take the fresh guard instead of returning a cached request ID.

Both immutable leases are checked before decision/SQL and after SQL. An optional
synchronous `roomFenceTransaction` before-COMMIT hook checks them once more after
the effect's await boundary and immediately before dispatching COMMIT. Its default
is absent for all older callers. A lapse throws before COMMIT and rolls back the
write; the COMMIT round trip may finish after its already-authorized dispatch.
There is no new check after an acknowledged COMMIT that retroactively denies a receipt.

Only a known COMMIT ACK yields pending202 or a ready-Host receipt. Every credential
still requires the independent fresh read-only release afterwards. Unknown ACK,
connection/fence failure or actual rejected COMMIT gives a fixed503 without token,
pending ID, successful receipt or raw driver cause. No blind write retry or guessed
successful publication occurs. A fresh authenticated retry with the same normalized
subject reconciles to its own existing Host seat or canonical pending row; expiry,
revoke or new authority still refuses it. A wholly anonymous retry omitting both
subject and bearer generates a new subject and cannot reconcile the earlier write.

Known authorized writes can remain when a subsequent floor increase refuses token
release. Successful receipts, audits and pending counters follow their own ACK,
not the initial permission check. No v2 identity or authority binding is introduced
by this floor-1 path; downstream source grants, bootstrap and retirement remain gates.

An adjacent pre-existing writer remains a separate obligation: legacy administrative
lock/unlock/end and other control actions can still replace the whole `sessionControl`
from a stale read. A lock that read an empty Host before this transaction can wait
for its COMMIT and erase that newly assigned Host afterwards. Admission's minimal
CAS prevents its own overwrite, not every later control writer. Those legacy control
mutations require atomic field updates or fresh recomputation under a parent lock
before full activation; this gate does not claim they were changed.

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

### Nullable-owner reference reader baseline

Personal reference provisioning stores a null legacy owner permanently, including
after v2 ownership handoff. The older boundary image can authenticate safely but
cannot map this record: getRoom/listRooms fail and administrative access is lost.
The independent compatible-reader baseline is
`9b1d43f0eb7efe2fc2f8684669eda7379635c01c`. It permits read/map and metadata-only
PATCH of that shape while preserving private visibility, guest denial and immutable
assets; its public creation path still requires the prior owner input.

The API image advertises `io.vrata.room-record-reader=2`, and the target commit's
rollout contract advertises integer `roomRecordReader: 2`. Production/self-host and
staging preparation require reader 2 or higher at protocol floor 2 **or** if the
database contains a null-owner personal reference. This reader capability is
additional to the API/room-state identity-boundary capability. Binding alone at
floor 1 still requires the latter. Unbound floor-1 data without the new shape keeps
its earlier rollback behavior.

The scalar data probe resolves the bound template version just like the API reader
and uses reference snapshot markers, not a version-number heuristic. Missing or
partial schema, invalid probe output and query failure are refused before changing
env/services. At floor 2 the capability is required even when no such room exists:
the running API could create one after the data probe. Operators must serialize
protocol activation against deploy/rollback; concurrent cutover and image changes
are unsupported. The floor cannot be lowered to bypass this reader requirement.

CI builds the exact reader baseline independently and reopens the new rows through
its init/getRoom/listRooms/metadata PATCH before and after genuine invited-member
Owner handoff. The old pinned boundary is also tested to demonstrate its refusal;
the older-shape boundary rollback test is retained.

When staging access returns, deploy the compatible-reader baseline and complete its
gate **before** the provisioning release or any floor-2 activation, so the automatic
previous-successful-SHA rollback has a compatible target. GitHub/registry publication
alone does not establish a successful staging rollback target. The current outage
waiver covers development and CI/image publication, not v2 activation.

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
