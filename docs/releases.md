# Releases

Noah uses SemVer: `MAJOR.MINOR.PATCH`.

## Version Policy

- Public release tags use `vX.Y.Z`, for example `v0.1.0`.
- Docker image tags use both SemVer and immutable git SHA tags.
- `latest` is not a documented upgrade target.
- Until `1.0.0`, minor releases may contain breaking changes, but they must be documented in `CHANGELOG.md` and `docs/upgrades.md`.

## Release Artifacts

Each public release should include:

- GitHub Release notes;
- source archive from the tag;
- `CHANGELOG.md` entry;
- GHCR images for `api`, `room-state`, and `remote-browser`;
- image tags for SemVer and git SHA;
- known limitations;
- upgrade and rollback notes.

Public Docker images are published by `.github/workflows/docker-release.yml` to GHCR when a `v*` tag is pushed or when the workflow is manually dispatched for a release candidate.

The workflow intentionally fails if root `LICENSE` is missing, because public release images must not be published before the code license is explicit. Asset audit must still be complete before a public `v0.1.0` release.

The workflow also runs `tools/check-public-assets.mjs`; it fails if non-cleared scene bundles are included in the public runtime assets directory.

## Release Checklist

- [ ] Phase 0 safety gate is complete: secret scan, license audit, asset audit.
- [ ] Public repository history exposure is resolved, or the release is cut from a clean public mirror without proprietary scene blobs.
- [ ] `LICENSE` exists at repository root.
- [ ] `CHANGELOG.md` is updated.
- [ ] CI is green on `main`.
- [ ] Internal staging gate is green for the release commit.
- [ ] Self-host compose config check passes.
- [ ] Self-host smoke passes from a clean clone or clean Docker environment.
- [ ] GHCR images are published with SemVer and SHA tags.
- [ ] Upgrade rehearsal passes.
- [ ] Rollback rehearsal passes.
- [ ] GitHub Release is created from the SemVer tag.

## First Public Beta

The first public beta target is `v0.1.0`. It must be labeled as beta and include known limitations.

If an `0.1.0` release is broken after publication, publish a patch such as `v0.1.1` and mark the broken release as deprecated. Do not rely on deleting tags or images as the public rollback mechanism.
