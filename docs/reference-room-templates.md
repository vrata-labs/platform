# Reference room templates

FEAT-032 adds three immutable `2.0.0` template contracts. Initial deployment uses
the **Wave 2 catalog**: existing create entries remain active until an explicit
guarded activation. Startup never activates the new catalog or migrates rooms.

| Template | Locked scene | Seats | Logical surfaces |
| --- | --- | --- | --- |
| `personal-room-basic@2.0.0` | `personal-workspace-v1@0.4.2` | 1 | `workspace-main` |
| `meeting-room-basic@2.0.0` | `warm-modern-meeting-room-candidate-01@0.3.4` | 8 | `debug-main`, `whiteboard-wall` |
| `presentation-room-basic@2.0.0` | `presentation-room-v1@0.4.2` | 8 | `debug-main` |

Repository revisions, file sizes and SHA-256 locks are in
`packages/templates/src/product-room-definitions.ts`. Historical `0.1.0` and
`1.0.0` definitions remain unchanged. Scene geometry owns physical surface
transforms; signed template context owns IDs and allowed media object types.

## Create and edit

`GET /api/templates` returns the active catalog with version, description, actual
preview URL and defaults. After activation it contains exactly the three entries
above. The control plane applies defaults on selection and confirms replacement
of edited defaults. Personal requires an owner and stays private with guest access
disabled; its notes start private. Presentation starts with join-muted selected.
Explicit audio/notes preferences persist per room.

`POST /api/rooms` resolves the active version on the server and stores its complete
snapshot and absolute scene URL. Omit `templateVersion` to use the current version,
or send that exact version. Do not send `templateSnapshot` or a reference
`sceneBundleUrl`. Direct API and control-plane creates share materialization.

Errors:

| Input | HTTP / error |
| --- | --- |
| Unknown template | 400 / `unknown_template` |
| Malformed version | 400 / `invalid_template_version` |
| Unknown version | 400 / `unknown_template_version` |
| Known non-current version | 409 / `template_version_not_current` |
| Deprecated template | 409 / `deprecated_template` |
| Client snapshot | 400 / `server_owned_template_snapshot` |
| Reference scene replacement | 409 / `reference_scene_override_not_allowed` |
| PATCH template or version change | 409 / `template_change_not_supported` |
| Missing personal owner | 400 / `missing_personal_room_owner` |
| Public personal room / guest access | 400 / `personal_room_must_be_private` / `personal_room_guest_access_forbidden` |
| Personal owner replacement | 409 / `personal_room_owner_immutable` |

Existing legacy rooms remain editable with their pinned version and scene URL.
Reference PATCH changes permitted room settings and the snapshot's `roomConfig`
projection only. It cannot replace the version-owned policy or scene. Runtime
verifies scene manifest and self-contained GLB bytes before parsing/rendering;
checksum or required-surface failures show an explicit fallback diagnostic.

## Self-host assets

The default origin is immutable jsDelivr by repository and full commit SHA.
Optionally set `ROOM_TEMPLATE_ASSET_BASE_URL=https://mirror.example/scenes` on API.
Copy byte-identical files under:

```text
<mirror-root>/<owner>/<repository>/<full-commit-sha>/<locked-relative-path>
```

Include the locked root `manifest.json` and all four bundle files. Serve them with
browser-readable CORS, correct content types and immutable caching. HTTPS is
required in production. URL credentials, query strings, fragments and traversal
are rejected. This is separate from document/scene upload storage. Mirror changes
affect catalog previews and future rooms only; existing absolute room URLs stay
pinned and must remain available.

## Expand, verify, activate, rollback

1. Deploy through normal CI/Docker/Staging. Wave 2 installs reference versions,
   validates existing bindings and completes `NOT NULL` metadata migration while
   keeping four legacy create entries. Local PostgreSQL tests execute the exact
   previous `33c7485ffa1773105c496b43542ea53bf4c5ae9a` build's create/PATCH/manifest
   operations against that schema and return to the new code.
2. After the successful staging gate, the workflow records the deployed SHA once
   in `infra/docker/.template-wave2-rollback-sha`. Later deployments do not replace
   this marker. The marked image understands existing reference rooms even with
   their catalog entries inactive.
3. `tools/staging-template-catalog.py status --root <checkout>` reports exact
   catalog state, deployed image and reference room count. `preflight` verifies
   actual official/mirror bytes. `activate --root <checkout> --sha <deployed-sha>`
   requires the successful deployment marker, compatible rollback baseline and
   exact running image before an atomic activation. Staging activation is distinct
   from production publication and physical-device acceptance.
4. `rollback --root <checkout> --sha <running-sha>` restores the exact Wave 2
   catalog before deploying the recorded Wave 2 image. Existing pinned rooms are
   preserved. Delete only specifically identified disposable QA rooms through
   normal API cleanup; the tool never deletes rooms, blobs or database volumes.
5. The staging workflow preserves the guard outside the git checkout, so manually
   selecting an old SHA cannot remove the downgrade check. Once a Wave 2 baseline
   exists, targets without the reference/schema capability contract are rejected.
   Before that marker, an initial failed Wave 2 deployment may return to the proven
   Wave 1 build only when no active references or reference rooms exist. This check
   reads PostgreSQL and remains available if a failed deployment stopped the API.

Activation must be followed by active-catalog browser checks and the physical
Android Chrome, iOS Safari and Meta Quest checks agreed with the owner. The
implementation plan remains open until those gates have real reports. Existing
legacy staging fixture tests must retain coverage when their create templates
become deprecated; the production create restriction must not be bypassed for QA.

The `Staging Template Catalog` workflow performs this staging-only transition for
an exact verified `expected_image_sha`. It seeds disabled legacy regression rooms
before activation, runs the complete public suite against the active catalog and
restores Wave 2 plus dispatches normal image rollback on failure. It shares the
deployment concurrency group. The follow-up deploy begins after this workflow
releases that group; its result is a separate required check. Ordinary subsequent
staging gates detect the active catalog and include the product scenarios.

The [acceptance record](reviews/2026-09-22-reference-template-acceptance.md) contains
the physical-device checklist and must be completed with actual device results.

## Local verification

Build before package tests. Use a disposable PostgreSQL database via
`VRATA_TEST_POSTGRES_URL`; set `VRATA_TEMPLATE_ROLLBACK_STORAGE_MODULE` to the built
API storage module of the exact rollback checkout for the mutating rehearsal.
CI builds that checkout automatically. `node tools/fetch-reference-template-fixtures.mjs`
downloads and verifies pinned assets; isolated reference e2e uses a per-run
PostgreSQL schema and a byte-identical HTTP mirror.

Run `pnpm build`, `pnpm lint`, `pnpm typecheck`, `pnpm test`, the six locked
template/scene validations, then full `pnpm test:e2e`. If choosing non-default test
ports, set `BASE_URL` as well as `E2E_API_PORT` so both direct-browser and request
fixtures address the same server.
