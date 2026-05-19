# Scene Technical Requirements

This document defines the target requirements for new Noah scenes. It is based on the current Scene Bundle v1 runtime contract and on diagnostics from the legacy exported staging scenes. The legacy scenes are useful only as technical probes. New scenes must be original or properly licensed and must not copy their meshes, textures, layouts, names, trade dress, or distinctive visual composition.

## Goals

- Make scene requirements understandable to a human scene author: what a good room should feel like, where users spawn, what must be visible, and what must not be copied.
- Make scene requirements understandable to an agent or validator: exact fields, numeric budgets, severity levels, and runtime checks.
- Separate technical compatibility from legal clearance. A scene can be technically valid and still be forbidden if rights are not cleared.
- Prefer scenes that work in the main runtime path without custom runtime patches, broad material overrides, or one-off scene-specific code.

## Legacy Observations

The staging scenes showed useful technical patterns and failure modes. These numbers are observations, not acceptance targets.

| Legacy scene | Asset MB | Runtime triangles | Load ms | Dark ratio | Main finding |
| --- | ---: | ---: | ---: | ---: | --- |
| Hall | 18.02 | 221027 | 16238 | 0.0009 | Visually readable, but runtime bounds are huge, so scale/bounds are not a clean product baseline. |
| BlueOffice | 8.84 | 158104 | 12139 | 0.5016 | Usable, but dark patches and oversized Y bounds show material and helper cleanup gaps. |
| LectureHall | 8.95 | 50987 | 12797 | 0.0719 | Readable, but runtime bounds include giant 10000-unit extents. |
| Showroom | 12.61 | 87002 | 19639 | 0.8018 | Loads, but too dark from spawn and has giant bounds. |
| MeetingSmall | 8.42 | 53514 | 4556 | 0.1094 | Good load/readability signal, but giant bounds remain. |
| Cinema | 8.41 | 107294 | 11527 | 0.1120 | Good example of why spawn/framing matters more than raw export quality. |
| Anastasia | 13.49 | 79274 | 18625 | 0.9652 | Technically loads, but the initial view is effectively black. |
| NewGallery | 17.69 | 169775 | 17836 | 0.4655 | Heavy and moderately dark; oversized bounds. |
| ArtGallery | 26.94 | 132836 | 35361 | 0.4655 | Loads slowly; over the target desktop load budget. |
| Standup | 7.50 | 40363 | 12104 | 0.5928 | Technically light, but too dark from spawn. |
| OporaRussia | 8.28 | 153956 | 7051 | 0.5165 | Fast enough, but moderately dark. |
| SergOffice | 6.14 | 35077 | 5954 | 0.0859 | Good compact baseline for scale, load, and visibility. |
| CinemaModeler | 4.32 | 88812 | 5113 | 0.8714 | Small and fast, but too dark from spawn. |

Key conclusions:

- `sceneBundleState=loaded` is necessary but not sufficient.
- `missingAssets=0` was achievable across the staging sample and should be a hard requirement.
- Large helper objects, hidden planes, cameras, colliders, or exporter artifacts can inflate runtime bounds to 10000 units and break framing, teleport assumptions, and validators.
- Dark scenes often load successfully but fail the human expectation: a user must understand where they are within the first few seconds.
- Broad material overrides are not a product solution. Materials should be fixed in the asset/export pipeline.
- Current manifests often use local absolute `source` paths and omit previews. New scenes need clean provenance metadata and catalog previews.

## Human Requirements

### Originality And Rights

- The scene must be newly authored for Noah, generated from Noah-owned assets, or built from assets with explicit commercial web/XR rights.
- The scene must not reproduce the prior company's scene layouts, object arrangements, branded interiors, visual identity, or distinctive material palette.
- Every non-original asset must have a recorded license, source URL or vendor ID, author, allowed usage, and proof that web, staging, production, screenshots, and derivative optimization are permitted.
- The bundle must not contain private local paths, employee names, prior-company project paths, or source-system identifiers that cannot be published.

### User Experience

