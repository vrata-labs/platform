# Project Notes

## Agent instruction priority

- Treat this `AGENTS.md` as the project-specific operating contract for Vrata. Read it before deciding that a task is done.
- Вести диалог с пользователем на русском языке, если пользователь явно не попросил другой язык.
- For code changes in this repository, the default definition of done is: local verification -> `git commit` -> `git push` -> normal CI/CD staging deploy -> staging verification on the deployed commit.
- Do not stop after local tests when a change affects runtime behavior, deployment behavior, room manifests, scene bundles, or staging infrastructure. If commit/push/deploy is blocked by a higher-priority instruction or missing credentials, state that blocker explicitly and ask one short question.
- In final reports after code changes, include the commit SHA, CI/Docker/Staging run IDs or URLs, local verification results, staging verification results, and any rollback/retry notes.

## Scene bundles and runtime

- For every scene-authoring or scene-quality task, read `docs/scene-quality-contract.md` and use `docs/scene-authoring-task-template.md` before authoring or resuming publication. This is shared across all room types and scene repositories.
- Every visible object needs real meaning, plausible use, construction and support; apply User/Builder/Physics passes to final geometry. Passive/deferred props are valid without implemented runtime interaction.
- Inspect actual source/browser images against the accepted visual benchmark. Realistic materials and photographic-quality distant surroundings are required unless the user explicitly requests another style. Hashes, mesh tags, self-calibrated PHASH/NCC and `loaded` do not close this quality gate.
- A failed role/visual check or unresolved user rejection means `REWORK_REQUIRED`, even with green CI. Propagate general feedback to the shared contract and every in-scope scene before the next scene; do not ask the user to rediscover known defects.

- `apps/api/src/index.ts` room manifest supports optional `sceneBundle.url`; runtime boot reads it through `apps/runtime-web/src/index.ts`.
- Scene bundle parsing/loading lives in `apps/runtime-web/src/scene-bundle.ts` and `apps/runtime-web/src/scene-loader.ts`.
- Runtime diagnostics for scene bundles are emitted from `apps/runtime-web/src/main.ts` and include `sceneDebug` payloads with screenshot stats, bounds, camera, mesh/material counts, missing assets, and material samples.
- `?debug=1` enables debug screenshot capture; `?mat=basic` and `?mat=wire` are material override debug modes; `?clean=1` enables clean scene mode; `?scenefit=0` disables debug auto-fit.

## Runtime local pose and locomotion ownership

`apps/runtime-web` treats the local user transform as a domain object, not as a free mutable `THREE.Group`.

Ownership rules:

- The local `player` rig, `yaw`, and `pitchAngle` together form local pose.
- Only `apps/runtime-web/src/local/` may write `player.position`, `player.rotation`, `yaw`, or `pitchAngle`.
- Feature modules must not call `player.position.set(...)`, assign `player.position.x/y/z`, or assign `player.rotation.y` directly.
- Seating, teleport, spawn, scene debug fit, XR session start, vehicle/elevator-like behavior, and future local-user movement features must be expressed as locomotion modes, pose commands, or local pose transitions.
- Input modules convert raw keyboard/mouse/touch/XR samples into `InputIntents`; they do not move the player and do not send network commands.
- Interaction modules resolve rays and targets; target resolution must be pure and must not mutate pose, seating state, room state, or visuals.
- Seating modules own pending/authoritative seat state and may emit commands such as `send_seat_claim` / `send_seat_release`; they must not import `three` or mutate `THREE.Object3D`.
- Room-state callbacks must update domain state only. They must not directly reposition the local player outside the frame pipeline.
- XR input should be sampled once per frame and passed through a frame context so snap-turn, ray visibility, teleport, and seating all consume the same input sample.
- `main.ts` should remain a composition/orchestration root. Do not add new runtime behavior there when it belongs in local pose, input, interaction, seating, or locomotion modules.

Regression policy:

