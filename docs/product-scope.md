# Product Scope

## Product hypothesis

`noah` is a web-native immersive room platform for companies. A customer selects a space template, uploads branded assets, generates a room link, and invites participants who can join from desktop, mobile, or VR.

The first release optimizes for reliable room access, presence, and collaboration instead of visual maximalism or platform breadth.

## Primary users

- `admin` creates and configures tenant rooms.
- `host` starts collaborative sessions and manages media features.
- `member` joins branded rooms for meetings, demos, or showcases.
- `guest` joins by room link with minimal setup.

## MVP levels

### M0 - Foundational immersive room prototype

- Single room template: `meeting-room-basic`.
- Shared room link works on desktop, mobile, and VR.
- Participants join as spherical avatars.
- Movement, presence sync, voice, and basic spatial audio work.
- Runtime uses `Three.js`, media uses `LiveKit`, state uses `Colyseus`.
- Public staging deployment exists.

### M1 - First B2B product wedge

- `2-3` room templates.
- Branded asset slots and theme tokens.
- Room creation without a developer.
- Roles: `guest`, `member`, `host`, `admin`.
- Screen share rendered as media surface in-room.
- Shared managed deployment path for multiple tenants.

## Non-goals

- Custom renderer, custom SFU, or custom multiparty mesh architecture.
- Universal world editor or arbitrary scene scripting.
- VR-only product path.
- Per-customer bespoke scene forks as the default delivery model.
- Full enterprise multi-region platform in the first MVP.

## Success criteria

### M0 success

- One room link works across desktop, mobile, and VR.
- `2-4` participants can join the same room reliably.
- Voice is stable enough for live demos.
- The runtime remains separate from media, state, and control plane concerns.

### M1 success

- A new branded room can be created without code changes.
- Template selection and asset branding are configuration-driven.
- Screen share works in the same room flow.
- Asset preparation and validation are standardized.

## Product principles

- Desktop/mobile-first, VR as progressive enhancement.
- Product path wins over low-level curiosity in core systems.
- Layer separation is mandatory: runtime, media, state, asset pipeline, control plane.
- Simplicity beats platform-building before M1 is complete.