- On first load, the user must see a recognizable room, floor, nearby objects, and a plausible direction of travel from the main spawn.
- The first view must not be black, mostly empty, inside geometry, facing a wall at close range, or outside the room.
- The scene should have a clear social purpose: meeting room, gallery, classroom, hall, showroom, stage, office, lounge, or another explicit room type.
- Walkable floor, seating, display surfaces, and important focal objects should be visually distinguishable without debug modes.
- Desktop and mobile users must be able to orient themselves without VR-only assumptions.
- VR users must have enough head clearance around spawn and seating areas.

### Runtime Fit

- The scene must work through the standard Scene Bundle path. Do not add scene-specific runtime code for product scenes.
- The scene must remain usable with the fallback environment hidden and the platform display surface still visible.
- If `renderMode` is `clean`, the scene must remain readable with the current clean-mode ambient-light setup.
- The scene must not rely on Unity scripts, Unity-only shaders, gameplay triggers, post-processing volumes, or engine behavior that the web runtime does not execute.

## Bundle Layout

Production bundles should use this layout:

```text
assets/scenes/<scene-id>/
  scene.json
  scene.glb
  preview.webp
  LICENSES.md
```

Rules:

- `scene.json` is the only file a room manifest points to.
- `scene.glb` is the production asset format. `.gltf` is acceptable only for tiny test fixtures. `.fbx` is legacy-only and must not be used for new production scenes.
- `preview.webp` or `preview.jpg` is required for catalog use.
- `LICENSES.md` is required for any scene that is not 100% internally authored.
- All paths inside the bundle must be relative and must not contain `..`, absolute paths, or backslashes.

## Manifest Requirements

The runtime currently parses Scene Bundle v1. Validators for new scenes should be stricter than the runtime parser.

| Field | Severity | Requirement |
| --- | --- | --- |
| `schemaVersion` | fail | Must equal `1` until a new runtime schema is shipped. |
| `sceneId` | fail | Lower-kebab ID, stable and immutable for a published version, matching the bundle directory. |
| `label` | fail | Human-readable name, 3-60 characters, no internal codenames or third-party brands unless licensed. |
| `source` | fail | Public-safe provenance string, not a local absolute path. |
| `glbPath` | fail | Relative path to `.glb`; no absolute URLs for production bundles. |
| `renderMode` | warn | Must be `default` or `clean`; prefer `clean` only when the asset was checked under clean runtime lighting. |
| `spawnPoints` | fail | Non-empty array; first entry must be `main` and must be usable. |
| `bounds` | fail | Required for product scenes; must describe the intended navigable room, not exporter/helper extents. |
| `anchors.teleportFloorY` | warn | Required when teleport/seating is expected; usually `0`. |
| `anchors.seatAnchors` | warn/fail | Required if visible seats are part of the scene promise; optional for empty gallery/stage scenes. |
| `materialOverrides` | warn | Should be absent. Up to 5 targeted overrides may be allowed temporarily with a ticket and expiry. |
| `preview` | fail | Required for product scenes and must point to an existing preview image. |
| `rights` | fail | Required by validators even though runtime ignores it today. |

Recommended rights block:

```json
{
  "rights": {
    "owner": "noah",
    "license": "internal-original",
    "clearedFor": ["staging", "production", "web-runtime", "screenshots", "optimization"],
    "sourceAssets": [
      {
        "id": "asset-library-or-ticket-id",
        "type": "mesh|texture|hdr|audio|font",
        "author": "Noah",
        "licenseRef": "LICENSES.md"
      }
    ]
  }
}
```

## Coordinate And Scale Requirements

- One scene unit must equal one meter.
- The main walkable floor should be at `y=0`, with tolerance `+-0.05m`.
- Player eye height is approximately `1.6m`; spawn and seats must not place the camera inside ceilings, props, or walls.
- Indoor product scenes should normally fit within `4m <= width/depth <= 80m` and `2.4m <= height <= 20m`.
- Runtime computed bounding boxes must be finite and must not exceed `200m` on any axis for normal indoor scenes.
- Runtime computed bounds should be within `1.5x` of manifest `bounds` on each axis. A larger ratio is a warning; a ratio above `3x` is a failure unless the scene declares and documents a special world scale profile.
- Remove or exclude helper objects, collider meshes, cameras, rig controls, hidden export planes, test cubes, and giant background geometry from the runtime GLB.
- Node transforms with extreme scale, position, or rotation should be rejected unless they are intentionally documented and do not affect bounds or interaction.

