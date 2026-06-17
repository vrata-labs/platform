# Scene Assets Repository Boundary

Vrata platform development and proprietary scene development must be separated.

## Decision

- The public platform repository owns runtime code, APIs, self-host infrastructure, scene bundle contracts, validators, and cleared sample assets.
- Private or customer-specific scene bundles live outside the public platform repository.
- Current `sense-*` scene bundles are not cleared for public redistribution and live in the private `psilon2000/noah-scene-assets-private` repository after migration snapshot `ea04324`.

## Why

- Scene rights are separate from platform source code rights.
- Platform users should be able to bring their own spaces without inheriting proprietary SenseTower assets.
- Scene iteration has different release cadence, validation needs, and access controls than platform runtime development.
- Public Docker images and source archives must not accidentally include non-redistributable assets.

## Target Repository

Private repository:

```text
psilon2000/noah-scene-assets-private
```

Recommended layout:

```text
assets/scenes/
  sense-hall2-v1/
    scene.json
    scene.glb
  sense-blueoffice-glb-v4/
    scene.json
    scene.glb
manifest.json
README.md
LICENSES.md
```

The private repository should document:

- source/provenance per scene;
- redistribution restrictions;
- export command or source project;
- validation status;
- intended staging room bindings;
- owner/contact for each scene family.

## Migration Tool

Use the non-destructive export tool from the platform repo:

```bash
node tools/export-private-scene-assets.mjs /path/to/noah-scene-assets-private/assets/scenes
```

The tool copies current `apps/runtime-web/public/assets/scenes/sense-*` directories and writes `manifest.json` next to the target `scenes` directory.

It does not delete anything from the platform repository. Deletion from the platform repository must be a separate commit after the private repository is created and staging has a working private asset fetch/publish path.

## Sync Tool

After the private scene-assets repository exists, a platform checkout can sync private scenes into the runtime public asset directory before internal staging build/deploy:

```bash
node tools/sync-private-scene-assets.mjs /path/to/noah-scene-assets-private/assets
```

The sync tool reads `/path/to/noah-scene-assets-private/assets/manifest.json` and copies listed `sense-*` scene bundles into `apps/runtime-web/public/assets/scenes`.

It does not delete existing platform assets. Public release workflows must not run this sync step.

Internal staging uses the GitHub Actions secret `PRIVATE_SCENE_ASSETS_DEPLOY_KEY` to checkout `psilon2000/noah-scene-assets-private`, uploads its `assets/` directory to `/opt/noah-private-scene-assets/assets` on the staging host, and runs the sync tool before staging scene snapshots are created.

## Staging Flow After Migration

- Platform CI builds and tests against cleared fixtures and public sample scenes only.
- Platform CI excludes Playwright tests tagged `@private-assets`.
- Private scene asset validation can run `pnpm test:e2e:private-assets` after mounting or syncing private scene bundles into the runtime public assets directory.
- Private scene-assets CI validates proprietary scene bundles separately.
- Internal staging deploy fetches private scene assets through the read-only deploy key stored in `PRIVATE_SCENE_ASSETS_DEPLOY_KEY`.
- Staging room manifests continue to bind through versioned `sceneBundleUrl` values.
- Public release workflows must not fetch private scene assets.

## Public Release Rules

- The public platform repo may include `livadia-nicholas-office-v1` and other cleared/generated sample scenes.
- The public platform repo must not include `sense-*` scene bundles unless redistribution rights are explicitly confirmed.
- The public platform repo must not include `research/exports*` Unity/SenseTower-derived export artifacts unless redistribution rights are explicitly confirmed.
- `tools/check-public-assets.mjs` blocks public GHCR release images if non-cleared scene bundle directories are present in `apps/runtime-web/public/assets/scenes`.
- Removing private assets from HEAD is not enough to make the current repository public if old git history still contains proprietary blobs.

## Migration Phases

1. [x] Create private scene-assets repository.
2. [x] Export `sense-*` bundles with `tools/export-private-scene-assets.mjs`.
3. [x] Commit exported assets and provenance notes in the private repository.
4. [ ] Add private asset validation/publish workflow.
5. [x] Update internal staging deploy to fetch the private repository and run `tools/sync-private-scene-assets.mjs` before snapshot/build/publish.
6. [x] Remove `sense-*` bundles from the public platform repository HEAD.
7. [x] Resolve public repository git-history exposure with a clean public import.
8. [x] Verify platform CI, self-host compose, public release guard, and internal staging gate.
