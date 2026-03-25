# Deployment - Yandex Cloud

## Local to staging path

- Local: single-node API + room-state + LiveKit + optional Postgres
- Staging: shared managed environment with public routing and secrets injected by environment

## Current artifacts

- `.env.example` for local defaults
- `infra/docker/` for local infrastructure skeleton
- `infra/yandex/` for future Terraform and cloud-init assets

## Pending work

- Real staging manifests and bootstrap scripts
- DNS/certificate flow
- Backup policy for control-plane data
- Service-level health checks and dashboards beyond local smoke tests
