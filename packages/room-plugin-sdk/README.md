# @vrata/room-plugin-sdk

SDK API v1 and schema v1 for external, untrusted Vrata room-behavior plugins.
Apache-2.0. This package has no workspace or runtime-web dependencies. Its TypeScript
configuration is standalone; npm pack includes built JavaScript, declarations,
source, license and the welcome-status example.

## Public exports

- `@vrata/room-plugin-sdk`: browser-safe DTOs, capability/resource constants,
  stable error codes, `validateRoomPluginConfigSchema`, `validateRoomPluginConfig`,
  `validateRoomPluginCapabilities`, `validateRoomPluginData`,
  `parseRoomPluginJson`, `validateRoomPluginRequest`, `parseRoomPluginRequest`,
  `validateRoomPluginEvent`, `parseRoomPluginEvent`, `validateRoomPluginResponse`,
  `parseRoomPluginResponse`, `validateRoomPluginInstanceIdentity` and
  `roomPluginUtf8ByteLength`.
- `@vrata/room-plugin-sdk/artifact`: Node >=22 packaging and validation:
  `createRoomPluginArtifact`, `validateRoomPluginArtifact`,
  `validateRoomPluginManifest`, `validateRoomPluginModule`,
  `validateRoomPluginSha256` and `roomPluginSha256`.

The future CLI and author API must both use `validateRoomPluginArtifact` with
original bytes, rather than independently validating or reserializing an upload.
All validation failures throw `RoomPluginValidationError` with stable `code` and
a bounded `path`. Never render an exception from plugin code as trusted HTML.

## Artifact v1

One UTF-8 `.vrata-plugin.json` file, without ZIP, assets, entry paths or resolvers:

```json
{
  "manifest": {
    "schemaVersion": 1,
    "sdkApiVersion": 1,
    "id": "welcome-status",
    "version": "1.0.0",
    "displayName": "Welcome status",
    "requestedCapabilities": ["status.set"],
    "configSchema": {
      "greeting": { "type": "string", "required": false, "minLength": 1, "maxLength": 256 }
    },
    "entrySha256": "<64 lowercase SHA-256 hex characters>"
  },
  "entry": "export function init(context) { return context.sdk.status.set('Welcome'); }"
}
```

Both version fields are integer `1`, not semver ranges. Plugin `version` is
release `MAJOR.MINOR.PATCH` without leading zeroes, prerelease or build metadata.
`id` is a lowercase dotted/hyphenated identifier, at most 64 ASCII characters;
`displayName` is nonempty, control-free and at most 128 UTF-8 bytes.
Unknown fields, unknown/repeated capabilities and nested capability lists fail.
No publisher string or checksum confers trust or author permission.

`entrySha256` covers exactly the UTF-8 bytes of decoded `entry`; CRLF, whitespace
and Unicode composition are preserved. `validateRoomPluginArtifact` returns
`artifactSha256` for **the entire original file's bytes**, `entrySha256`,
`byteLength`, `entryByteLength`, the frozen data-only artifact and an owned copy
of `bytes`. Outer whitespace/order therefore changes the artifact hash without
changing the entry hash. Store those original bytes; do not JSON.stringify the
parsed artifact for storage. The returned byte array is caller-owned and must
not be modified after validation. An optional expected artifact hash validates
content on download. Hashes are integrity identifiers, not signatures.

`createRoomPluginArtifact(manifestWithoutEntrySha256, bundledJs)` sorts object
keys, adds a final LF, computes the entry hash and passes the exact resulting bytes through the
same validator. It does not bundle, run scripts, install dependencies or fetch.

## JavaScript and lifecycle

Author TypeScript outside the platform, erase type imports and bundle all code
into one **ES2020 module**. Named exports `init(context)`,
`onEvent(event, context)` and `dispose(context)` implement the lifecycle;
callbacks are optional. T03 must validate actual QuickJS compatibility and
callback callability before execution. Newer syntax must be transpiled to
ES2020. No browser or Node environment is implied.

