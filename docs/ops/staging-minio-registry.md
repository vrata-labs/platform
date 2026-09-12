# Staging MinIO registry recovery

Staging uses the existing MinIO `RELEASE.2025-02-28T09-55-16Z` and mc
`RELEASE.2025-03-12T17-29-24Z`, now fetched from MinIO's Quay repositories and
pinned to their multi-platform manifest digests. This is a registry repair, not
an upgrade, a new storage provider or a security update.

The 2026-09-12 diagnostic run `34701066761` found both Docker Hub repositories
unavailable. Both Quay manifests were accessible from GitHub Actions and the
staging host. The MinIO manifest digest matched the existing staging image's
RepoDigest. The legacy mc image was no longer cached on staging.

- MinIO: `sha256:a929054ae025fa7997857cd0e2a2e3029238e31ad89877326dc032f4c1a14259`
- mc: `sha256:470f5546b596e16c7816b9c3fa7a78ce4076bb73c2c73f7faeec0c8043923123`

## Older deployments and automatic rollback

Changing only the current Compose file cannot fix rollback: older commits still
point to Docker Hub. `staging-deploy.yml` therefore saves
`tools/staging-minio-rollout.py` before checking out the requested SHA, then sends
that helper to a temporary file on the host for both deployment and rollback.
The helper invokes the selected commit's original `rollout-staging-images.sh`.

For the duration of that invocation, it translates only the two exact historical
`image:` values in `infra/docker/compose.staging.yml` to the same pinned Quay
releases. It restores the original file bytes and permissions on success,
failure and handled termination signals. Current, already-pinned checkouts are
not rewritten. Other releases, custom image references, application SHA tags,
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
