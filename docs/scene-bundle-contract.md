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
scenes/my-room-v1/
  scene.json
  scene.glb
  preview.jpg
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
- `renderMode`: `"default"` or `"clean"`; `clean` hides fallback debug geometry and uses the brighter scene lighting path
- `mediaSurfaces`: runtime media surface layout for scene-specific screens, whiteboards, or remote browser targets
- `preview`: relative preview asset path
- `notes`: free-form export notes

### `mediaSurfaces`

Scene bundles can override the built-in fallback media surface meshes without rebuilding the runtime image. This lets private scenes place screens and whiteboards where the GLB has frames, walls, or furniture.

Each entry describes one runtime-visible surface:

- `surfaceId`: media surface id. For v1 rooms, use ids known by the room media state, such as `debug-main`, `whiteboard-wall`, or `laptop-screen`.
- `label`: optional display label for runtime debug controls when the room state does not provide one.
- `kind`: optional semantic kind: `wall`, `table`, `laptop`, `floating`, or `custom`.
- `widthM`, `heightM`: physical plane size in meters.
- `widthPx`, `heightPx`: optional backing texture resolution; defaults to `1920 x 1080` or the matching built-in surface resolution.
- `transform`: `{ x, y, z, yaw, pitch, roll }` in meters/radians. `yaw`, `pitch`, and `roll` default to `0`.
- `visible`: optional runtime visibility, defaults to `true`.
- `allowedObjectTypes`: optional list of media object types this surface accepts when room state does not define the surface.

If `mediaSurfaces` is omitted, the runtime keeps the built-in fallback layout with the main wall screen, whiteboard wall, and laptop screen. If `mediaSurfaces` is present, only those scene-declared surface meshes are runtime-visible.

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
      "label": "Right wall screen",
      "kind": "wall",
      "widthM": 5.8,
      "heightM": 3.3,
      "widthPx": 1920,
      "heightPx": 1080,
      "transform": { "x": 3.83, "y": 2.35, "z": -0.05, "yaw": -1.5707963267948966 },
      "allowedObjectTypes": ["screen-share", "whiteboard", "remote-browser"]
    }
  ],
  "bounds": { "width": 24, "height": 8, "depth": 24 },
  "preview": "preview.jpg",
  "notes": "v1 export without Unity behaviors"
}
```

## Runtime behavior

- If `sceneBundle.url` is missing, runtime uses the built-in fallback room.
- If `scene.json` fails validation or has an unknown `schemaVersion`, runtime uses the fallback room.
- If `scene.glb` fails to load, runtime uses the fallback room.
- Successful scene bundle load hides the fallback meshes and applies the first spawn point to the player root.
- Successful scene bundle load applies `mediaSurfaces` when present; this replaces source-code-only screen placement for Docker image deployments.