Acorn 8.18.0 parses the module without executing it. The AST rejects all static
imports, dynamic import expressions, sourced re-exports and import.meta,
including imports inside functions. Comments/strings/regex literals are not
treated as imports. This is a syntax/import contract, **not a proof that code is
safe or terminating**. Generated code, eval strings, native calls, regex costs
and globals cannot be secured by a static allowlist. The QuickJS VM must have
no external module loader, DOM/network/Node globals or implicit host APIs.
Plugin source must never run in native eval, Function, script or import().

Lifecycle is load/init -> events -> dispose for one
`(roomSession, bindingId, generation)`. Init/handler/job failure stops that
instance, with no automatic restart loop. Host-only `RoomPluginInstanceIdentity`
and `RoomPluginBinding` are not VM data. The broker stamps generation/revision
and rechecks session, lease, capability, user override and quotas on each
request; a plugin cannot supply participantId, roomId, credentials or pose.
`validateRoomPluginInstanceIdentity` makes an owned frozen host-metadata copy
with exactly bindingId/generation/bindingRevision; the counters must be
nonnegative safe integers. It validates shape, not authority: create this
metadata from trusted session/binding state, never from plugin data. Match all
three fields to the current host instance before accepting a Worker reply.
Old callbacks/replies after update/disable must be ignored. A failed/disabled
plugin does not unseat a successfully seated user.

## SDK operations and data minimization

The complete flat capability allowlist is:

| Capability / wire operation | Payload | Authority |
| --- | --- | --- |
| `seating.claimSelfOnEntry` | `{ seatId }` | One arrival permission; real seat; current own session; one claim in-flight |
| `seating.cancelPendingOwnClaim` | `{}` | Only own pending claim; cannot release confirmed seating |
| `status.set` | `{ text }` | Plain text, 512 UTF-8 bytes, at most 2 updates/second |

Requests have exactly `{ sdkApiVersion, requestId, operation, payload }`.
Request/seat identifiers are nonempty, control-free and <=128 UTF-8 bytes.
The VM facade exposes `context.sdk.seating.claimSelfOnEntry(seatId)`,
`cancelPendingOwnClaim()` and `context.sdk.status.set(text)` as promises.
`RoomPluginResponse` describes success/denial; results contain no server IDs.
There is no claim on behalf of another participant or arbitrary movement API.

Events are `room.ready`, `room.connection`, `seating.snapshot` and
`lifecycle.dispose`. Ready/seat snapshots contain only own binding-scoped alias,
arrival permission and seat IDs/yaw/occupancy aliases. The broker creates these
pseudonyms; the validator cannot prove their provenance. Real participantId,
other display names, DOM/Three objects, raw room/debug state, notes, documents,
admin/media/session tokens, storage credentials and sockets never enter the VM.
Ready must follow authenticated entry, loaded anchors, applied spawn and an
authoritative occupancy snapshot. XR/manual movement closes arrival permission
as defined by the core broker, not the plugin.

Render status with textContent and a trusted `Плагин <displayName>:` prefix. HTML-like
characters remain plain text. Plugin status cannot replace system warnings.
An empty string clears status. Resource constants describe policy;
validation alone does not implement throttling or seating authority.

## Flat config

At most 32 ASCII identifiers (letter first, then letters/digits/underscore,
<=64 characters). Each field has explicit `type` and boolean `required`:

- string: integer `minLength`/`maxLength`, 0..4096 **UTF-8 bytes**;
- number: finite `minimum`/`maximum`, ordered inclusively;
- boolean: no additional fields;
- enum: 1..32 unique nonempty strings, each <=256 UTF-8 bytes.

No defaults/coercion, patterns, refs, unions, nested values or executable schema.
Missing optional values stay missing. Unknown config keys fail. Schema and
config are independently bounded to 16 KiB. Config values must be finite JSON
scalars of exactly the declared type; null is not a config value.

