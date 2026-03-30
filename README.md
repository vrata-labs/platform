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
