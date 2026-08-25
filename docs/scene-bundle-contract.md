# Scene Bundle Contract v1

`vrata` v1 does not read Unity `.unity` scenes directly. A room can optionally point to a scene bundle manifest URL, and the runtime loads the bundle as a web scene.

For product-quality scene authoring and validator thresholds, see `docs/scene-technical-requirements.md`. This document describes the runtime compatibility contract; the requirements document is intentionally stricter for new scenes.

## Room manifest field

- Field: `sceneBundle.url`
- Type: string
- Meaning: absolute or relative URL to `scene.json`
- Compatibility: optional; rooms without `sceneBundle` continue using the built-in fallback scene

## Bundle layout

```text
scenes/the-hall-v1/
  scene.json
  scene.glb
  preview.jpg
```

## Local Validation

Scene authors can validate a bundle directory, `scene.json` file, or `.zip` archive before publishing:

```bash
pnpm --filter @vrata/asset-pipeline build
pnpm exec vrata scenes validate apps/runtime-web/public/assets/scenes/the-hall-v1
pnpm exec vrata scenes validate apps/runtime-web/public/assets/scenes/the-hall-v1 --json
```

The validator checks `scene.json` schema basics, relative path safety, spawn points, referenced main scene assets, optional preview files, optional material override maps, zip entry safety, and basic file size budgets. Human output is intended for local authoring; `--json` returns `{ ok, issues, stats }` with stable `code`, `path`, and `message` fields for CI or upload workflows.

Example CI gate:

```bash
pnpm --filter @vrata/asset-pipeline build
pnpm exec vrata scenes validate path/to/scene-bundle --json
```

## Upload And Publish Flow

Control-plane admins can publish `.zip` scene bundles from `/control-plane`:

- Choose a bundle id and immutable version.
- Select a `.zip` file containing `scene.json` and referenced bundle assets.
- Submit the scene bundle form. The API validates the zip with the shared validator before publishing any metadata.
- A valid upload appears in the registered scene bundles list with size, entry scene, and optional preview.
- Select a room and use `Bind selected scene bundle` to attach the current or selected version.

The upload endpoint is `POST /api/scene-bundles/uploads` with `multipart/form-data` fields:

- `bundle`: required `.zip` file.
- `bundleId`: optional lower-kebab id. Defaults to `scene.json#/sceneId` when omitted.
- `version`: optional immutable version. Defaults to `v1`.

Successful responses return the stored `SceneBundleRecord` plus validation warnings/stats. Invalid bundles return `400` with `error: "scene_bundle_validation_failed"` and validator `issues` containing stable `code`, `path`, and `message` fields. Uploads require the `scene-bundle.write` control-plane permission.

Storage modes:

- Production/staging self-host uploads write objects to MinIO/S3-compatible storage using `SCENE_BUNDLE_PROVIDER`, `MINIO_ENDPOINT`, `MINIO_ROOT_USER`, `MINIO_ROOT_PASSWORD`, `MINIO_BUCKET`, and `MINIO_PUBLIC_BASE_URL`.
- `s3-compatible` deployments must additionally configure `SCENE_BUNDLE_S3_ENDPOINT`, `SCENE_BUNDLE_S3_REGION`, `SCENE_BUNDLE_S3_BUCKET`, `SCENE_BUNDLE_S3_PUBLIC_BASE_URL`, `SCENE_BUNDLE_S3_ACCESS_KEY_ID`, and `SCENE_BUNDLE_S3_SECRET_ACCESS_KEY`.
- Dev/test without object-storage credentials uses a local filesystem fallback under `SCENE_BUNDLE_LOCAL_UPLOAD_ROOT` or `apps/runtime-web/public/assets/uploaded-scene-bundles`.
- `FEATURE_SCENE_BUNDLE_UPLOAD=false` disables the upload endpoint while leaving existing metadata/list/bind APIs available.

## `scene.json`

Required fields:

- `schemaVersion`: `1`
- `sceneId`: stable scene identifier
- `label`: human-readable scene label
- `source`: source system or Unity project label
- `glbPath`: relative path from `scene.json` to the main scene asset file; v1 runtime currently accepts `.gltf`, `.glb`, and `.fbx`
- `spawnPoints`: array of spawn points; runtime v1 uses the first entry

Optional fields:

- `bounds`: `{ width, height, depth }`
- `renderMode`: `"default"` or `"clean"`; `clean` hides fallback debug geometry and uses the brighter scene lighting path
- `mediaSurfaces`: physical runtime plane geometry for scene-specific media surfaces
- `preview`: relative preview asset path
- `attributions`: optional source credit records displayed in the runtime HUD
- `notes`: free-form export notes

### `attributions`

Scene bundles can declare visible credit records for source assets used by the scene. The runtime shows them in a separate HUD block after the scene bundle loads.

Each entry describes one credited source work:

- `title`: credited work title
- `author`: credited author or licensor name
- `source`: HTTP(S) URL where users can find the original work
- `license`: license label, such as `CC-BY-4.0`
- `authorUrl`: optional HTTP(S) author profile URL
- `licenseUrl`: optional HTTP(S) license URL
- `changes`: optional short note describing modifications made for the scene

### `mediaSurfaces`

