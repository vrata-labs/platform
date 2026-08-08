# templates

Template packs for room layouts and branded asset slots.

`listTemplateDefinitions()` remains the authoritative Wave 1 seed for the four
active legacy templates. Future standard-room scene requirements are exposed
separately through `listStandardRoomTemplateSceneContracts()` and require an
exact template version lookup. They do not create catalog rows or activate
templates.

`RoomTemplateAssetLock` values are accepted only after
`validateRoomTemplateAssetLock()` succeeds. Resolve locked relative paths with
`resolveRoomTemplateAssetUrl()`; production origins must use HTTPS.

Before persisting or activating a complete immutable template version, run
`validateRoomTemplateVersionContract()` to verify outer identity, scene
identity, logical surfaces, and the locked scene release as one contract.
