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
- Compose-based staging bootstrap now lives in `infra/yandex/cloud-init/staging-compose.yaml`, and fresh compose hosts should be created through `infra/yandex/scripts/provision-staging-compose.sh`.
- The current compose staging host after Phase 2 is `noah-stage-compose-v11` at `89.169.161.91`; primary public app URL is `https://89.169.161.91.sslip.io`, direct smoke fallback is `http://89.169.161.91:4000`.
- Working public auxiliary domains are `https://state.89.169.161.91.sslip.io` for room-state and `https://livekit.89.169.161.91.sslip.io` for LiveKit.
- The practical publish/update path was: commit scene bundle changes to branch `deploy/scene-bundles-stage-20260328`, push to GitHub, and point stage rooms at raw GitHub or jsDelivr scene bundle URLs instead of depending on local VM assets.
- Compose staging rollout path is now: `git checkout <commit>` (or `git pull` on branch) -> `docker compose --env-file infra/docker/.env.staging -f infra/docker/compose.staging.yml build` -> `docker compose ... up -d`.
- Rollback was verified on compose staging by switching between commits and rebuilding in place without deleting `postgres` or `minio` volumes; smoke after rollback should cover at least `/health` and `/rooms/demo-room`.
- Fresh stage VMs were usually easier than patching old ones in place; they were created with `yc compute instance create ... --metadata-from-file user-data=infra/yandex/cloud-init/staging-scenes.yaml,ssh-keys=<file>`.
- For compose VMs, SSH access was made reliable by rendering a real user with `ssh_authorized_keys` directly into cloud-init instead of relying only on OS Login metadata.
- One compose-specific failure mode was generating invalid sslip domains (`..sslip.io`); the safe pattern is `${ip}.sslip.io` plus subdomains like `state.${ip}.sslip.io` and `livekit.${ip}.sslip.io`.
- Stage rooms were created/updated through the API with `x-noah-admin-token`, then patched to set `sceneBundleUrl` to the published bundle URL.
- Compose staging now keeps a restored room catalog for the main scene bundles: Hall, BlueOffice, LectureHall, Showroom, MeetingSmall, Cinema, Anastasia, NewGallery, ArtGallery, Standup, OporaRussia, SergOffice, and CinemaModeler.
- For quick validation, browser automation against public room URLs plus `sceneDebug` diagnostics was more reliable than trying to introspect the VM directly.
- One real failure mode: stage `/assets/...` requests returned `404`, which made scene bundle tests misleading.
- `apps/api/src/index.ts` now has a fallback to serve static assets from both `apps/runtime-web/dist` and `apps/runtime-web/public`.
- One Phase 2 infra failure mode was transient registry instability from `quay.io` for MinIO; compose now uses `minio/minio` from Docker Hub instead.
- For reliable external testing, a CDN-hosted scene bundle URL worked well: `https://cdn.jsdelivr.net/gh/psilon2000/noah@deploy/scene-bundles-stage-20260328/apps/runtime-web/public/assets/scenes/sense-hall2-v1/scene.json`.
- Raw GitHub bundle URLs were often safer than waiting for CDN cache refresh when a scene bundle had just changed.
- A common false negative was judging a scene too early: some heavy scenes like `ArtGallery` stayed in fallback for several seconds before transitioning to `loaded`.
- Another common false negative was blaming export quality when the real issue was spawn/framing; `Cinema` is the main example where bad initial positioning looked like a broken export.

## Telegram / historical context

- Chat with `@instavr` contains useful historical context about SenseTower scenes.
- Important takeaway from that chat: previous production-like scene delivery was based on Unity Addressables / `SceneInstance`, not on universal FBX imports.
- Messages there mention `catalog_Sense.json`, `NewYearHall`, and loading scenes as scenes rather than as `GameObject`s.
- This explains why direct FBX import into web runtime was a poor approximation of the original Sense pipeline.

## Practical guidance for future work

