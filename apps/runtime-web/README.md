# runtime-web

Entry point for the immersive client runtime.

## Local pose, locomotion, and interaction architecture

The local user transform is owned by the runtime locomotion/local-pose pipeline. The `player` rig, yaw, and pitch are not free mutable globals for feature code.

Target flow:

```text
Raw input adapters
        ↓
InputIntentResolver
        ↓
InteractionResolver
        ↓
LocomotionController
        ↓
LocalPoseController / PlayerRigAdapter
        ↓
Avatar publishing, spatial audio, debug, renderer readers
```

Domain responsibilities:

- `input/`: sample keyboard/mouse/touch/XR input and produce `InputIntents`. XR input must be sampled once per frame so ray visibility, snap-turn, teleport, and seating consume the same sample.
- `interaction/`: compute interaction rays and selected targets. Target resolution is pure: no pose writes, no network sends, no visual side effects.
- `seating/`: track pending and authoritative seat state. Seating code must not import `three` and must not mutate the local player rig.
- `locomotion/`: own `LocomotionMode` and convert intents + selected targets + seating state into pose transitions and runtime commands.
- `local/`: own `LocalPose` and apply it to the Three.js player rig. This is the only place allowed to write `player.position` or `player.rotation`.
- `main.ts`: compose modules, wire commands, and preserve frame order. Avoid adding new domain logic here.

Behavioral invariants:

- Standing movement may change the local root position.
- Seated mode locks root position to the authoritative seat anchor but may still allow yaw/snap-turn if current UX requires it.
- Teleporting from seated must release the current seat through the seating command path.
- Claiming a seat must not locally teleport the user until the authoritative room-state update confirms occupancy.
- Ray intent on the right stick suppresses accidental snap-turn from diagonal stick bleed.
- Avatar publishing, spatial audio, debug, and rendering read the final local pose; they do not own local pose writes.

Required checks for local pose / locomotion changes:

```bash
pnpm --filter @noah/runtime-web build
pnpm --filter @noah/runtime-web test
```

For user-facing runtime behavior, also run repository-level e2e/staging verification according to the root `AGENTS.md` testing policy.
