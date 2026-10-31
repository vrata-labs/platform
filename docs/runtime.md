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

## Entry, language and leaving

- Preflight (`#guest-onboarding`) asks for a display name only; the microphone is requested only by "Check microphone" or "Join Audio". A refused, missing or unusable microphone gets its own message and the guest enters muted. "Enter in VR" appears where an immersive session can start; once the room is ready, one press enters VR (`#vr-ready`), since the session needs a fresh user gesture.
- The critical UI (preflight, room actions and audio, statuses, XR menu, ended and left screens, the session update dialog) is in Russian and English: `apps/runtime-web/src/i18n/`. The language is the tab's choice, then `?lang=`, then the portal cookie `vrata-locale`, then the browser, else English. The switch in the panel changes texts in place; the address and the room session stay.
- "Leave the space" (panel button, XR menu) ends XR, removes the presence, stops media and room-state and goes to the way back from the grant exchange (`returnUrls`, made by the platform from `VRATA_RETURN_TARGETS`, see `docs/integration-api.md`). Without one it shows the left screen with "Return to the space". The tab keeps the way back next to the room identity, so a reload or Back enters the same room again.
- The XR menu opens with B or Y: microphone, "Back to screen" (ends only the XR session, the room stays), "Leave the space" (a second press within four seconds) and "Close". While it is open, locomotion gets a resting input sample. A system end of the XR session keeps the room as well.

## PDF presentations

- Hosts and assigned presenters can upload a validated PDF from the Documents panel and select an available room surface.
- Page changes, large mode, and the selected document are authoritative `pdf-presentation` media-object state. Full room snapshots restore the current page for late joiners while the room-state process remains alive.
- Participants render the active PDF through the authenticated presentation-content endpoint. Library download permission is not required to view the in-room surface.
- Browser rendering uses PDF.js canvas textures. Thumbnails are lazy browser renders and the HUD caps the visible thumbnail strip at 50 pages; documents may contain up to `PDF_PRESENTATION_MAX_PAGES` pages, default `250`.

## Image and video surfaces

- Hosts and assigned presenters can select validated PNG, JPEG, WebP, MP4, or WebM documents for any compatible media surface.
- `image-viewer` state synchronizes document identity and `contain`/`cover` fit. `video-player` additionally synchronizes play, pause, seek, loop, duration, and a server-time playback anchor.
- Viewers fetch active media through the authenticated content endpoint. Image and video bytes are converted to local Blob URLs; the renderer owns and revokes those URLs when media changes or stops.
- Video clients compare local playback with the authoritative server anchor. Small drift is corrected with a bounded playback-rate adjustment, while seeks and large drift use a direct seek. Late joiners restore the current position from `serverTimeMs` in the room snapshot.
- Video sound follows the existing per-surface media-audio policy and is muted by default. Adaptive streaming, transcoding, and editing are out of scope; keep `DOCUMENT_UPLOAD_MAX_BYTES` appropriate for bounded Blob playback.
- Native PowerPoint editing, slide animations, and persistence across a room-state service restart are not included.

## Experimental remote browser

- Remote browser controls are shown only when API health reports `remoteBrowserEnabled=true`; enabled controls carry an `Experimental` badge.
- API token issuance, room-state object creation/input, executor HTTP sessions, and frame WebSockets independently enforce the same disabled state.
- Hosts can open only allowlisted origins. Existing permission and controller-lock rules still govern URL changes and input.
- Executor sessions expire after `REMOTE_BROWSER_SESSION_TTL_SECONDS` and are closed on stop, replacement, process shutdown, or owner cleanup. The executor rejects starts beyond `REMOTE_BROWSER_MAX_SESSIONS`.
- Runtime diagnostics expose enabled/experimental state and stable executor errors such as `remote_browser_disabled`, `session_limit_exceeded`, and `session_expired` without including tokens.
