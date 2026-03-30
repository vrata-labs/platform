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
- Rollback path on VM: `git checkout <previous-commit> && docker compose --env-file infra/docker/.env.staging -f infra/docker/compose.staging.yml build && docker compose --env-file infra/docker/.env.staging -f infra/docker/compose.staging.yml up -d`
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