- Any change touching local pose, XR input, interaction ray, teleport, seating, or avatar publishing must include unit tests for the affected state transition.
- At minimum cover standing movement, seated movement lock, snap-turn, ray-intent suppression of snap-turn, teleport from seated, and seat claim/release behavior when relevant.
- Before considering the change complete, run `pnpm --filter @vrata/runtime-web build` and `pnpm --filter @vrata/runtime-web test`. For user-facing runtime behavior, also run the repository e2e/staging checks required by the testing policy.

Frame locomotion maintenance rules:

- The runtime locomotion refactor slices in `docs/arch/vrata_runtime_locomotion_refactor_prompt.md` are complete. Do not restart those slices as new work.
- Treat frame locomotion as maintenance-mode architecture: future behavior changes should be separate bugfix or feature tasks with focused tests.
- `apps/runtime-web/src/locomotion/frame-locomotion.ts` should remain the frame locomotion pipeline entry point, not a mixed domain implementation file.
- Keep XR-control planning in `apps/runtime-web/src/locomotion/frame-xr-controls.ts`, movement planning in `apps/runtime-web/src/locomotion/frame-movement.ts`, and frame command flushing in `apps/runtime-web/src/locomotion/frame-command-bridge.ts`.
- Preserve the rule that movement-stage input is collected after XR/confirm command execution, so post-confirm seating state is observed before movement planning.
- Preserve the frame command bridge flush semantics around `{ type: "confirm_interaction_target" }`: runtime commands flush before confirm and again after confirm.
- `updateMovement(...)` in `main.ts` should stay a short orchestration call that delegates through `executeFrameLocomotionPipeline(...)` and local `createFrameLocomotionHandlers(frameContext)`.
- Future runtime behavior changes should add or update tests in the specific domain module they touch: local pose, input, locomotion, interaction, seating, runtime commands, or avatar transport.
- Preserve the current acceptance invariants for direct pose writes, XR frame sampling, seating `three` imports, and main seat command routing.

## Confirmed working Hall path

