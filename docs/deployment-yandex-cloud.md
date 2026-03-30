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

## Pending work

- Real staging manifests and bootstrap scripts
- DNS/certificate flow
- Backup policy for control-plane data
- Service-level health checks and dashboards beyond local smoke tests
