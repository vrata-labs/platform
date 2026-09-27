# Staging MinIO registry recovery

Staging uses the existing MinIO `RELEASE.2025-02-28T09-55-16Z` and mc
`RELEASE.2025-03-12T17-29-24Z`. Both original Docker Hub and later Quay images
stopped serving these releases. The source binaries are still available from
upstream GitHub releases: the staging images are built on a digest-pinned Alpine
base with `ADD --checksum` for each binary and published to YCR. This is a
registry repair, not a change of MinIO release or storage provider.

Docker Hub was unavailable by 2026-09-12; Quay now returns 401 for both pinned
manifests. The previous staging rollout and rollback failed before verification
in run `36030173287`. Source release checksums and published YCR manifest digests:

- MinIO binary: `5cb1e6309f2bd70e7d0ca77f33782beac1745790deb4c1f94444f1e7dec5fcb6`; image: `cr.yandex/crp9cm29k6p76hqo8lti/vrata-minio@sha256:c83dd50c5efe2e3a962711a7c9fc77acfc55c3dad229da2146489f604afba387`.
- mc binary: `a92b5f1af200ca25d54d78432ef6b0c47fd4340abf9759ce5d10275cd57e3318`; image: `cr.yandex/crp9cm29k6p76hqo8lti/vrata-mc@sha256:d535999f5c4eb01c9c06bd0c068d4bb8f7366a8469fe57e394907190f7feb550`.

The source images are built from `infra/docker/minio.demo-local.Dockerfile` and
`infra/docker/mc.demo-local.Dockerfile` and verified by Docker Publish. The old
Quay manifest digests remain only as exact-match inputs to the rollback helper.

## Older deployments and automatic rollback

Changing only the current Compose file cannot fix rollback: older commits still
point to Docker Hub or Quay. `staging-deploy.yml` therefore saves
`tools/staging-minio-rollout.py` before checking out the requested SHA, then sends
that helper to a temporary file on the host for both deployment and rollback.
The helper invokes the selected commit's original `rollout-staging-images.sh`.

For the duration of that invocation, it translates only the four exact historical
`image:` values in `infra/docker/compose.staging.yml` to the two pinned YCR
manifest digests. It restores the original file bytes and permissions on success,
failure and handled termination signals. Already-YCR-pinned checkouts are not
rewritten. Other releases, custom image references, application SHA tags,
volume definitions and credentials are not changed. Like any process cleanup,
restoration cannot run after SIGKILL or host power loss; inspect `git diff` before
retrying an interrupted deployment rather than discarding unrelated changes.

This compatibility path is part of the normal serialized staging pipeline. It
does not bypass image pulls, application-image SHA assertions, the pre-rollout
scene snapshot, the scene-URL restore, public smoke, staging E2E or blocking
Rutube verification. An error from the original rollout is propagated unchanged.
Self-host and production Compose files are outside this staging-only repair.

## Checks

`node --test tools/staging-minio-rollout.test.mjs` covers translation, untouched
custom configuration, source restoration, failure propagation, signal handling
and workflow wiring. The existing scene rollback tests remain required.

Before accepting a registry change, pull the pinned images in an isolated Docker
project, run the actual bootstrap script, verify an object survives a container
recreation, and verify the legacy-reference compatibility path. Then use normal
CI/Docker publication and the deployed-commit staging gate. A healthy old API or
a successful manifest inspection alone is not acceptance of the new commit.
