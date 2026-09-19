# Scene-flow quality regression: session audit

Date: 2026-09-19. Scope: transfer of quality requirements across Vrata scenes.
Evidence: this authoring session's 156 user text messages, relevant assistant
decisions, tracked workflow documents and published candidate records. Private
transcript dumps and credentials are not part of this document.

## Recovered user requirements

| Date | Requirement / decision | Scope |
| --- | --- | --- |
| 2026-08-28 | Fix the successful approach in the project so many different scenes can repeat it. | Shared process |
| 2026-08-30 | Browser quality must reach source-render quality; use enough views, investigate lighting/material transfer, iterate without making the user perform every comparison. | Shared quality loop |
| 2026-09-01 | Every object has meaning; review as User, Builder and Physics, including sightlines, assembly and support. | All objects/scenes |
| 2026-09-01 | Interaction is optional: a deferred handle must still be attached, graspable and mechanically plausible. Clutter is allowed. | Shared-rule clarification |
| 2026-09-02 | Plant placement must not block a route/board; board visibility, window/frame contacts and unexplained exterior blocks need correction. | Local fixes expose shared regression cases |
| 2026-09-04 | Replace failed procedural exterior with a photorealistic panorama; apply the improved flow, including spheres where windows exist, to Personal and Presentation. | Local setting; shared realism/transfer |
| 2026-09-19 | Personal 0.3.0 looks cartoon-like and fails functional/construction/material/exterior expectations. Correct the flow for all scenes. | Rejection and process correction |

Warm Modern Meeting Room 0.3.3 at
`5580a7b080cf6195e28ebc77b654fd71111b0cd1` was praised on 2026-09-04. Its
photographic Poly Haven Cannon exterior replaced the earlier procedural park.
The request was not merely to add any sphere to the other rooms.

## Five whys

| Why | Evidence | Conclusion |
| --- | --- | --- |
| Why did Personal return to a cartoon-like result? | Its 0.3.0 retained the earlier interior/baked inputs and added a deterministic drawn city/park panorama. Published source/runtime sheets show simplified forms and flat response. | The art method did not implement the inherited target. |
| Why did the workflow pass it? | Personal reality evidence reports 232 tagged nodes, 19 groups, seven scenarios and preserved bindings, without equivalent per-object use/construction/contact evidence. | Metadata coverage replaced the required role review. |
| Why did visual validation not reject it? | Thresholds were calibrated from the candidate's own three repeatable captures. The report says technical regression, but operationally became readiness evidence. | An independent quality-floor comparison was absent. |
| Why were first-scene lessons lost? | The platform ADR still described the 0.1.1 specimen; factory policy was scoped to warm-modern candidates; the local skill emphasized hashes, captures and promotion. | Common requirements were only partly transferred from scene-local work. |
| Why could this repeat? | Start/handoff instructions lacked an inherited requirement-to-evidence matrix and a quality-blocking outcome. The local skill was gitignored. Integrity reviews did not assess the images against the target. | Missing durable inheritance allowed technical bookkeeping to dominate the task. |

This is an execution/process failure, not a missing user specification. Lighting/
export loss can explain part of source/browser differences, but not an illustrated
source panorama or omitted role checks. Loaded bundles and clean integrity reviews
cannot establish that the art meets the brief.

## Actions

- **Corrective:** the shared [quality contract](../scene-quality-contract.md) and
  [task packet](../scene-authoring-task-template.md) require actual object/use,
  construction, physics, material and exterior evidence before finished handoff.
- **Preventive:** connect platform/factory/candidate instructions and the local
  skill to that contract. Transfer general feedback before the next scene.
- **Detective:** Q1-Q7 coverage, scenario-derived views and an image-based defect
  log. Missing evidence, failed role checks and obvious regressions require rework.
- **Automation boundary:** Candidate CI executes measurable role/geometry and
  regression checks. Qualitative appearance requires image inspection; a new
  declaration-only validator is not claimed to prove photorealism. Existing green
  results prove only the checks they actually executed.

Future regression cases: tagged but floating parts; named but unrecognizable props;
passive handles with impossible grip; screens hidden from seats; plants obstructing
routes; disconnected window trim; uniform plastic-looking finishes; repeatable but
illustrated panoramas; clean captures hiding broken production media surfaces.

## Current dispositions

| Candidate | Exact release commit | Disposition |
| --- | --- | --- |
| Personal Workspace 0.3.0 | `705ed359269b5f9cd19168e63f0d7c3fc15a73b0` | User-rejected on 2026-09-19; REWORK_REQUIRED. Technical passes do not make it a quality reference. |
| Presentation Room 0.3.0 | `3e46cb2a0cd3745cd679dd951695910458d99ddc` | Not visually accepted; requires the same full audit. The Personal example does not establish that every Presentation defect was inspected. |
| Warm Modern Meeting Room 0.3.3 | `5580a7b080cf6195e28ebc77b654fd71111b0cd1` | Accepted visual benchmark; transfer quality, not its layout. |

This correction updates the workflow and entry instructions. It does not claim
either new scene was remodeled. Release bytes remain immutable; scene fixes
require a new candidate version and fresh role/visual evidence.