## Spawn Requirements

The first spawn point is the runtime entry point today.

| Check | Severity | Requirement |
| --- | --- | --- |
| `spawnPoints[0].id` | fail | Must be `main`. |
| Position finite | fail | `x`, `y`, and `z` must be finite numbers. |
| On floor | fail | `abs(position.y - teleportFloorY) <= 0.1` unless the room intentionally starts on a platform. |
| Inside bounds | fail | Spawn must be inside manifest bounds with at least `0.5m` margin from walls/edges. |
| Head clearance | fail | At least `2.0m` clear vertical space above spawn. |
| Open radius | fail | At least `0.75m` free radius around the player root. |
| First view readability | fail | Runtime screenshot from spawn must pass the visual thresholds below. |
| Future yaw | warn | Add `yaw` when schema/runtime support lands; until then author the room so default yaw is usable. |

## Seating And Interaction Anchors

Seat anchors are domain metadata, not decorative mesh names.

- Seat IDs must be unique lower-kebab strings and should be prefixed by the scene ID or room area.
- `position` is the avatar root target. It must be close to the visual seat surface and reachable from the floor.
- `yaw` is radians, normalized to `[-pi, pi]`, and should face the intended social/focal direction.
- `seatHeight` is added to `position.y` for the seated avatar root and should normally be between `0` and `0.8`.
- `radius` should normally be between `0.35` and `0.8` meters.
- Seat anchor centers should not overlap. Distance between two centers should be at least `max(radiusA, radiusB) * 1.5` unless bench seating explicitly allows closer spacing.
- A visible chair/bench/sofa promised by the scene should have an anchor or be clearly non-interactive.
- Anchors must not put the avatar inside tables, walls, arm rests, or other seated avatars.
- Teleport floor and seat anchors must use the same coordinate scale as the GLB.

## Geometry Requirements

- Export only visible runtime geometry plus intentional collision/interaction proxy objects if the runtime explicitly supports them.
- Keep object count and mesh count low by merging static meshes when that does not harm culling, materials, or authoring workflow.
- Remove duplicate invisible meshes, editor helpers, unused cameras, unused lights, and unused animations.
- Avoid thin one-sided planes for walls, floors, and large furniture unless backface visibility is intentionally handled.
- Transparent foliage and glass must be tested in the runtime, not only in the DCC/Unity viewport.
- No mesh should contain NaN, infinite values, zero-scale transforms, or degenerate bounding boxes.

## Material And Lighting Requirements

- Prefer glTF PBR materials compatible with `THREE.MeshStandardMaterial`.
- Use baked base-color/emissive textures when the look depends on authored lighting.
- Use `KHR_materials_unlit` only for intentionally unlit/baked surfaces, UI-like labels, or signage.
- Avoid legacy/spec-gloss material paths for new exports. `KHR_materials_pbrSpecularGlossiness` is a warning today and should become a failure for product scenes.
- Do not rely on Unity Shader Graph, custom Unity shaders, lightmap-only materials, post-processing, reflection probes, or camera effects that are not exported into web-compatible material data.
- Material names should be stable and meaningful. Names like `Hidden/UnityGLTF/...`, `Tantular SDF Material`, `Material.024`, or unconverted shader placeholders should be warnings because they make targeted validation and debugging harder.
- At least 60% of visible runtime materials should be textured or deliberately colored with validated non-black colors.
- Broad wildcard material overrides are forbidden for product acceptance. Fix materials at export/source level.
- Large black materials are allowed only when semantically black and when the scene still passes visual readability from spawn.

## Texture Requirements

