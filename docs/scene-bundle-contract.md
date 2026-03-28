# Scene Bundle Contract v1

`noah` v1 does not read Unity `.unity` scenes directly. A room can optionally point to a scene bundle manifest URL, and the runtime loads the bundle as a web scene.

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
- `notes`: free-form export notes

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
  "notes": "v1 export without Unity behaviors"
}
```

## Runtime behavior

- If `sceneBundle.url` is missing, runtime uses the built-in fallback room.
- If `scene.json` fails validation or has an unknown `schemaVersion`, runtime uses the fallback room.
- If `scene.glb` fails to load, runtime uses the fallback room.
- Successful scene bundle load hides the fallback meshes and applies the first spawn point to the player root.