- For SenseTower scene migration, prefer existing exported GLB/GLTF assets over raw FBX whenever possible.
- When something looks black or wrong, first inspect `sceneDebug` diagnostics before tweaking spawn/materials by hand.
- If a scene already worked in another web project, copy its rendering assumptions first and only then adapt to `noah`.
- User preference: after substantial implementation work, prepare changes so they are ready to commit/push, and if the user asks to finish the task end-to-end they usually want commit + push included unless they explicitly say otherwise. Do not override higher-priority git safety rules when commit was not requested.
- After finishing code changes, default flow is not just local verification: publish the current changes to staging and verify them there as well.
- Default verification after changes should include the full local e2e suite (`pnpm test:e2e`), then staging verification on the current staging host.
- Staging verification should include at least the staging smoke suite (`pnpm test:e2e:staging`), and for meaningful runtime changes it should also cover the key public flows on staging: room load, selector/navigation if relevant, and important scene rooms such as Hall/BlueOffice when scene behavior could be affected.
- Staging e2e now runs against the public HTTPS app URL and covers the full restored scene catalog; Hall, BlueOffice, and ArtGallery are the current baseline scenes that must also reach `sceneDebug.state=loaded`.
- Do not treat local green tests as sufficient when the change affects runtime behavior, deployment behavior, room manifests, scene bundles, or staging infrastructure; publish and verify on staging by default.

## Current scene status

- **Working baselines**
- `Hall` — good baseline via `TheHallScene.glb`; clean mode + tuned spawn works.
- `BlueOffice` — usable baseline after Unity export + material conversion passes; still has some black patches.
- `TheLectureHall` — usable after lecture-hall material conversion pass.
- `showroom` — usable after foliage/two-sided fixes and bench tuning.
- `Meeting_small` — usable baseline; helper filtering was too aggressive once, so keep the original cleaned-by-spawn version as reference.
- `Cinema` — usable baseline; the main problem was spawn/positioning, not export quality.
- `Anastasia` — keep `sense-anastasia-glb-v1` as the stable baseline; `v2` conversion attempt fell back and should be debugged separately.

- **Exported but still needs a dedicated pass**
- `NewGallery` — exported, but still a heavy/dark case; requires targeted pass.
- `ArtGallery` — exported; can load slowly (~12s) and needs a targeted pass.
- `Standup` — exported; still dark and needs a material/framing pass.
- `OporaRussia_Mike` — exported; needs a dedicated pass.
- `Serg_Office_modeler` — exported; needs a dedicated pass.
- `Cinema_modeler` — exported; needs a dedicated pass.

- **Not worth prioritizing right now**
- `InfrastructureScene` — exported, but looks more like a technical scene than a user-facing room.
- `SceneForTest` — exported, but too small/test-like to matter.

- **Known export problem cases**
- `TheEnterScene` — current batch export crashes inside `BatchGlbExport.ConvertExportMaterials`.
- `TheOfficeSceneOld` — current batch export crashes inside `BatchGlbExport.ConvertExportMaterials`.

## Confirmed Unity export path

- A working batch export path exists with Windows Unity Editor `D:\Unity\Editor\2021.3.25f1\Editor\Unity.exe`.
- `ST.RemoteScene.BlueOffice` already includes `org.khronos.unitygltf` and can export scenes in batch mode through `Assets/Editor/BatchGlbExport.cs`.
- The successful batch command shape is: `Unity.exe -batchmode -quit -projectPath <project> -executeMethod BatchGlbExport.ExportSceneToGlb -scene <scenePath> -outputDir <dir> -logFile <log>`.
- Scene diagnostics can be dumped in batch mode through `Assets/Editor/BatchSceneDiagnostics.cs` to inspect shaders, materials, textures, and lightmap usage before export fixes.
- `BlueOffice.glb` was exported successfully into `research/exports/BlueOffice.glb`, then improved with conversion passes into `research/exports-converted/BlueOffice.glb`, `research/exports-converted-v2/BlueOffice.glb`, and `research/exports-converted-v3/BlueOffice.glb`.
- The first practical material-fix path is export-time conversion of `Shader Graphs/Lightmapped` and `Shader Graphs/SenseShader` materials into `URP/Lit` with selective mapping from `_Diffuse`, `_MainColor`, `_AO`, `_Normal_Map`, and related properties.
- Forced use of `_Lightmap` as occlusion for converted materials made Office worse; this should be avoided unless a material is verified individually.
- The main `SenseTowerVR` projects at `/mnt/d/repository/_SenseCapital/SenseTowerVR` and `/mnt/d/sensetowervr` use Unity `2021.3.25f1` but do not yet include `org.khronos.unitygltf`; add that package before attempting batch scene export there.