- Textures must be embedded in the GLB or referenced relatively inside the bundle.
- Missing runtime assets are a hard failure.
- Prefer WebP, PNG, JPEG, or KTX2/Basis where supported by the pipeline.
- Texture dimensions should be powers of two unless there is a documented reason.
- Default maximum texture size is `2048x2048`; `4096x4096` is allowed only for hero surfaces and counts as a warning.
- Avoid many nearly identical material/texture variants. Atlas or reuse where possible.
- Use sRGB for base color and linear data for normal/roughness/metalness/AO maps.

## Performance Budgets

Budgets are per scene bundle profile. Validators should support profile selection and default to `desktop-standard` for staging rooms.

| Metric | mobile-lite fail | desktop-standard warn | desktop-standard fail | xr fail |
| --- | ---: | ---: | ---: | ---: |
| Bundle size | >15 MB | >25 MB | >40 MB | >25 MB |
| Main GLB size | >15 MB | >25 MB | >40 MB | >25 MB |
| Runtime triangles | >90000 | >150000 | >220000 | >120000 |
| Runtime object count | >500 | >600 | >1000 | >500 |
| Runtime mesh count | >250 | >300 | >600 | >300 |
| Runtime material count | >96 | >128 | >256 | >128 |
| Runtime texture count | >48 | >64 | >96 | >64 |
| Cold load on staging desktop | >20000 ms | >15000 ms | >30000 ms | >20000 ms |

Notes:

- These budgets intentionally push new scenes below the heaviest legacy scenes.
- A scene can exceed a warning budget only with a documented reason and a human visual/performance sign-off.
- A scene that exceeds a fail budget must not be marked production-ready.

## Runtime Visual Acceptance

Runtime acceptance must be measured in the real Noah browser runtime, not only through static GLB inspection.

Required command shape for automated checks:

```text
open /rooms/<room-id>?debug=1&scenefit=0
wait until window.__NOAH_DEBUG__.sceneBundleState is loaded or failed
read window.__NOAH_DEBUG__.sceneDebug
```

Hard failures:

- `sceneBundleState !== "loaded"`.
- `sceneDebug.failureReason !== null`.
- `sceneDebug.missingAssets.length > 0`.
- `sceneDebug.screenshot.averageColor.a < 250` for normal opaque scenes.
- `sceneDebug.screenshot.darkPixelRatio > 0.70` unless `visual.intentionalDark` is approved.
- Average screenshot luminance below `40` for normal scenes.
- Runtime computed bounds exceed `200m` on any axis for normal indoor scenes.
- The first view is inside geometry, outside the room, or not human-readable even if numeric thresholds pass.

Warnings:

- `sceneDebug.screenshot.darkPixelRatio > 0.35`.
- Average screenshot luminance below `55`.
- More than 25% of top material samples are untextured near-black materials.
- Top material sample names show unconverted shader placeholders.
- Runtime load time exceeds the profile warning budget.

Intentional dark scenes:

- Must declare `visual.intentionalDark: true` in metadata.
- Must still show navigable floor, silhouettes, exits/focal zones, seats, and interactable surfaces.
- Must include at least one bright focal region or guidance cue in the first view.
- Must pass human review on desktop and VR before staging promotion.

## Supported glTF Features

Allowed for product scenes:

- Core glTF 2.0 `.glb`.
- `KHR_texture_transform`.
- `KHR_materials_unlit`, when intentional.
- `KHR_materials_emissive_strength`, when tested in runtime.
- `KHR_lights_punctual`, when not required for basic visibility.
- `KHR_draco_mesh_compression`, if decode is tested in runtime.
- `EXT_meshopt_compression`, if decode is tested in runtime.
- `KHR_texture_basisu`, if KTX2 transcode is tested in runtime.

Warnings for product scenes:

- `KHR_animation_pointer`, because current room scenes are expected to be static unless animation support is explicitly scoped.
- `KHR_materials_pbrSpecularGlossiness`, because it is a legacy path and has already appeared in problematic exports.
- Embedded cameras and unused lights.

Failures for product scenes:

- Required extensions not supported by the runtime loader.
- External scripts, executable content, or engine-specific behavior.
- Absolute external asset URIs unless the bundle is explicitly a CDN-hosted, immutable, reviewed asset package.

## Validator Rule IDs

Agents and validators should report stable rule IDs. Suggested IDs:

| Rule ID | Severity | Check |
| --- | --- | --- |
| `SCENE_RIGHTS_001` | fail | `rights` metadata exists and clears staging/production/web-runtime. |
| `SCENE_RIGHTS_002` | fail | No prior-company paths, names, brands, or unlicensed asset references. |
| `SCENE_MANIFEST_001` | fail | `schemaVersion === 1`. |
| `SCENE_MANIFEST_002` | fail | `sceneId` is lower-kebab and matches bundle directory. |
| `SCENE_MANIFEST_003` | fail | `glbPath` is relative `.glb` with no traversal. |
| `SCENE_MANIFEST_004` | fail | `preview` exists for product scenes. |
| `SCENE_MANIFEST_005` | fail | `bounds` exists and all axes are positive finite numbers. |
| `SCENE_ASSET_001` | fail | Main GLB exists and size is within selected profile fail budget. |
| `SCENE_ASSET_002` | fail | All GLB/bundle resource references resolve. |
| `SCENE_GLTF_001` | fail | GLB is valid glTF 2.0 and has exactly one default scene or documented scene selection. |
| `SCENE_GLTF_002` | fail | No unsupported required extensions. |
| `SCENE_GLTF_003` | warn | Deprecated or ignored extensions are present. |
| `SCENE_SCALE_001` | fail | Runtime bounds are finite and no normal indoor axis exceeds `200m`. |
| `SCENE_SCALE_002` | fail | Runtime bounds are not more than `3x` manifest bounds without approved world profile. |
| `SCENE_SPAWN_001` | fail | First spawn is `main`, finite, inside bounds, on floor, and has clearance. |
| `SCENE_SEAT_001` | fail | Seat anchors have unique IDs, finite position, valid yaw, positive radius. |
| `SCENE_SEAT_002` | warn | Visible seating lacks anchors or anchors are too close/inside geometry. |
| `SCENE_MATERIAL_001` | warn | Unconverted placeholder material names are present. |
| `SCENE_MATERIAL_002` | fail | Broad material overrides are required to make the scene readable. |
| `SCENE_VISUAL_001` | fail | Runtime scene does not reach `loaded`. |
| `SCENE_VISUAL_002` | fail | Runtime missing assets are non-empty. |
| `SCENE_VISUAL_003` | fail | Spawn screenshot is black/transparent/unreadable. |
| `SCENE_PERF_001` | warn | Runtime metrics exceed profile warning budget. |
| `SCENE_PERF_002` | fail | Runtime metrics exceed profile fail budget. |

## Machine-Readable Profile

The following JSON is the initial validator profile. It is intentionally stricter than the legacy staging corpus.