Scene bundles can override the built-in fallback media surface meshes without rebuilding the runtime image. The scene owns only physical visual surfaces: plane identity, placement, size, pixel projection, front face, and physical input reachability. Room/template state owns logical purpose, labels, visibility policy, active objects, and allowed object types.

Each entry describes one runtime-visible surface:

- `surfaceId`: non-empty media surface id, unique within the manifest.
- `representation`: exactly `"platform-runtime-plane"`.
- `position`: finite `{ x, y, z }` world position in meters.
- `yaw`: finite rotation around the local Y axis in radians.
- `widthM`, `heightM`: physical plane size in meters.
- `pixelDimensions`: positive safe integer `{ width, height }` backing texture dimensions. Each side is at most `8192`, and total pixels are at most `33,554,432`.
- `frontFace`: exactly `"local-positive-z"`; `THREE.PlaneGeometry` local +Z is the interactive/rendered front face.
- `input`: `{ enabled, maxDistanceM }`, where `enabled` is boolean and `maxDistanceM` is a positive finite near-contact distance used by XR pencil/plane-point input. It does not limit controller or pointer ray reach.

All numeric values must be finite. Physical and pixel dimensions must be positive. A new F3 `mediaSurfaces` array must be non-empty and contain exactly one surface with `surfaceId: "debug-main"` for current runtime compatibility. Duplicate ids are invalid in every format.

If `mediaSurfaces` is omitted, scene loading fails, or scene bundles are disabled, the runtime keeps the built-in fallback layout with the main wall screen, whiteboard wall, and laptop screen. If `mediaSurfaces` is present, only those scene-declared physical meshes are selectable, visible in media-surface diagnostics, and eligible for surface input. A logical room-state surface without corresponding scene geometry does not alias to `debug-main`.

#### Deprecated legacy v1 form

Runtime and asset validation continue to accept the visual `mediaSurfaces` form shipped in Scene Bundle v1 before the F3 projection. Existing bundles can use `surfaceId`, `widthM`, `heightM`, optional `widthPx`/`heightPx`, `label`, `kind`, `visible`, `allowedObjectTypes`, and `transform: { x, y, z, yaw?, pitch?, roll? }`.

- Legacy `widthPx` and `heightPx`, when present, use the same safe-integer, `8192`-per-side, and `33,554,432`-total-pixel budgets as F3.
- Legacy `pitch`, `roll`, `visible`, and `label` remain effective at runtime.
- Legacy `allowedObjectTypes` is validated for compatibility and template-pair checks, but runtime object authorization comes only from logical room/template state.
- Legacy surfaces use the historical `0.06 m` XR near-contact distance and do not limit ray reach.
- An all-legacy array remains valid without `debug-main`. Mixing F3 and legacy entries in one array is rejected explicitly.
- New and republished scene bundles should use the F3 `platform-runtime-plane` form above.

Example:

```json
{
  "schemaVersion": 1,
  "sceneId": "sense-hall-v1",
  "label": "Sense Hall",
  "source": "sensetowervr",
  "glbPath": "scene.glb",
  "renderMode": "clean",
  "spawnPoints": [
    {
      "id": "main",
      "position": { "x": 0, "y": 0, "z": 6 }
    }
  ],
  "mediaSurfaces": [
    {
      "surfaceId": "debug-main",
      "representation": "platform-runtime-plane",
      "position": { "x": -3.4, "y": 1.55, "z": 0.15 },
      "yaw": 1.5707963267948966,
      "widthM": 3.2,
      "heightM": 1.8,
      "pixelDimensions": { "width": 1920, "height": 1080 },
      "frontFace": "local-positive-z",
      "input": { "enabled": true, "maxDistanceM": 0.05 }
    },
    {
      "surfaceId": "whiteboard-wall",
      "representation": "platform-runtime-plane",
      "position": { "x": 3.4, "y": 1.5, "z": 0.5 },
      "yaw": -1.5707963267948966,
      "widthM": 2.4,
      "heightM": 1.25,
      "pixelDimensions": { "width": 1920, "height": 1000 },
      "frontFace": "local-positive-z",
      "input": { "enabled": true, "maxDistanceM": 0.05 }
    }
  ],
  "bounds": { "width": 24, "height": 8, "depth": 24 },
  "preview": "preview.jpg",
  "attributions": [
    {
      "title": "Old Room",
      "author": "Hansalex",
      "authorUrl": "https://sketchfab.com/Hansalex",
      "source": "https://sketchfab.com/3d-models/old-room-6173a3c88c384f768dfc80967b6527b4",
      "license": "CC-BY-4.0",
      "licenseUrl": "https://creativecommons.org/licenses/by/4.0/",
      "changes": "Normalized to meters and optimized for Vrata runtime."
    }
  ],
  "notes": "v1 export without Unity behaviors"
}
```

## Runtime behavior

- If `sceneBundle.url` is missing, runtime uses the built-in fallback room.
- If `scene.json` fails validation or has an unknown `schemaVersion`, runtime uses the fallback room.
- If `scene.glb` fails to load, runtime uses the fallback room.
- Successful scene bundle load hides the fallback meshes and applies the first spawn point to the player root.
- Successful scene bundle load applies `mediaSurfaces` when present; the runtime creates, updates, or removes physical plane meshes to match the manifest exactly.
- Successful scene bundle load shows `attributions` in the HUD when present.
