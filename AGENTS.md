# Project Notes

## Scene bundles and runtime

- `apps/api/src/index.ts` room manifest supports optional `sceneBundle.url`; runtime boot reads it through `apps/runtime-web/src/index.ts`.
- Scene bundle parsing/loading lives in `apps/runtime-web/src/scene-bundle.ts` and `apps/runtime-web/src/scene-loader.ts`.
- Runtime diagnostics for scene bundles are emitted from `apps/runtime-web/src/main.ts` and include `sceneDebug` payloads with screenshot stats, bounds, camera, mesh/material counts, missing assets, and material samples.
- `?debug=1` enables debug screenshot capture; `?mat=basic` and `?mat=wire` are material override debug modes; `?clean=1` enables clean scene mode; `?scenefit=0` disables debug auto-fit.

## Confirmed working Hall path

- The first reliable Hall asset is not raw FBX. It is the exported GLB at `/mnt/d/Repository/project-noah/examples/assets/TheHallScene.glb`.
- Working Hall scene bundle file is `apps/runtime-web/public/assets/scenes/sense-hall2-v1/scene.json` and it points to `scene.glb`.
- A working browser setup was derived from `/mnt/d/Repository/project-noah/examples/my-example.html` and `/mnt/d/Repository/project-noah/examples/my-example1.html`.
- The A-Frame example uses `TheHallScene.glb` almost as-is with a simple setup: `gltf-model`, `renderer="physicallyCorrectLights: true;"`, one ambient light, and no custom material overrides.
- For this Hall GLB, raw FBX import paths were misleading and produced black/empty results even when geometry technically loaded.

## Clean mode behavior

- Clean mode was added in `apps/runtime-web/src/main.ts` to mimic the A-Frame setup more closely.
- In clean mode the runtime hides fallback environment meshes (`floor`, `grid`, `roomBox`) but keeps `displaySurface` visible.
- Clean mode also removes fog and enables a simple ambient-light-driven path, which helped the Hall GLB become visible.
- The current Hall review URL used `?debug=1&clean=1&scenefit=0`; this was the first combination that produced a usable result.

## Office findings

- Office is easier to inspect visually than Hall, but broad material overrides made it worse.
- The useful per-material diagnostics live in `sceneDebug.materialSamples` and should be used before changing Office materials again.
- Coarse wildcard or forced-color overrides for Office are a bad path; if Office is revisited, fix one concrete material at a time.

## What did not work

- Raw FBX import of Hall assets from SenseTower (`hall2_walls.fbx`, `walls_3_1.fbx`) produced misleading black/blue/gray output and was not a reliable baseline.
- Hall black screens were not only a material problem; even `MeshBasicMaterial` / wireframe overrides stayed black for the FBX path.
- Several stage issues were caused by asset publishing mistakes, not rendering logic.

## Staging and asset publishing

- Temporary Yandex Cloud stage VMs were repeatedly created from `infra/yandex/cloud-init/staging-scenes.yaml` because direct SSH/update flow on older staging hosts was unreliable.
- One real failure mode: stage `/assets/...` requests returned `404`, which made scene bundle tests misleading.
- `apps/api/src/index.ts` now has a fallback to serve static assets from both `apps/runtime-web/dist` and `apps/runtime-web/public`.
- For reliable external testing, a CDN-hosted scene bundle URL worked well: `https://cdn.jsdelivr.net/gh/psilon2000/noah@deploy/scene-bundles-stage-20260328/apps/runtime-web/public/assets/scenes/sense-hall2-v1/scene.json`.

## Telegram / historical context

- Chat with `@instavr` contains useful historical context about SenseTower scenes.
- Important takeaway from that chat: previous production-like scene delivery was based on Unity Addressables / `SceneInstance`, not on universal FBX imports.
- Messages there mention `catalog_Sense.json`, `NewYearHall`, and loading scenes as scenes rather than as `GameObject`s.
- This explains why direct FBX import into web runtime was a poor approximation of the original Sense pipeline.

## Practical guidance for future work

- For SenseTower scene migration, prefer existing exported GLB/GLTF assets over raw FBX whenever possible.
- When something looks black or wrong, first inspect `sceneDebug` diagnostics before tweaking spawn/materials by hand.
- If a scene already worked in another web project, copy its rendering assumptions first and only then adapt to `noah`.

## Confirmed Unity export path

- A working batch export path exists with Windows Unity Editor `D:\Unity\Editor\2021.3.25f1\Editor\Unity.exe`.
- `ST.RemoteScene.BlueOffice` already includes `org.khronos.unitygltf` and can export scenes in batch mode through `Assets/Editor/BatchGlbExport.cs`.
- The successful batch command shape is: `Unity.exe -batchmode -quit -projectPath <project> -executeMethod BatchGlbExport.ExportSceneToGlb -scene <scenePath> -outputDir <dir> -logFile <log>`.
- Scene diagnostics can be dumped in batch mode through `Assets/Editor/BatchSceneDiagnostics.cs` to inspect shaders, materials, textures, and lightmap usage before export fixes.
- `BlueOffice.glb` was exported successfully into `research/exports/BlueOffice.glb`, then improved with conversion passes into `research/exports-converted/BlueOffice.glb`, `research/exports-converted-v2/BlueOffice.glb`, and `research/exports-converted-v3/BlueOffice.glb`.
- The first practical material-fix path is export-time conversion of `Shader Graphs/Lightmapped` and `Shader Graphs/SenseShader` materials into `URP/Lit` with selective mapping from `_Diffuse`, `_MainColor`, `_AO`, `_Normal_Map`, and related properties.
- Forced use of `_Lightmap` as occlusion for converted materials made Office worse; this should be avoided unless a material is verified individually.
- The main `SenseTowerVR` projects at `/mnt/d/repository/_SenseCapital/SenseTowerVR` and `/mnt/d/sensetowervr` use Unity `2021.3.25f1` but do not yet include `org.khronos.unitygltf`; add that package before attempting batch scene export there.
