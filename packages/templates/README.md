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
`resolveRoomTemplateAssetUrl()`; production origins must use HTTPS.

Before persisting or activating a complete immutable template version, run
`validateRoomTemplateVersionContract()` to verify outer identity, scene
identity, logical surfaces, and the locked scene release as one contract.
