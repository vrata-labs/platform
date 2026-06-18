# Runtime

## Current baseline

- Runtime boot fetches room manifest from API.
- Join mode resolves between desktop and mobile today.
- Voice session planning fetches media token and `livekitUrl`.
- XR support and hardening are scaffolded, not yet wired to a renderer.

## Current runtime modules

- `apps/runtime-web/src/index.ts`
- `apps/runtime-web/src/voice.ts`
- `apps/runtime-web/src/xr.ts`
- `apps/runtime-web/src/hardening.ts`
- `packages/runtime-core/src/*`
