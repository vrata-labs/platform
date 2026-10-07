# Room plugin packages, bindings and external CLI

## Storage boundary (T04)

Memory and PostgreSQL expose the same room/tenant-scoped roomPlugins methods.
The additive tables are room_plugin_packages, room_plugin_bindings and
room_plugin_state. Package admission validates original artifact bytes through
the SDK; code is never executed by the API. Version and exact artifact hash are
immutable. Package IDs and object keys are server-generated.

Metadata writes serialize under the parent-room exclusive fence on one client.
Reads use a shared fence and do not create state rows. Binding CAS uses a
room-wide revision that survives removal of the last binding; generations track
that revision. Enabled bindings pin exact package ID/version/hash/config and
approved capabilities. New capabilities on an existing binding require explicit
approval tied to the chosen artifact. Initial approvedCapabilities is the initial
approval; selecting another exact artifact with the same capabilities needs no
invented extra permission.

Limits: 10 retained live packages, 10 MiB live artifact bytes, 2 enabled bindings
and 200 lifetime package versions per room, including failed/deleted tombstones.
Deletion of a bound package is refused until unbind. Immutable tombstones cannot
be republished under the same version. No bucket-wide scan or background GC is
introduced.

## Object IO, uncertainty and deletion

Objects use a separate room-plugins prefix with hex-encoded tenant/room segments.
Local artifacts stay outside publicly served runtime directories. Remote artifacts
require a separate ROOM_PLUGIN_BUCKET, provisioned without anonymous access;
only endpoint/region/credentials are reused from scene/document storage. Compose
bootstrap creates the private bucket while retaining public scene downloads.
Signed reads alone are not an access policy. The published staging gate verifies
signed byte-exact reads and denied unsigned reads of its own fixed fixture.
S3 reads are signed and streamed under the artifact byte limit. Blob IO never runs inside a
metadata transaction. S3 PUT/GET/DELETE have a 15 s deadline.

Each reservation records an immutable credential-free backend fingerprint.
Endpoint/bucket/root changes refuse IO and cleanup; credential rotation is
allowed. This detects configuration changes, not physical bucket recreation or
mount replacement behind the same locator. Existing missing fingerprints are
not silently assigned to the current backend.

Upload settlement is durable server evidence, never a request claim. A confirmed
writer outcome is recorded before publication. Lost PUT acknowledgements,
timeouts, aborts and gateway/server failures retain the reservation: elapsed
time or even a matching GET cannot prove that an upstream writer has finished.
An unknown writer can leave a pending operation requiring separately established
settlement; automatic abandonment is not claimed.

Local publication writes/fsyncs a known temporary file and atomically hard-links
it into place without overwrite. Known terminated failures allow compensation;
unknown remote outcomes do not permit compensating deletion. Cleanup keeps the
key and intent until DELETE is acknowledged. Room deletion freezes at most ten
pending keys, blocks new admission and retains metadata across partial cleanup.
Only the matching deletion ID can remove the final room after all indexed
writers are settled and artifacts are deleted. Foreign keys also keep older
rollback code from deleting a room containing plugin packages.

T04 is an internal storage/service boundary. Fresh author/session authorization
for its transitions belongs to T05 and must be checked at the mutation boundary.
No public author upload route or global identity floor 2 is activated by this
storage slice. The current T03 decision is recorded separately in
[the sandbox contract](2026-10-04-room-plugin-sandbox.md#verification-gate).

## Prepared author HTTP API (T05)

The main API now contains room-scoped package upload/library/delete, binding
PUT/unbind, runtime snapshot and authenticated bound-content handlers. The
entire plugin HTTP family requires identity protocol minimum 2. At shared floor
1 every route returns 409 `plugin_identity_not_active` before actor resolution,
artifact buffering, metadata mutation or blob IO. This is preparatory protocol
plumbing; public author activation still depends on the independent T01a gate.

An author is the current proof-bound Host, the current personal-room Owner, or
an explicit verified platform administrator. Historical invite role, a public
participant ID, body/query claims and legacy trusted JWTs do not authorize an
installation. Runtime code/config access requires a valid RS2 room session; an
administrator header alone does not supply runtime access. Host installation is
covered through real invitation/admission without an administrator header on
any install request.

Guarded metadata operations share the T04 repository's authoritative parent
lock and one PostgreSQL client. The guard checks current identity/epoch,
lifecycle and original session expiry after lock waits, before mutations and
before synchronous response release. Memory rechecks after its queue and at
private-copy commit. Blob PUT/GET/DELETE occurs outside those fences.

Opaque admitted tickets permit terminal settlement and cleanup, not publication
or new binding authority. Unsettled reservations never launch another PUT.
Once the original PUT outcome is known, its idempotent settlement uses at most
three metadata attempts with 100/250 ms backoff for transient fence failures.
Exhaustion retains the indexed object; unknown PUT outcomes never enter this
retry path. Publication and binding authority are not extended by settlement.
Settled unpublished versions can resume with exact validated bytes and fresh
author permission. A confirmed post-PUT denial cleans only an unpublished
artifact; uncertain PUT/COMMIT outcomes retain the indexed object. Runtime
content validates a private byte copy and rechecks its exact captured binding
tuple and room revision before attachment headers/bytes are released.

A confirmed room-delete intent between settlement and publication follows that
same admitted cleanup path; it does not leave a settled reservation blocking
room DELETE indefinitely. Stored manifest/config strings reject U+0000 with
the same typed 400 in Memory and PostgreSQL before mutation. Other valid text
and source entry bytes are preserved; source is not JSONB manifest data.

Upload preserves the original envelope bytes and is bounded to 1 MiB. Binding
DTOs/config, requested capability approval and optimistic revisions use the
shared SDK/storage limits. Public metadata excludes storage keys and backend
fingerprints. Bound-content uses octet-stream, attachment, nosniff and sandbox
CSP, and exposes the artifact checksum. No API or native browser entry evaluation
is part of upload, validation or authenticated download.

The runtime snapshot includes only enabled ready bindings and a lease expiring
within 5 seconds and the original session deadline. Broker polling, generation
effects and `session-control.pluginBindingsRevision` integration belong to T07;
this API slice does not implement VM installation, author UI or auto-seat.
Positive API/CLI/browser tests use a dedicated verified v2 schema. Shared staging
tests cover the floor-1 denial and ordinary room entry without raising that floor.

## External packaging (T06)

The SDK now ships vrata-room-plugin with bundle, pack and validate commands.
Pinned esbuild 0.25.12 bundles JS/TS/JSON dependencies to neutral ESM; the shared
SDK validator checks the resulting artifact. No author code or author
install/prepare scripts are executed by the CLI. Files and UTF-8 are bounded;
output is atomic and deterministic, with stable JSON results/error codes.

Bundling defaults to the canonical project cwd and supports explicit --root.
Every source/dependency load must remain inside that root after realpath.
Absolute/relative escapes, escaping symlinks and parent-node_modules fallbacks
are rejected; local project dependencies remain supported.

Both standalone examples use a local-file SDK tarball dependency. welcome-status
exercises lifecycle/status; auto-seat is a readiness/arrival/alias-hash scaffold
limited to eight distinct candidates and fresh snapshots after busy. The real
broker, server-confirmed seating, cancellation correlation and live installation
remain T05/T07–T10/T16 work.

Public release metadata is served at /assets/plugin-sdk/releases.json. Tarballs
use version plus content SHA-256 paths, nosniff and attachment responses. The
distribution tests compare the committed archive with a fresh pnpm pack and
verify published HTTP bytes; source changes require a new content hash.
