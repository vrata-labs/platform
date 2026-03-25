# Architecture Overview

## Layer map

### Runtime

Owns scene rendering, input, camera, presence visualization, XR session lifecycle, media surfaces, and quality profiles.

- App: `apps/runtime-web`
- Shared package: `packages/runtime-core`

### Media plane

Owns voice, screen share, track lifecycle, and media transport.

- Provider: `LiveKit`
- API integration: `apps/api`

### State plane

Owns room state, participant presence, transforms, and room logic.

- App: `apps/room-state`
- Provider: `Colyseus`

### Control plane

Owns tenants, templates, rooms, asset metadata, links, and deployment metadata.

- App: `apps/control-plane`
- API integration: `apps/api`

### Asset pipeline

Owns import rules, validation, compression presets, and quality budgets.

- Package: `packages/asset-pipeline`
- Templates: `packages/templates`

## Core flows

### Join room

1. User opens a room link.
2. `apps/runtime-web` fetches room manifest from `apps/api`.
3. Runtime requests state token and media token from `apps/api`.
4. Runtime joins `apps/room-state` and `LiveKit`.
5. Runtime renders the room using manifest-driven scene config.

### Create room

1. Admin opens `apps/control-plane`.
2. Control plane creates tenant/room records through `apps/api`.
3. Assets are registered and attached to template slots.
4. API generates the manifest and room link.
5. Runtime consumes the published room config without code changes.

## Boundaries that must hold

- Runtime never owns persistent tenant CRUD.
- Media plane never becomes the source of truth for room state.
- Research spikes never become the default product runtime.
- Templates configure scenes; they do not fork the runtime.

## Initial repository map

```text
apps/
  runtime-web/
  control-plane/
  api/
  room-state/
packages/
  runtime-core/
  shared-types/
  templates/
  asset-pipeline/
research/
  webrtc-lab/
  webxr-lab/
  webgl-lab/
  audio-lab/
infra/
  docker/
  yandex/
```
