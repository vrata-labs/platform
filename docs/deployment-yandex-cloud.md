# Deployment - Yandex Cloud

## Local to staging path

- Local: single-node API + room-state + LiveKit + optional Postgres
- Staging: shared managed environment with public routing and secrets injected by environment

## Current artifacts

- `.env.example` for local defaults
- `infra/docker/` for local infrastructure skeleton
- `infra/yandex/` for future Terraform and cloud-init assets
- `infra/docker/compose.staging.yml` for the compose-based single-VM/staging stack
- `infra/yandex/cloud-init/staging-compose.yaml` for compose-oriented staging bootstrap

## Compose staging path

- Local stack validation: `docker compose --env-file infra/docker/.env.staging.example -f infra/docker/compose.staging.yml up -d --build`
- Local stack teardown: `docker compose --env-file infra/docker/.env.staging.example -f infra/docker/compose.staging.yml down -v`
- New staging VM bootstrap: `infra/yandex/scripts/provision-staging-compose.sh <instance-name>`
- Existing compose staging rollout on VM: `git pull && docker compose --env-file infra/docker/.env.staging -f infra/docker/compose.staging.yml build && docker compose --env-file infra/docker/.env.staging -f infra/docker/compose.staging.yml up -d`
- Registry-based rollout on VM: `docker login cr.yandex` -> `infra/docker/rollout-staging-images.sh <full-sha>`
- Rollback path on VM: rerun `infra/docker/rollout-staging-images.sh <previous-successful-sha>` without rebuild
- Current verified compose staging VM: `noah-stage-compose-v11` at `89.169.161.91`
- Primary public app URL: `https://89.169.161.91.sslip.io`
- Public room-state URL: `https://state.89.169.161.91.sslip.io`
- Public LiveKit URL: `https://livekit.89.169.161.91.sslip.io`
- Verified direct smoke endpoints on compose staging: `http://<ip>:4000/health`, `http://<ip>:4000/rooms/demo-room`, `http://<ip>:4000/control-plane`
- `pnpm test:e2e:staging` is currently intended to run against direct `BASE_URL=http://<ip>:4000` with `PLAYWRIGHT_NO_WEB_SERVER=1`
- Compose VM SSH is provisioned through rendered cloud-init users in `infra/yandex/scripts/provision-staging-compose.sh`; this was required for reliable rollback verification
- For sslip domain generation, use `${ip}.sslip.io` and subdomains like `state.${ip}.sslip.io`; avoiding hostname-prefix interpolation prevents invalid `..sslip.io` Caddy configs.

## Pending work

- DNS/certificate flow
- Backup policy for control-plane data
- Service-level health checks and dashboards beyond local smoke tests

## Scene bundle storage env

- Default compose/self-hosted path uses `SCENE_BUNDLE_PROVIDER=minio-default`
- Required MinIO vars for bundle URL resolution: `MINIO_PUBLIC_BASE_URL`, `MINIO_BUCKET`
- Alternate S3-compatible path uses:
  - `SCENE_BUNDLE_PROVIDER=s3-compatible`
  - `SCENE_BUNDLE_S3_ENDPOINT`
  - `SCENE_BUNDLE_S3_REGION`
  - `SCENE_BUNDLE_S3_BUCKET`
- `SCENE_BUNDLE_S3_PUBLIC_BASE_URL`
- Current Phase 3 publish flow only registers metadata by `storageKey`/public URL; it does not upload bundle files through the API.

## CI image publish contract

- Phase 4 target registry: `Yandex Container Registry`
- Live registry id: `crp9cm29k6p76hqo8lti`
- Expected image names:
  - `cr.yandex/crp9cm29k6p76hqo8lti/noah-api`
  - `cr.yandex/crp9cm29k6p76hqo8lti/noah-room-state`
- Immutable tag for future deploy handoff: full `git sha`
- Alias tags are limited to `staging` and branch slug
- Current publish workflow expects GitHub secrets:
  - `YCR_REGISTRY_ID`
  - `YCR_USERNAME` (`json_key`)
  - `YCR_PASSWORD`
- Current GitHub publish service account: `noah-gh-ycr-pusher` (`ajegfvegcehvb09mj977`)

## Staging deploy workflow

- Workflow file: `.github/workflows/staging-deploy.yml`
- Deploy input contract: immutable full `git sha`
- Remote rollout updates `IMAGE_TAG` in `infra/docker/.env.staging`, then runs `docker compose pull` and `docker compose up -d --no-build`
- Post-deploy smoke for this phase is limited to:
  - `/health`
  - `/rooms/demo-room`
  - `/control-plane`
- Verified GitHub Actions workflow_dispatch run: `23801431402`