## Parser and native-data boundary

Artifact bytes <=1 MiB and config/message bytes <=16 KiB are checked **before**
decoding/JSON.parse. Depth <=8 counts object/array containers, with root depth 1;
a lexical scan rejects deep serialized input before parsing. Duplicate object
keys (including escaped duplicates), malformed UTF-8, BOM and unpaired
surrogates are rejected. Native data is traversed with property descriptors,
not getters/toJSON/iterators. It rejects custom prototypes, class instances,
accessors, symbols, nonenumerable fields, sparse/extended arrays, nonfinite
numbers, undefined/functions/handles and cycles. Plain and null-prototype
records are accepted and copied to frozen null-prototype records. Reserved
`__proto__`, `prototype` and `constructor` keys are forbidden everywhere.
Null is valid JSON and empty seat occupancy, but not a record/manifest/schema.

These native validators are not a sandbox for live Proxy objects: reflective
operations can trigger proxy traps. VM serialization must enforce byte/depth,
allocation and execution limits **inside the VM before native structured clone
or JSON dump**, then send only bounded DTO bytes. Do not pass live VM handles.
HTTP upload handlers must bound the stream before buffering; a Uint8Array limit
does not retrospectively bound network allocation.

## Resource contract

`ROOM_PLUGIN_LIMITS` defines the plan's initial limits for T03/T04/T07:

- 1 MiB/artifact; 10 saved packages, 2 enabled plugins and 10 MiB total per room;
- VM heap 16 MiB, VM stack 32 KiB, WASM linear memory capped at 48 MiB
  (not whole browser/process memory); the initial 256 KiB stack candidate was
  reduced after compiled Chromium recursion probes exhausted native stack first;
- 50 ms init/handler/job budget; 500 ms independent Worker response deadline;
- rolling VM execution <=100 ms/second and <=2 s/minute; init separately bounded;
- timer interval >=250 ms, at most 4 timers;
- <=10 SDK requests/second, queue <=32, one seat claim in-flight;
- messages/config <=16 KiB, depth <=8; binding lease <=5 seconds.

These are shared definitions, not a completed sandbox guarantee. The spike must
enforce VM interrupt/job/allocation limits and independent Worker termination,
including sustained low-cost work and noninterruptible native calls.

## Author and compatibility boundary

Upload/install requires identity-protocol-v2 proof and fresh room authority:
effective trusted Host bound to current host identity, proven personal-room
owner or platform admin. A supplied participantId, legacy JWT, query role or
empty host field is insufficient. T01a is the mandatory gate before author
routes. The SDK exposes no author endpoints and no trust switch. Package
versions are immutable per room/id/version; bindings pin full artifact hash,
approved capabilities/config and optimistic revision, not latest. Additional
capabilities require explicit new approval. Room/tenant access and quotas
belong to authenticated storage/API, independently of validation.

`RoomPluginSessionControlFields.pluginBindingsRevision` is optional for old API
compatibility. Missing support means normal entry/manual seating, not permission
to run unvalidated code. Existing media-extension contracts are independent.

## Build, test and standalone example

Workspace dependencies are installed through pnpm and the shared lockfile.
Package checks compile before testing built files:

```sh
pnpm --filter @vrata/room-plugin-sdk build
pnpm --filter @vrata/room-plugin-sdk test
```

After building, pack this package into an existing output directory. Copy
`examples/welcome-status` to a directory outside the monorepo and install the
SDK tarball with `npm install --ignore-scripts /path/to/vrata-room-plugin-sdk-0.1.0.tgz`.
Then `npm run build` writes and revalidates
`welcome-status.vrata-plugin.json`, printing its exact hash/size. A valid, deterministic
artifact is also checked in beside the source and compared in the package tests. It needs only
the public SDK; its JavaScript has no executable imports or platform-specific
build scripts. Artifact reproducibility/validation can be tested independently
of the eventual QuickJS runtime. Publication and live execution are integration
tasks, not effects of building this example.
