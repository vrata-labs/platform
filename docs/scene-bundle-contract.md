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

Example:

```json
{
  "schemaVersion": 1,
  "sceneId": "sense-hall-v1",
  "label": "Sense Hall",
  "source": "sensetowervr",
  "glbPath": "scene.glb",
  "spawnPoints": [
    {
      "id": "main",
      "position": { "x": 0, "y": 0, "z": 6 }
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
- Successful scene bundle load shows `attributions` in the HUD when present.