- The first reliable Hall asset is not raw FBX. It is the exported GLB at `/mnt/d/Repository/project-vrata/examples/assets/TheHallScene.glb`.
- Working Hall scene bundle file is `apps/runtime-web/public/assets/scenes/sense-hall2-v1/scene.json` and it points to `scene.glb`.
- A working browser setup was derived from `/mnt/d/Repository/project-vrata/examples/my-example.html` and `/mnt/d/Repository/project-vrata/examples/my-example1.html`.
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
- To keep the current reserved staging IP on a fresh compose VM, run provisioning with `YC_NAT_ADDRESS=158.160.10.234`.
- The current compose staging host after Phase 2 is `vrata-stage-compose-v11` at static IP `158.160.10.234`; primary public app URL is `https://158.160.10.234.sslip.io`, direct smoke fallback is `http://158.160.10.234:4000`.
- Working public auxiliary domains are `https://state.158.160.10.234.sslip.io` for room-state and `https://livekit.158.160.10.234.sslip.io` for LiveKit.
- The practical publish/update path was: commit scene bundle changes to branch `deploy/scene-bundles-stage-20260328`, push to GitHub, and point stage rooms at raw GitHub or jsDelivr scene bundle URLs instead of depending on local VM assets.
- Compose staging rollout path is now: `git checkout <commit>` (or `git pull` on branch) -> `docker compose --env-file infra/docker/.env.staging -f infra/docker/compose.staging.yml build` -> `docker compose ... up -d`.
- Phase 5 switched the active staging rollout contract to registry images by SHA: `docker login cr.yandex` -> `infra/docker/rollout-staging-images.sh <full-sha>` -> `docker compose pull && up -d`.
- Rollback was verified on compose staging by switching between commits and rebuilding in place without deleting `postgres` or `minio` volumes; smoke after rollback should cover at least `/health` and `/rooms/demo-room`.
- Rollback for Phase 5 was also verified with registry images only: switching `IMAGE_TAG` to a previous published SHA and re-running rollout restored `/health`, `demo-room`, and `control-plane` without rebuild.
- Fresh stage VMs were usually easier than patching old ones in place; they were created with `yc compute instance create ... --metadata-from-file user-data=infra/yandex/cloud-init/staging-scenes.yaml,ssh-keys=<file>`.
- For compose VMs, SSH access was made reliable by rendering a real user with `ssh_authorized_keys` directly into cloud-init instead of relying only on OS Login metadata.
- One compose-specific failure mode was generating invalid sslip domains (`..sslip.io`); the safe pattern is `${ip}.sslip.io` plus subdomains like `state.${ip}.sslip.io` and `livekit.${ip}.sslip.io`.
- Stage rooms were created/updated through the API with `x-vrata-admin-token`, then patched to set `sceneBundleUrl` to the published bundle URL.
- Compose staging now keeps a restored room catalog for the main scene bundles: Hall, BlueOffice, LectureHall, Showroom, MeetingSmall, Cinema, Anastasia, NewGallery, ArtGallery, Standup, OporaRussia, SergOffice, and CinemaModeler.
- For quick validation, browser automation against public room URLs plus `sceneDebug` diagnostics was more reliable than trying to introspect the VM directly.
- One real failure mode: stage `/assets/...` requests returned `404`, which made scene bundle tests misleading.
- `apps/api/src/index.ts` now has a fallback to serve static assets from both `apps/runtime-web/dist` and `apps/runtime-web/public`.
- One Phase 2 infra failure mode was transient registry instability from `quay.io` for MinIO; compose now uses `minio/minio` from Docker Hub instead.
- Phase 4 registry path is now live in `Yandex Container Registry` `crp9cm29k6p76hqo8lti` (`vrata`); published image names are `cr.yandex/crp9cm29k6p76hqo8lti/vrata-api` and `cr.yandex/crp9cm29k6p76hqo8lti/vrata-room-state`.
- GitHub Actions publish workflow is `.github/workflows/docker-publish.yml`; it publishes immutable SHA tags plus only `staging` and branch-slug aliases, and PRs do not publish images.
- Staging deploy workflow is `.github/workflows/staging-deploy.yml`; it deploys immutable SHA tags over SSH and its GitHub Actions `workflow_dispatch` path was verified with run `23801431402`, including post-deploy smoke (`/health`, `demo-room`, `control-plane`).
- Phase 6 upgraded `.github/workflows/staging-deploy.yml` into the mandatory staging gate: it now runs public smoke plus `pnpm test:e2e:staging`, persists the current successful SHA on the VM, and rolls back automatically on verification failure. Verified failed rollback run: `23804157870`; verified successful gated run: `23804311484`.
- Required GitHub secrets for YCR publish are `YCR_REGISTRY_ID`, `YCR_USERNAME=json_key`, and `YCR_PASSWORD` containing the full service account key JSON.
- Current Yandex service account for GitHub image pushes is `vrata-gh-ycr-pusher` (`ajegfvegcehvb09mj977`) with `container-registry.images.pusher` on folder `b1g2ndo07lr7l5q8bb08`.
- For reliable external testing, a CDN-hosted scene bundle URL worked well: `https://cdn.jsdelivr.net/gh/psilon2000/vrata@deploy/scene-bundles-stage-20260328/apps/runtime-web/public/assets/scenes/sense-hall2-v1/scene.json`.
- Raw GitHub bundle URLs were often safer than waiting for CDN cache refresh when a scene bundle had just changed.
- For smooth remote avatar movement, `apps/runtime-web/src/avatar/avatar-pose-buffer.ts` must normalize incoming pose frames onto a receiver-local timeline. Using sender `frame.sentAtMs` directly for playback on the receiver causes moving remote avatars to advance in chunks even when stationary remotes look fine. Keep sender timestamps only as an input for relative frame spacing/jitter calculations, not as the absolute playback clock.
- A common false negative was judging a scene too early: some heavy scenes like `ArtGallery` stayed in fallback for several seconds before transitioning to `loaded`.
- Another common false negative was blaming export quality when the real issue was spawn/framing; `Cinema` is the main example where bad initial positioning looked like a broken export.

## Telegram / historical context

- Chat with `@instavr` contains useful historical context about SenseTower scenes.
- Important takeaway from that chat: previous production-like scene delivery was based on Unity Addressables / `SceneInstance`, not on universal FBX imports.
- Messages there mention `catalog_Sense.json`, `NewYearHall`, and loading scenes as scenes rather than as `GameObject`s.
- This explains why direct FBX import into web runtime was a poor approximation of the original Sense pipeline.

