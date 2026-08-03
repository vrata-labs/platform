# Client compatibility

> Generated from `apps/runtime-web/src/compatibility-matrix.json`. Run `pnpm validate:compatibility -- --write-docs` to update this file.

This matrix describes browser and device compatibility for Vrata when the relevant feature is enabled on a correctly configured HTTPS self-host. It is not an SLA.

Review owner: **Vrata release maintainer**.

## Statuses

| Status | Meaning |
|---|---|
| supported | The measurable capability scenario passed on the exact profile and revision without a known blocking defect. |
| degraded | The primary scenario passed, but a verified limitation affects expected behavior and is documented below. |
| unsupported | The scenario reproducibly failed on the exact profile or is excluded by a documented platform decision. |
| untested | No qualifying evidence exists for the exact profile. |

## Capability criteria

| Capability | Passing result |
|---|---|
| Join | The client completes access and room join, then appears in presence without a crash. |
| Movement | Local input changes pose and another client receives the current position without a stale participant. |
| Voice | The client publishes and receives LiveKit audio, and mute state remains synchronized. |
| Spatial audio | Remote audio follows participant pose or uses an explicitly documented degraded fallback. |
| Screen share | The client publishes a display track, another participant sees the in-room surface, and stop clears the state. |
| Presentation | An authorized presenter opens content and changes presentation state that an observer can see. |
| WebXR | The client enters immersive VR, publishes XR pose, and exits without disconnecting room or audio. |

## Matrix

| Client | Environment | Join | Movement | Voice | Spatial audio | Screen share | Presentation | WebXR | Last reviewed | Last tested |
|---|---|---|---|---|---|---|---|---|---|---|
| Desktop Chromium on Linux CI | GitHub-hosted runner ubuntu-24.04 image 20260720.247; Ubuntu 24.04; Chromium 145.0.7632.6 via Playwright 1.58.2 | supported [evidence](#evidence-ci-30763163576) | supported [evidence](#evidence-ci-30763163576) | supported [evidence](#evidence-staging-30763610266) | supported [evidence](#evidence-staging-30763610266) | untested | untested | untested | 2026-08-03 | 2026-08-02 |
| Android Chrome | Android phone; Android; Chrome | untested | untested | untested | untested | untested | untested | untested | 2026-08-03 | Not tested |
| iOS Safari | iPhone or iPad; iOS or iPadOS; Safari | untested | untested | untested | untested | untested | untested | untested | 2026-08-03 | Not tested |
| Meta Quest Browser | Meta Quest headset; Meta Horizon OS; Meta Quest Browser | untested | untested [issue](#issue-quest-motion-smoothness-history) | untested | untested | untested | untested | untested | 2026-08-03 | Not tested |

## Assumptions

- Statuses describe the named client profile with the relevant Vrata feature enabled on a correctly configured HTTPS self-host.
- Chromium mobile emulation and synthetic WebXR validate fallback behavior only; they do not qualify a physical mobile or headset profile as supported.
- A capability remains untested until qualifying evidence exists for the exact profile.

## Profile notes

### Desktop Chromium on Linux CI

Results apply to the recorded Linux CI/staging profile and do not automatically cover Windows or macOS.

Tested revision: 973bc161b75d178a6a3b1252e6a5d00b4733ff2c.

### Android Chrome

Chromium touch emulation is covered by CI, but no current physical Android run is recorded.

Tested revision: Not tested.

### iOS Safari

Safari user-agent emulation in Chromium is not evidence for a physical Apple device.

Tested revision: Not tested.

### Meta Quest Browser

Historical headset checks exist, but their exact current device and browser versions were not recorded, so they do not qualify this profile.

Tested revision: Not tested.

## Evidence

<a id="evidence-ci-30763163576"></a>
### CI Chromium room and cross-device scenarios

- Type: automated
- Outcome: passed
- Date: 2026-08-02
- Revision: 973bc161b75d178a6a3b1252e6a5d00b4733ff2c
- Run: https://github.com/vrata-labs/platform/actions/runs/30763163576
- Sources: tests/e2e/runtime.spec.ts, tests/e2e/m0.5/cross-device-join-flow.spec.ts, tests/e2e/m0.5/reliable-room-scenario.spec.ts

The runtime and cross-device Playwright shards passed with the bundled Chromium browser. Mobile emulation in the same run is not used as physical-device evidence.

<a id="evidence-staging-30763610266"></a>
### Staging voice and spatial-audio gate

- Type: automated
- Outcome: passed
- Date: 2026-08-02
- Revision: 973bc161b75d178a6a3b1252e6a5d00b4733ff2c
- Run: https://github.com/vrata-labs/platform/actions/runs/30763610266
- Sources: tests/e2e/runtime-staging.spec.ts

The public HTTPS staging gate validated LiveKit media and spatial source attachment on the deployed revision.

## Known issues

<a id="issue-quest-motion-smoothness-history"></a>
### quest-motion-smoothness-history

Historical Quest checks reported improved but not perfectly smooth remote motion; the current headset/browser profile has not been revalidated.

Workaround: No known workaround. Keep the capability untested until a fresh headset run records exact versions and current behavior.

Sources: docs/status.md.

## Updating the matrix

- Record exact device, OS, browser, date, and revision for qualifying tests.
- Do not treat Chromium mobile emulation or synthetic WebXR as physical-device evidence.
- Update `lastReviewed` when the release owner records `updated` or `reviewed unchanged`.
- Regenerate this file and run `pnpm validate:compatibility` before opening a pull request.
