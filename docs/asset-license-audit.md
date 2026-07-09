# Asset License Audit

This document tracks publishability of runtime assets before Vrata can be released as a public open source project.

## Policy

- Source code license is Apache-2.0.
- Asset licensing is separate from source code licensing.
- A scene, model, texture, preview, or avatar asset is not redistributable until its provenance is documented.
- Assets with unclear provenance must be removed from the public release, moved to a private/non-redistributable bundle flow, or replaced with cleared assets.

## Current Summary

- Cleared for public release: `livadia-nicholas-office-v1`, `the-hall-v1`, `the-office-v1`, and avatar recipe/catalog metadata JSON.
- Removed from the public tree/import: all `sense-*` scene bundles and `research/exports*` Unity/SenseTower-derived export artifacts.
- Private scene asset repository: `psilon2000/noah-scene-assets-private`, initial snapshot commit `ea04324`.
- Public `v0.1.0` release must use a clean public import/mirror rather than publishing the existing repository history, because removed assets still exist in older private history.

## Inventory

| Path | Source / Provenance | Status | Required Action |
| --- | --- | --- | --- |
| `apps/runtime-web/public/assets/scenes/livadia-nicholas-office-v1` | Original procedural Vrata scene; has `LICENSES.md` | cleared | Keep in public release |
| `apps/runtime-web/public/assets/avatars/catalog.v1.json` | Vrata avatar catalog metadata; no binary pack or thumbnails are present in the public tree | cleared | Keep in public release |
| `apps/runtime-web/public/assets/avatars/avatar-recipes.v1.json` | Vrata avatar recipe metadata authored for procedural/debug avatar flow | cleared | Keep in public release |
| `apps/runtime-web/public/assets/scenes/the-hall-v1` | Tiny inline GLTF fixture authored for Vrata e2e coverage; has `LICENSES.md` | cleared | Keep in public release |
| `apps/runtime-web/public/assets/scenes/the-office-v1` | Tiny inline GLTF fixture authored for Vrata e2e coverage; has `LICENSES.md` | cleared | Keep in public release |
| `apps/runtime-web/public/assets/scenes/sense-*` | Sense/research exports and SenseTower-derived scene assets | removed from public HEAD; not cleared | Kept only in private scene asset repositories or customer storage |
| `research/exports*` | Unity/SenseTower research exports and diagnostics | excluded from public import; not cleared | Keep outside the public repository |

## Recommended Public `0.1` Cut

- Keep source code and generated/original Vrata assets.
- Keep `livadia-nicholas-office-v1` as the main public sample scene.
- Keep documented `the-hall-v1` and `the-office-v1` e2e fixtures.
- Keep all `sense-*` bundles and `research/exports*` artifacts outside the public platform tree unless explicit redistribution rights are confirmed.
- Keep support for private scene bundles through self-host storage, so users can add their own spaces without bundling proprietary assets in the OSS repo.

See `docs/scene-assets-repository.md` for the repository boundary and migration flow.

## Required Before Public Release

- Do not make the existing repository history public; create the public repository from a clean import without historical `sense-*` blobs or `research/exports*` artifacts.
- Verify release Docker images do not include non-cleared assets.
- Keep `tools/check-public-assets.mjs` green in the public release workflow.
- If using a separate public mirror instead of history rewrite, verify the mirror starts from a clean tree without `sense-*` blobs or `research/exports*` artifacts.
