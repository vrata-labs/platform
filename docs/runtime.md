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

## PDF presentations

- Hosts and assigned presenters can upload a validated PDF from the Documents panel and select an available room surface.
- Page changes, large mode, and the selected document are authoritative `pdf-presentation` media-object state. Full room snapshots restore the current page for late joiners while the room-state process remains alive.
- Participants render the active PDF through the authenticated presentation-content endpoint. Library download permission is not required to view the in-room surface.
- Browser rendering uses PDF.js canvas textures. Thumbnails are lazy browser renders and the HUD caps the visible thumbnail strip at 50 pages; documents may contain up to `PDF_PRESENTATION_MAX_PAGES` pages, default `250`.
- Native PowerPoint editing, slide animations, and persistence across a room-state service restart are not included.
