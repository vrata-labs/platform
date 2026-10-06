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