```json
{
  "sceneRequirementsVersion": 1,
  "defaultProfile": "desktop-standard",
  "format": {
    "schemaVersion": 1,
    "productionAssetExtensions": [".glb"],
    "fixtureAssetExtensions": [".glb", ".gltf"],
    "legacyOnlyExtensions": [".fbx"],
    "requiredProductFiles": ["scene.json", "scene.glb", "preview.webp|preview.jpg"],
    "forbiddenPathPatterns": ["..", "^/", "^[A-Za-z]:", "\\\\"]
  },
  "rights": {
    "required": true,
    "requiredClearedFor": ["staging", "production", "web-runtime", "screenshots", "optimization"],
    "forbidUnlicensedThirdPartyAssets": true,
    "forbidPriorCompanyTradeDress": true
  },
  "profiles": {
    "mobile-lite": {
      "maxBundleMb": 15,
      "maxGlbMb": 15,
      "maxRuntimeTriangles": 90000,
      "maxRuntimeObjects": 500,
      "maxRuntimeMeshes": 250,
      "maxRuntimeMaterials": 96,
      "maxRuntimeTextures": 48,
      "maxLoadMs": 20000
    },
    "desktop-standard": {
      "warnBundleMb": 25,
      "maxBundleMb": 40,
      "warnRuntimeTriangles": 150000,
      "maxRuntimeTriangles": 220000,
      "warnRuntimeObjects": 600,
      "maxRuntimeObjects": 1000,
      "warnRuntimeMeshes": 300,
      "maxRuntimeMeshes": 600,
      "warnRuntimeMaterials": 128,
      "maxRuntimeMaterials": 256,
      "warnRuntimeTextures": 64,
      "maxRuntimeTextures": 96,
      "warnLoadMs": 15000,
      "maxLoadMs": 30000
    },
    "xr": {
      "maxBundleMb": 25,
      "maxGlbMb": 25,
      "maxRuntimeTriangles": 120000,
      "maxRuntimeObjects": 500,
      "maxRuntimeMeshes": 300,
      "maxRuntimeMaterials": 128,
      "maxRuntimeTextures": 64,
      "maxLoadMs": 20000
    }
  },
  "scale": {
    "unit": "meter",
    "floorYDefault": 0,
    "floorYTolerance": 0.05,
    "normalIndoorMaxAxisM": 200,
    "manifestBoundsWarnRatio": 1.5,
    "manifestBoundsFailRatio": 3.0,
    "normalIndoorMinWidthDepthM": 4,
    "normalIndoorMaxWidthDepthM": 80,
    "normalIndoorMinHeightM": 2.4,
    "normalIndoorMaxHeightM": 20
  },
  "spawn": {
    "mainSpawnRequired": true,
    "floorToleranceM": 0.1,
    "wallMarginM": 0.5,
    "freeRadiusM": 0.75,
    "headClearanceM": 2.0
  },
  "seating": {
    "idPattern": "^[a-z0-9]+(?:-[a-z0-9]+)*$",
    "yawMin": -3.141593,
    "yawMax": 3.141593,
    "radiusMinM": 0.35,
    "radiusMaxM": 0.8,
    "seatHeightMinM": 0,
    "seatHeightMaxM": 0.8,
    "minDistanceMultiplier": 1.5
  },
  "visual": {
    "requireLoadedState": true,
    "requireNoFailureReason": true,
    "maxMissingAssets": 0,
    "minAverageAlpha": 250,
    "warnDarkPixelRatio": 0.35,
    "maxDarkPixelRatio": 0.70,
    "warnAverageLuminance": 55,
    "minAverageLuminance": 40,
    "intentionalDarkRequiresHumanReview": true
  },
  "gltf": {
    "allowedExtensions": [
      "KHR_texture_transform",
      "KHR_materials_unlit",
      "KHR_materials_emissive_strength",
      "KHR_lights_punctual",
      "KHR_draco_mesh_compression",
      "EXT_meshopt_compression",
      "KHR_texture_basisu"
    ],
    "warnExtensions": [
      "KHR_animation_pointer",
      "KHR_materials_pbrSpecularGlossiness"
    ],
    "forbidUnsupportedRequiredExtensions": true
  }
}
```

## Acceptance Flow

1. Static manifest validation: fields, paths, rights metadata, bundle layout.
2. Static asset validation: GLB parse, resource references, extension support, sizes, texture dimensions, materials, node transforms, raw stats.
3. Runtime local validation: load through Noah runtime with `?debug=1&scenefit=0`, assert loaded state, screenshot readability, runtime stats, missing assets.
4. Staging validation: publish immutable bundle URL, bind a test room, run the same runtime checks against staging.
5. Human review: confirm the scene is original, readable, socially usable, and not visually derived from the legacy copyrighted scenes.

## Definition Of Ready For A New Scene

- It has a clean rights record and no copied prior-company creative content.
- It has a `scene.json`, `scene.glb`, preview image, and license/provenance record.
- Static validators return no failures.
- Runtime validators return no failures under the selected profile.
- Any warnings have an explicit owner, reason, and follow-up ticket.
- A human reviewer can understand the room purpose from the first spawn view.
- The scene can be added to a room by changing metadata only, without runtime code changes.
