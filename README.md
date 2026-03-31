# noah

Monorepo skeleton for a web-native immersive room platform MVP.

See `docs/product-scope.md` for scope and `docs/architecture.md` for the layer map.

## Staging notes

Default post-change verification flow:

- After finishing code changes, publish the current changes to staging and verify them there, not only locally.
- Run the full local e2e suite first: `pnpm test:e2e`.
- Then run staging verification on the current staging host: at minimum `pnpm test:e2e:staging`.
- If the change affects runtime behavior, deployment, room manifests, scene bundles, or staging infrastructure, also verify the important public staging flows directly: room load, selector/navigation when relevant, and key scene rooms such as Hall and BlueOffice.
- Do not treat local green tests as sufficient for runtime/staging-facing changes unless staging verification is also green.

Practical scene-bundle staging workflow used during SenseTower migration:

- Put scene bundle files under `apps/runtime-web/public/assets/scenes/<scene-id>/`.
- Commit the bundle changes to the deployment branch `deploy/scene-bundles-stage-20260328` and push to GitHub.
- Create or update a stage room through the API, then patch its `sceneBundleUrl` to a published bundle URL.
- Prefer `raw.githubusercontent.com` for freshly changed bundles; use jsDelivr for more stable public links once CDN cache catches up.

Typical room patch flow:

```bash
curl -X PATCH "$BASE/api/rooms/$ROOM_ID" \
  -H 'content-type: application/json' \
  -H 'x-noah-admin-token: noah-stage-admin' \
  -d '{"sceneBundleUrl":"https://raw.githubusercontent.com/psilon2000/noah/deploy/scene-bundles-stage-20260328/apps/runtime-web/public/assets/scenes/<scene-id>/scene.json"}'
```

Known staging pitfalls:

- Stage `/assets/...` could return `404`; this caused many false negatives during scene validation.
- `apps/api/src/index.ts` now falls back to serving assets from both `apps/runtime-web/dist` and `apps/runtime-web/public`, but remote bundle URLs were still the most reliable external test path.
- Old stage VMs were often not worth patching in place; spinning up a fresh VM from `infra/yandex/cloud-init/staging-scenes.yaml` was usually faster.
- Some scenes load slowly; do not treat early fallback as a final failure without waiting for diagnostics.
- `Cinema` showed that a bad spawn point can look like a broken export even when the scene itself is fine.

## Compose staging

Phase 2 compose-based staging is now real and validated.

- Bootstrap a fresh compose staging VM with `infra/yandex/scripts/provision-staging-compose.sh <instance-name>`
- Current verified compose host is `noah-stage-compose-v11`
- Primary public app URL: `https://89.169.161.91.sslip.io`
- Direct app fallback: `http://89.169.161.91:4000`
- Public room-state URL: `https://state.89.169.161.91.sslip.io`
- Public LiveKit URL: `https://livekit.89.169.161.91.sslip.io`
- Local validation path remains `docker compose --env-file infra/docker/.env.staging.example -f infra/docker/compose.staging.yml up -d --build`
- Staging rollout on the VM is `git checkout <commit>` or `git pull`, then `docker compose --env-file infra/docker/.env.staging -f infra/docker/compose.staging.yml build && docker compose --env-file infra/docker/.env.staging -f infra/docker/compose.staging.yml up -d`
- Verified staging checks for Phase 2: `/health`, `/rooms/demo-room`, `/control-plane`, `pnpm test:e2e:staging`, and manual Hall/BlueOffice diagnostics
- Verified rollback path for Phase 2: switch to previous commit, rebuild with the same compose file, bring the stack back up, and confirm `/health` plus `/rooms/demo-room`
- For sslip/Caddy, use the `*.sslip.io` hostnames above; bare `http://<ip>` or `https://<ip>` is not the stable public path.
- Staging e2e should now run against the public HTTPS app URL and validate selector flow plus the full restored scene catalog. Stable baseline scenes such as Hall, BlueOffice, and ArtGallery are checked for `sceneDebug.state=loaded`; the rest are covered by HTTPS room-shell + manifest + diagnostics smoke so catalog regressions are still caught.

## Container smoke

Phase 1 container smoke commands:

Docker build context inputs used by the current Dockerfiles:

- Root: `package.json`, `pnpm-lock.yaml`, `pnpm-workspace.yaml`, `tsconfig.base.json`
- App manifests/config: `apps/api/package.json`, `apps/room-state/package.json`, `apps/runtime-web/package.json`, `apps/control-plane/package.json`, all `apps/*/tsconfig.json`
- Source/build inputs: `apps/api/src/**`, `apps/room-state/src/**`, `apps/runtime-web/src/**`, `apps/runtime-web/public/**`, `apps/control-plane/src/**`
- Shared workspace packages if referenced by app builds: `packages/**`

- Required env for `api` smoke: `API_PORT`, `CONTROL_PLANE_ADMIN_TOKEN`, `ROOM_STATE_PUBLIC_URL`, `RUNTIME_BASE_URL`
- Required env for `room-state` smoke: `ROOM_STATE_PORT` if you want a non-default port; otherwise defaults are enough
- Optional for both: `POSTGRES_URL`, `LIVEKIT_URL`, `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET`

```bash
docker build -f apps/api/Dockerfile -t noah-api .
docker build -f apps/room-state/Dockerfile -t noah-room-state .

docker run --rm -p 2567:2567 -e ROOM_STATE_PORT=2567 --name noah-room-state noah-room-state

docker run --rm -p 4000:4000 \
  -e API_PORT=4000 \
  -e CONTROL_PLANE_ADMIN_TOKEN=noah-stage-admin \
  -e ROOM_STATE_PUBLIC_URL=ws://127.0.0.1:2567 \
  -e RUNTIME_BASE_URL=http://127.0.0.1:4000 \
  --name noah-api noah-api
```