## Practical guidance for future work

- For new project-authored scenes, use the accepted agentic deterministic authoring workflow in `docs/arch/2026-08-29-agentic-deterministic-scene-authoring.md`: LLM planning and visual iteration may be stochastic, but accepted Blend/scripts/provenance and release builds must be fixed and reproducible without another model call.
- Never leave accepted scene source only in chat, `/tmp`, model output, or local cache. Store the accepted DCC source, scene-specific authoring/export scripts, semantic review views, toolchain lock, rights verdict, checksums, and immutable bundle in the scene package.
- OpenCode is the current scene-authoring orchestrator, not a permanent runtime or service dependency. Keep the workflow model-agnostic and do not productize a generic authoring service until meeting, personal, and presentation room types have repeated the full source/reproducibility/rights/runtime gates.
- Promote an operation from scene-specific art code into reusable authoring core only after it recurs in at least two different room types; do not force the first scenes into a premature universal DSL.
- Scene manifests must express runtime coordinates after DCC/export transforms. For the accepted Blender Y-up path, semantic `(x, y, z)` becomes runtime `(x, y, -z)`; apply one tested adapter to spawn, seat anchors, and media surfaces instead of copying authoring coordinates.
- Verify the real scene spawn with `?debug=1&scenefit=0`; debug mode without `scenefit=0` applies auto-fit and cannot prove that the manifest spawn is usable.
- For SenseTower scene migration, prefer existing exported GLB/GLTF assets over raw FBX whenever possible.
- When something looks black or wrong, first inspect `sceneDebug` diagnostics before tweaking spawn/materials by hand.
- If a scene already worked in another web project, copy its rendering assumptions first and only then adapt to `vrata`.
- User preference: after substantial implementation work, prepare changes so they are ready to commit/push, and if the user asks to finish the task end-to-end they usually want commit + push included unless they explicitly say otherwise. Do not override higher-priority git safety rules when commit was not requested.
- User preference: all code changes made by the agent should be checked on stage, not only locally; if stage was not updated yet, finish by deploying and verifying there. Pure docs/notes-only changes such as `AGENTS.md` do not require a stage deploy.
- User preference: for publishing to staging, the normal path is `git commit` + `git push` through the existing CI/CD pipeline; this is expected and normal.
- User preference: do not prefer ad-hoc hot deploys over the normal publish pipeline. Use direct SSH/hot deploy only as an explicit exception when the user asks for it or when the pipeline path is unavailable and this exception is clearly called out.
- User preference: unless explicitly requested otherwise, implement user-facing/runtime functionality in the main platform path everywhere it applies, not only behind flags, in sandboxes, or in narrow fallback-only paths.
- User preference: do not default to feature-flag-only, sandbox-only, or fallback-only delivery when the request is for a real product feature; those paths are acceptable only when explicitly requested or when they are strictly required as temporary plumbing for the main path.
- After finishing code changes, default flow is not just local verification: publish the current changes to staging through the normal git-based pipeline and verify them there as well.
- Default verification after changes should include the full local e2e suite (`pnpm test:e2e`), then staging verification on the current staging host.
- Do not run `pnpm test:e2e:staging` as validation of a new local runtime change before that exact commit is pushed and deployed. Before push/deploy, only local verification is meaningful; any pre-push staging check is infrastructure/smoke information only and must not be presented as verification of the new change.
- Staging verification should include at least the staging smoke suite (`pnpm test:e2e:staging`), and for meaningful runtime changes it should also cover the key public flows on staging: room load, selector/navigation if relevant, and important scene rooms such as Hall/BlueOffice when scene behavior could be affected.
- Staging e2e now runs against the public HTTPS app URL and covers the full restored scene catalog; Hall, BlueOffice, and ArtGallery are the current baseline scenes that must also reach `sceneDebug.state=loaded`.
- Phase 7 productized the bundle metadata flow: bundle versions now have `status` and `isCurrent`, rooms can bind through current version semantics, but runtime still only trusts `room.sceneBundleUrl`.
- Phase 7 cleanup policy is metadata-only (`active` / `obsolete` / `cleanup-ready`); blob deletion is still intentionally out of scope.
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

