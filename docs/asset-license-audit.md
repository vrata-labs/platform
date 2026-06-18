# Asset License Audit

This document tracks publishability of runtime assets before Vrata can be released as a public open source project.

## Policy

- Source code license is Apache-2.0.
- Asset licensing is separate from source code licensing.
- A scene, model, texture, preview, or avatar asset is not redistributable until its provenance is documented.
- Assets with unclear provenance must be removed from the public release, moved to a private/non-redistributable bundle flow, or replaced with cleared assets.

## Current Summary

- Cleared for public release: source code, self-host bootstrap metadata, and avatar recipe/catalog metadata JSON.
- Removed from the public tree: all bundled scene asset directories, including `livadia-nicholas-office-v1`, `the-hall-v1`, `the-office-v1`, `sense-*`, and research/export artifacts.
- Private or customer-specific scene assets must live outside the public repository.
- Public `v0.1.0` release must use a clean public import/mirror rather than publishing the existing repository history, because removed assets still exist in older private history.

## Inventory

| Path | Source / Provenance | Status | Required Action |
| --- | --- | --- | --- |
| `apps/runtime-web/public/assets/avatars/catalog.v1.json` | Vrata avatar catalog metadata; no binary pack or thumbnails are present in the public tree | cleared | Keep in public release |
| `apps/runtime-web/public/assets/avatars/avatar-recipes.v1.json` | Vrata avatar recipe metadata authored for procedural/debug avatar flow | cleared | Keep in public release |
| `apps/runtime-web/public/assets/scenes/livadia-nicholas-office-v1` | Original procedural Vrata scene | removed from public HEAD and rewritten public history | Keep only in private scene asset repositories or customer storage |
| `apps/runtime-web/public/assets/scenes/the-hall-v1` | Small historical scene fixture | removed from public HEAD and rewritten public history | Keep only in private scene asset repositories or customer storage |
| `apps/runtime-web/public/assets/scenes/the-office-v1` | Small historical scene fixture | removed from public HEAD and rewritten public history | Keep only in private scene asset repositories or customer storage |
| `apps/runtime-web/public/assets/scenes/sense-*` | Sense/research exports and SenseTower-derived scene assets | removed from public HEAD; not cleared | Keep only in private repositories or customer storage |
| `research/exports*` | Unity/SenseTower research exports and diagnostics | excluded from public import; not cleared | Keep outside the public repository |

## Recommended Public `0.1` Cut

- Keep source code and metadata-only Vrata assets.
- Do not bundle scene asset directories in the public platform repository for `v0.1.0`; the default demo room uses the built-in fallback scene.
- Keep e2e scene-bundle coverage through inline data-url fixtures, not tracked scene asset files.
- Keep all `sense-*` bundles outside the public platform tree unless explicit redistribution rights are confirmed.
- Keep support for private scene bundles through self-host storage, so users can add their own spaces without bundling proprietary assets in the OSS repo.

See `docs/scene-assets-repository.md` for the repository boundary and migration flow.

## Required Before Public Release

- Do not make the existing repository history public; create the public repository from a clean current-tree import without historical `sense-*` blobs.
- Verify release Docker images do not include non-cleared assets.
- Keep `tools/check-public-assets.mjs` green in the public release workflow.
- If using a separate public mirror instead of history rewrite, verify the mirror starts from a clean tree without `sense-*` blobs.
