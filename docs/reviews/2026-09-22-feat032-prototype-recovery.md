# FEAT-032 continuation and prototype disposition

Base: a3a905ea3bcbe290e77fa4c7fc2dd92214097a4d.

The original prototype on feat/standard-room-templates at 39330f3 has 70 tracked
modified files (7,211 insertions, 829 deletions) and six untracked source/document
entries plus template assets. Its tracked binary-capable diff was saved before
implementation; the source worktree and its untracked inputs remain untouched.
The smaller feat/standard-room-templates-v2 versioned bridge (66d96b2) is already
represented in current platform history and is not replayed.

## Disposition of the original tracked files

REUSE means port the domain intention or scenario after comparing with current
code. It does not authorize copying old implementations over later fixes.

| Files | Disposition | Reason |
| --- | --- | --- |
| packages/shared-types/src/index.ts, index.test.ts | REWRITE | Current shared contracts already contain the versioned bridge. |
| packages/shared-types/src/media-objects.ts | REUSE | Surface allowlists belong in shared domain code; reconcile current media capabilities. |
| packages/shared-types/src/session-token.ts, session-token.test.ts | REWRITE | Preserve current signing/authentication and add only the required pinned template context. |
| packages/templates/src/index.ts, index.test.ts, registry.ts | REWRITE | Preserve historical definitions; add new immutable definitions, per-repository locks and pure materialization. |
| packages/templates/README.md, package.json | REWRITE | Match actual current exports, dependencies and mirror contract. |
| apps/api/src/index.ts, index.test.ts | REWRITE | Use current route/domain structure; no wholesale replacement of the composition root. |
| apps/api/src/storage.ts, storage.test.ts | REWRITE | Preserve current storage and schema extraction; implement guarded transitions and immutable snapshots in domain modules. |
| apps/api/Dockerfile, package.json | DROP | Current platform already packages the template dependency. |
| apps/control-plane/index.html, src/index.ts, src/index.test.ts, src/main.ts, src/styles.css | REUSE | Reconcile preview/defaults UI and tests with current room forms and API DTOs. |
| apps/control-plane/package.json | REWRITE | UI consumes DTOs rather than importing the template registry. |
| apps/room-state/src/index.ts, index.test.ts, state.ts | REWRITE | Add signed logical surface context without importing registry or old reconnect behavior. |
| apps/runtime-web/src/index.ts, index.test.ts | REUSE | Read pinned template metadata and preserve current boot/session contracts. |
| apps/runtime-web/src/main.ts | REWRITE | Keep composition-only wiring; add domain behavior outside main. |
| apps/runtime-web/src/reconnect.ts, reconnect.test.ts, room-state-client.ts, room-state-client.test.ts | DROP | Prototype template migration/reconnect behavior is out of scope; preserve current reconnect and seat-release fixes. |
| apps/runtime-web/src/runtime-errors.ts, runtime-errors.test.ts, runtime-startup.ts, runtime-startup.test.ts | REWRITE | Add only required verified-asset/template errors; preserve current startup ownership. |
| .env.example | REWRITE | Optional namespaced mirror root instead of mandatory single-repository asset root. |
| .github/workflows/ci.yml | REWRITE | Matrix of exact repository revisions and template/scene validation. |
| .github/workflows/staging-deploy.yml | REWRITE | Add only guarded activation/rehearsal/rollback steps when their prerequisites exist. |
| infra/docker/.env.production.example, .env.selfhost.example, .env.staging.example | REWRITE | Keep existing unrelated configuration; add only mirror/rollout inputs. |
| infra/docker/compose.production.yml, compose.selfhost.yml, compose.staging.yml | REWRITE | Preserve current image/media paths and add narrowly scoped template configuration. |
| infra/docker/rollout-staging-images.sh | REWRITE | Preserve registry rollout; guarded catalog rollback must precede any rollback image change. |
| infra/yandex/cloud-init/staging-compose.yaml | DROP | No new VM/bootstrap requirement for template delivery. |
| playwright.config.ts | DROP | Current wrapper/configuration is the execution contract. |
| pnpm-lock.yaml | REWRITE | Regenerate only for actual current dependency changes. |
| tests/e2e/runtime.spec.ts, runtime-staging.spec.ts | REUSE | Port template create/default/pinned-room scenarios into focused specs. |
| tests/e2e/m0.5/join-leave-rejoin.spec.ts, motion-smoothing.spec.ts, presence-orientation.spec.ts, spatial-audio-diagnostics.spec.ts | DROP | No unrelated baseline weakening or presence refactor. |
| tests/e2e/m1-media/m1-media-acceptance.spec.ts, multi-surface-layouts.spec.ts, remote-browser-rutube.spec.ts, whiteboard-object.spec.ts | REWRITE | Keep existing regression obligations; add product-template coverage separately. |
| tools/patch-staging-scene-bundles.mjs, scene-asset-tools.test.mjs | DROP | Legacy private-room patching is not reference-template activation. |
| README.md, docs/api-contracts.md, asset-license-audit.md, control-plane.md, observability.md, postgres-baseline.md, product-scope.md, runtime.md, security.md | REWRITE | Describe only delivered contracts and exact current evidence. |

Untracked prototype template-layout code is a reference for a new pure matcher,
not a replacement for the current scene lifecycle. The room-templates document
and room-template types must be reconciled with current versioned contracts.
SVG preview/fallback assets are not product scene previews. The broad rollout
test is not imported without the new guarded activation design.

## Confirmed decisions and remaining gates

The user selected the accepted eight-seat Meeting Room and will perform all three
physical device checks. Personal/Presentation 0.4.1 visual acceptance is explicit.
Shipping budget for Meeting, new versioned template contracts, Wave 2/3 integration,
cross-device acceptance and production promotion remain separate work items.