## Testing policy

- New runtime/product features should be covered by automatic e2e whenever reasonably possible, not only by local unit/integration checks.
- Default expectation for user-facing feature work is two-level e2e verification: local `pnpm test:e2e` first, then verification against the published staging environment.
- Prefer adding or extending staging-facing automated scenarios instead of relying only on manual checks or indirect diagnostics.
- Manual staging checks are still valuable for XR/visual behavior, but they should complement automated e2e on published staging, not replace it.

## Avatar and audio platform notes

- Remote lipsync should use `LiveKit participant.audioLevel` as the primary signal; browser WebAudio analyser paths were unreliable for remote mouth motion on staging.
- Remote audible playback should keep the normal `track.attach()` / hidden audio element path; trying to route remote output only through `AudioContext` broke audible sound even when lipsync/debug signals still moved.
- Desktop self-view should default to `hands-only`; showing full self body/face in first-person web made the user see their own lips and face in the camera.
- VR avatar root must follow the tracked headset on all axes `x/y/z`, not just by moving the head node; otherwise outside observers see head/body drift and the local VR user can end up “inside” their own avatar.
- Remote avatar body height must use `poseFrame.root.y`; fixed body height breaks outside-view VR alignment even when the head pose is correct.
- Legacy `localBody` / `localHead` fallback meshes in `apps/runtime-web/src/main.ts` must stay hidden in avatar-enabled VR flow; otherwise the local user sees a ghost self avatar at a fixed height.
- Do not orient avatar bodies with `lookAt(...)`; it adds pitch/roll and can make capsules lie horizontally. Keep body orientation yaw-only and reset `rotation.x/z`.
- Real headset Hall check on `f3c3471` confirmed ray, snap-turn, teleport, and seat interaction as a working baseline. Future hand-marker fixes should stay in avatar hand/IK/pose paths and avoid changing the already-working ray/turn/teleport path unless new telemetry proves it is involved.
- In VR, the small self-avatar hand spheres are controller markers: they should track resolved XR hand world positions exactly after yaw/teleport, not be clamped like desktop/mobile procedural hands.
- Real headset Hall check on `6f220bd` confirmed the full current VR baseline: ray, snap-turn, teleport, seat interaction, and self hand marker sphere all align correctly.
- The room HUD in `apps/runtime-web/index.html` now includes main-path audio controls: microphone selector, speaker selector, `Mic level`, and `Speaker level`.
- `Speaker level` is more reliable when derived from remote `participant.audioLevel` than from output analyser nodes.
- Staging-facing tests should avoid brittle assumptions about room names or transient loading text; prefer stable selectors and polling for the concrete control that the feature adds.

## Provider-neutral staging rollout

