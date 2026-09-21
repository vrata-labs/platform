# templates

Template packs for room layouts and branded asset slots.

`listTemplateDefinitions()` remains the authoritative Wave 1 seed for the four
active legacy templates. Contract-complete standard-room versions are exposed
separately through `listStandardRoomTemplateVersionContracts()` and exact
`getStandardRoomTemplateVersionContract()` lookups. They pin final defaults and
the full-SHA scene-assets release, but do not create catalog rows or activate
templates.

`RoomTemplateAssetLock` values are accepted only after
`validateRoomTemplateAssetLock()` succeeds. Resolve locked relative paths with
`resolveLockedRoomTemplateAssetUrl()` to derive the official full-SHA jsDelivr URL
from that definition's repository/revision. An optional mirror root uses the
namespaced `<owner>/<repository>/<commitSha>/<relative-path>` layout; different
repositories and revisions cannot overwrite each other's mirrored files. Production
origins require HTTPS. `resolveRoomTemplateAssetUrl()` retains the explicit-base
compatibility helper for historical callers.

`scene-repositories.lock.json` lists all exact repository revisions consumed by
the version definitions. CI checks out and validates each revision independently,
checks complete definition coverage, and verifies actual manifest/GLB/preview and
license bytes. Local checkouts use `.scene-assets/<owner>/<repository>/<commitSha>`;
`VRATA_SCENE_REPOSITORIES_ROOT` can override the checkout root. A per-repository CI
job supplies both `VRATA_SCENE_REPOSITORY` and `VRATA_SCENE_COMMIT_SHA` to validate
its subset without weakening the complete lock-coverage check.

Before persisting or activating a complete immutable template version, run
`validateRoomTemplateVersionContract()` to verify outer identity, scene
identity, logical surfaces, and the locked scene release as one contract.