- The staging stand is created on demand (section below): Selectel `vrata-platform-stage`, floating IP `111.88.217.54`, `/opt/vrata`. Host preparation alone is not an accepted application deployment; verify the exact CI/CD run and authoritative record before reporting staging success.
- The current portable operating contract is `docs/deployment-staging.md`. Yandex host addresses and provisioning notes above are historical context for this migration.
- Authoritative release metadata lives outside checkout in `/opt/vrata-stage-state/accepted-release.json`; the legacy successful-SHA file is derived metadata. Candidate `IMAGE_TAG` is never proof of acceptance.
- New hosts require designation and explicit manual `bootstrap`. Ordinary rollout requires accepted state and finalized template baseline. Perform read-only preflight with bootstrap-installed helpers before uploading a new protocol or scene source.
- Before accepted publication, failure restores previous images, scene bytes and room pointers. After atomic JSON publication, metadata errors require explicit repair; do not roll back containers while leaving the new accepted record.
- Preserve host operation locking, exact image/asset SHA bindings, immutable scene snapshots, the active pointer, previous/Wave 2 retention and private recovery artifacts. Keep private scenes outside public platform images and git.
- The staging gate takes the expected reference catalog from the host database before rollout (`staging-template-catalog.py catalog-state`): a host with the active catalog fails on a mismatch, and only a new host on Wave 2 skips the checks that need reference rooms.
- The staging gate holds deployment-specific checks only. Client-only twins stay local; the heaviest multi-participant scenarios and media scenarios whose CI network path is unreliable are `@staging-extended` (`.github/workflows/staging-extended.yml`): run them under a lease before a release or around an irreversible activation. Rutube reports after every deploy and never blocks. A new host's bootstrap gate is smoke only; its catalog activation runs the full staging suite.
- `STAGING_AUTO_DEPLOY_ENABLED` belongs to `vrata-stage`: `true` while the stand exists, `false` otherwise. `false` pauses automatic deploy and the daily scheduled canary only; manual verification remains available. Deploy and Rutube canary have separate concurrency groups.
- The bundled S3 storage is SeaweedFS behind the historical compose service `minio` (port 9000, `MINIO_*` variables, `minio-default` provider): renaming any of them changes the room-plugin storage fingerprint, accepted-release foundations and rollout scripts. Its public route in Caddy passes only `GET`/`HEAD`/`OPTIONS` of non-empty public-bucket keys without a query, checked on the raw path (`tools/storage-route.test.mjs`); the private plugin probe expects 403 for everything else. Compose files pin the hash of `storage-server.sh`, so update it together with the script.
- Staging backup uses `tools/backup-staging.py`: a release accepted on MinIO gets the common pinned MinIO override, a newer one runs the storage images of its own Compose. It checks the working accepted image and includes accepted metadata in the checksum manifest. An export spanning a release change is incomplete, not a verified recovery point.

## On-demand staging stand

The staging stand exists only while a session, CI or the owner needs it, and is shared by every Claude Code and opencode session on the operator machine. `tools/vrata-stage.py` (installed as `vrata-stage`) creates and removes it and keeps leases; plan and design: `docs/plans/2026-10-25-on-demand-stages.md`, operations: `docs/deployment-staging.md`.

- Create, remove or recreate the stand only through `vrata-stage`. Never stop, shelve, delete or rebuild staging servers through the Selectel API or panel, and never touch production.
- Take a lease before any use of the stand: a push or merge to `main` that deploys to staging, dispatching Staging Deploy, Template Catalog or Staging Smoke, `pnpm test:e2e:staging` or Rutube suites, SSH to the host, or asking the user to check something on staging: `vrata-stage acquire platform --purpose deploy|e2e|manual|debug --note "<task>"`. The command prints the lease id.
- An absent stand is created by the first lease: a new server with the same address and host key, then Staging Deploy with `bootstrap=true`, identity v2 and the codec-3 media boundary for the latest `main` SHA with a successful Docker Publish, and the gated reference catalog activation on that SHA (about two hours with both gates). While `phase` is `creating`, repeat `vrata-stage wait platform`; each call returns within 9 minutes. To verify an exact commit, push it first or pass `--sha` to the lease that creates the stand.
- Hold a lease only while you actually use the stand. A running CI deploy protects the stand by itself; waiting for review, local builds or thinking are not reasons to keep it.
- Before asking the user to check something on staging, take a `manual` lease and say until when the stand is kept; release it after the answer. The user keeps the stand with `vrata-stage hold platform --ttl 4h`.
- After staging verification, when abandoning the task or switching to work without the stand: `vrata-stage release <lease>`. The last release removes the stand after a pause unless a CI run still uses it.
- Never release or shorten leases of others; show a suspicious lease to the user. `vrata-stage down --force` only on the user's explicit request.
- A failed creation (no capacity in `ru-2c`, provider error, failed bootstrap deploy) is a blocker: report it with `vrata-stage status platform` and the log it names; do not create servers by hand.
- `vrata-stage` rebuilds a server whose build ends in a transient Nova fault (network allocation, no valid host), three builds at most, and repeats gh calls that fail on the network or on GitHub's side. Starting a workflow is never repeated blindly: after a lost answer the hook looks for its run by request id and dispatches again with the same id only if no run appeared.
- Final reports after staging work name the lease id, whether it was released, and the stand phase.
