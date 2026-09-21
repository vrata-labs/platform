# Scene quality contract

Status: required authoring workflow for **every Vrata scene**.
Revision: 2026-09-21.

This applies to meeting, personal, presentation and future room types, to new
scenes and changes to existing scenes, regardless of authoring tool or repository.
Read it before planning geometry, materials, lighting or exteriors. Use the
[task packet](scene-authoring-task-template.md) when starting or resuming work.
It complements [technical requirements](scene-technical-requirements.md) and the
[authoring ADR](arch/2026-08-29-agentic-deterministic-scene-authoring.md).

## Quality target and inherited decisions

The default target is a convincing, physically plausible real place with realistic
materials and photographic-quality distant surroundings. A cartoon, low-poly toy,
flat-color blockout or illustrated panorama is not a finished review candidate.
Deliberate stylization needs an explicit user brief; performance constraints or
procedural authoring do not grant that exception.

| ID | Shared requirement | Origin |
| --- | --- | --- |
| Q1 | Achieve the approved source-render quality in the actual browser; iterate over enough views to expose defects. | 2026-08-30 |
| Q2 | Give every recognizable object an identity, real purpose and plausible use. | 2026-09-01 |
| Q3 | Review every assembly as a builder and every placement for physical plausibility. | 2026-09-01 |
| Q4 | Passive/deferred objects still need credible affordances; runtime interaction is not required for every prop. | 2026-09-01 clarification |
| Q5 | Check sightlines from all relevant seats, usable routes, plant placement and actual window/frame contacts. | 2026-09-02 |
| Q6 | Use a photographic-quality panorama for distant views; a procedurally drawn skyline is not equivalent. | 2026-09-04 |
| Q7 | Apply the corrected process to other room types and preserve its successful quality level. | 2026-09-04 and 2026-09-19 |
| Q8 | Make arrangements credible as the result of real use: inspect relationships, grouping, occupancy and mutual support against photographs of comparable real places. | 2026-09-20: isolated, evenly spaced books in Personal Workspace |

The accepted visual benchmark is Warm Modern Meeting Room Candidate 01 **0.3.3**,
release commit `5580a7b080cf6195e28ebc77b654fd71111b0cd1`, praised by the user on
2026-09-04. Its [source/review evidence](https://github.com/vrata-labs/warm-modern-meeting-room-candidate-01/tree/5580a7b080cf6195e28ebc77b654fd71111b0cd1/source/releases/0.3.3)
and browser appearance establish a quality floor, not a layout to copy. Its
photographic Poly Haven Cannon panorama replaced an unsuccessful procedural park.
A different room can have its own coherent location and palette; it inherits the
realism standard, not a mandatory coastline or particular HDRI.

For every task record the shared-contract revision, exact benchmark revision,
applicable Q IDs, scene-specific requirements and explicit exceptions. Inspect
benchmark images, not just filenames or approval text. An older version of the
scene under repair is a regression reference, not automatically a quality target.
Never replace the target with a weaker new render because it is easier to reproduce.

## 1. Design a usable place

Define users, activities, standing/seated eye heights, approach and stand-up
positions, and what users need to see or reach. An approach point, a seat anchor
and a viewing point are different things.

Create an object registry covering every recognizable item and architectural
assembly, including passive clutter, fixtures, trim, plants and visible exterior
geometry. Every object needs:

- stable object/part IDs bound to actual exported geometry;
- a specific type/name and real-world purpose;
- intended users and expected real-world actions/affordances;
- dimensions and their physical source or rationale;
- material/finish, thickness and orientation;
- assembly/attachment method, support objects and contact locations;
- access, reach, sightline and motion/clearance envelopes where relevant;
- `passive`, `deferred` or `interactive`, with exact implemented interactions;
- scenario/check IDs and evidence views for use, construction and appearance.

A label does not make an unrecognizable shape meaningful. Splitting 232 meshes
into 19 groups is not a substitute for explaining each visible item. Identical
parts may share a family specification; every placement still needs support and
obstruction checks. Do not hide unexplained objects in an `accessories`/`decor` group.

A cup, book, handle, plant or piece of litter may remain noninteractive. Keep its
real-world affordance plausible. Do not empty the room or hide details because
interaction is absent. A deferred handle must fit a hand, attach to its door and
have working clearance even when opening is not implemented.

## 2. Three required role passes

These are reasoning/inspection passes by the authoring agent, not a requirement
for three people or spawned agents. Run them before expensive baking; repeat
affected checks against the final GLB after every art/layout change.

| Role | Questions and actual checks |
| --- | --- |
| User | Who uses this, from where, and how? Can they approach, sit, rise, reach, place or read as implied? Check every seat's eye position, full display visibility, head/knee/hand clearance, door access and routes with final props present. Test every claimed runtime interaction. For deferred actions inspect the counterfactual physical action/envelope. |
| Builder | How is this manufactured, assembled, installed and serviced? Identify the real assembly, material thickness, joints, fasteners/supports and installation sequence. Window profiles, glazing beads, sill and reveals must meet; trim cannot be disconnected floating boards. Fixtures need credible mounts and power/cable routing where visible or functionally relevant. |
| Physics | What supports the mass and is the placement stable? Evaluate final geometry for rooted support paths, actual contacts, gravity, scale, penetrations, unsupported parts and usable motion envelopes. Hidden brackets are allowed when a documented construction genuinely explains the result. |

Expected values are not measurements. Record method, actual contact/dimension or
ray/clearance results, artifact identity and object IDs. Anchor equality proves
coordinate preservation, not usability. An AABB gap alone does not prove screen
visibility; a declared support edge does not prove mesh contact. Justify numeric
criteria for the real object/user instead of using an arbitrary universal tolerance.
Do not relax a failed clearance/reach threshold separately for the failing object.
Correct the layout, or independently justify a revised actor/posture model and
rerun every affected check. Assembly-level contact discovery and joined-mesh
connectivity do not replace intended per-part support or constituent-part coverage.

Use geometric tests for measurable relationships and eye-level/contact views for
what those tests miss. Hidden fasteners need not all be modeled; visible joints,
thickness and load paths must read as constructible.

### Context and arrangement pass (Q8)

An individually recognizable, supported object can still be implausibly placed.
Review each meaningful group as a whole: **who left these objects in this state,
after what activity, and why are they arranged like this?** State whether the place
is ready for use, currently in use, stored, displayed or being serviced. A tidy room
is valid; arbitrary clutter, random rotations and artificial wear are not realism.

Before detailing a repeated prop group, inspect photographs of comparable real
use, not just asset previews, AI imagery or staged catalog compositions. Record the
reference URLs, observed relationships and the intended differences. References
guide reasoning; they are not permission to redistribute their images or textures.

Check and record:

- Grouping/density and orientation follow storage, reach, retrieval or a shared
  activity; repeated spacing has an actual reason, not merely a loop increment.
- Gravity and mutual support work at group level. Books normally form supported
  runs, with contacting neighbours and a case side or bookend; oversized volumes
  may lie in a supported stack. A sparse display is possible when its supports and
  intended display use explain it. Do not mandate one universal shelf fill ratio.
- Variation follows real causes (book formats/series, manufacturing, use), while
  things meant to match still match. Do not independently randomize every object.
- Retrieval and use remain plausible: tight storage is not interpenetration or
  compression, end supports are credible, handles/cables and working spaces remain
  usable. Removal of one object must not reveal an unexplained floating arrangement.
- Inspect the final group at ordinary viewing distance and close-up in source and
  browser. Measure relevant gaps/contacts/clearances, but also explain whether the
  overall pattern resembles the references. Floor contact alone cannot pass Q8.

Apply this beyond books: seating directed at a shared activity, papers on a work
surface, nested/stacked dishes, equipment and cable routing. Record a justified N/A
only for a specific group, not for the whole room because it contains no books.
Unexplained regimented spacing or arbitrary scatter is REWORK_REQUIRED even when
the object registry, support graph and technical tests pass.

## 3. Materials and lighting in the browser

Inspect major materials at normal use distance and close-up in source and runtime.
Wood needs appropriate grain scale/direction and edges; fabric needs plausible
weave/roughness and upholstery; metal needs a credible finish/reflections. Plaster,
paint, glass and plastic must not all look like the same uniformly colored material.

Use geometry for silhouettes/construction and suitable PBR maps or validated
procedural detail for surface response. Scalar PBR is fine for genuinely uniform
surfaces; assigning color and roughness to everything is not a material-quality
pass. Texture count/resolution, non-black pixels and lightmap presence are facts,
not visual verdicts.

Preserve contact shadows, indirect light, shape readability and material differences
through export. Use a measured baked/hybrid approach compatible with the shipping
runtime, retaining intended view-dependent response. Avoid fake furniture glow,
crushed shadows, forced-color overrides or flattened shading to pass a screenshot
metric. Recheck quality after optimization; report a real budget conflict instead
of silently lowering the target.

Baked-lighting transfer must retain its measured dynamic range. Record linear
maximum/percentiles, encoding scale and clipping fraction; reject broad clipping
of walls/floors instead of raising a clipped map's intensity. Separate source
diffuse radiance from runtime irradiance and test the actual decoded result.
When an atlas includes environment diffuse, avoid adding environment diffuse a
second time; keep view-dependent environment specular. Confirm that in actual
browser images rather than using a lightmapped-material count as proof.

## 4. Windows and distant surroundings

For each visible exterior define coherent location, eye elevation, horizon,
distance, weather and light direction. A sphere is delivery geometry. JPEG size,
a panorama tag or a deterministic generator does not establish photorealism.

- Prefer a licensed photographic panorama/HDRI or another source whose photographic
  quality is demonstrated. Record source, author, license and exact bytes.
  Project-authored geometry remains the default; cleared photographic surroundings
  and PBR inputs are legitimate tools.
- An unavailable/licensing-blocked photographic source must not silently become
  painted rectangles, stylized vegetation or noise-generated hills. State the
  specific asset/tool blocker and continue independent work.
- Inspect entry, every window-facing seat, close window views and movement along
  the window. Check seams, pole distortion, magnification, pixelation, horizon and
  implausible near-field parallax.
- Deliver the panorama in the runtime, not only Blender World. Document its
  unlit/color-space/exposure treatment and exclusions from bake, collisions and
  navigation bounds. Budget decoded GPU memory as well as compressed bytes.
- Keep window profiles/sill/joints plausible. A glass-rendering simplification
  must not introduce construction gaps or opaque triangles hiding the view.
  An earlier removal of glass is not permission to skip window review.

The sphere is a documented optical representation, not a literal load-bearing
landscape. Modeled nearby exterior objects still need object cards and role passes.
A room without visible exterior records why this section is not applicable.

## 5. Visual criticism and convergence

Inspect actual images before freezing a candidate. Derive view coverage from
scenarios rather than a ceremonial fixed count of seven screenshots:

- entry and ordinary eye-level walkthrough;
- every distinct seated/use view and required screen/board sightline;
- representative material, joint and hardware close-ups;
- window/exterior views and movement where applicable;
- clean art pairs and normal product-mode views with actual media surfaces and
  implemented interactions visible.

Source/browser pairs use the same cameras, FOV, exposure and artifact revision,
with explicit aspect/coordinate conversion. Clean capture may remove HUD/debug
overlays; it must not hide broken geometry, missing functional surfaces or
production-only defects. Beauty cameras cannot replace real seated views.

Record the measured runtime camera world position/direction for every paired
view. A command applied to the player rig is not the camera position: camera
offsets rotate with parent yaw/pitch. Convert the desired DCC eye pose through
that hierarchy and assert the actual camera result. Separately record viewpoints
and behavior reached through real seat interactions; a synthetic anatomical
seated view does not establish the runtime's seated eye pose.
Normal-product checks must compare actual seated camera height with the cushion
and intended eye position, observe authoritative claim/release from another client,
and verify the post-release floor pose after frame processing. For each media
surface, verify both physical and logical state and actual displayed content:
a visible empty plane or an object with no media frames is insufficient.

Exercise seat release across room-state reconnect as well: a locally standing
rig does not prove that other users can claim the chair. Unacknowledged releases
must reach the server after reconnect, including when another socket retains the
participant session. Capture reports must record explicit completion and the
runner outcome; an empty error list inside a failing test's cleanup is not a pass.

For each failed view record object/region, visible symptom, suspected cause,
correction and before/after evidence. Fix obvious toy forms, unreadable objects,
implausible construction, flat materials and painted exteriors before asking for
final human review. Iterate autonomously; the user should not rediscover already
stated defects for each room.

Keep three separate verdicts:

1. **Quality against inherited benchmark/brief**, with actual images and role passes.
2. **Source-to-runtime fidelity**, with paired views and measured/corrected losses.
3. **Regression/repeatability**, with PHASH/NCC, repeated captures, hashes and CI.

Thresholds calibrated from a candidate's own captures establish only a regression
baseline. They cannot close verdict 1 or justify a weaker target. Do not relax
thresholds until an inferior candidate passes. No generic schema or code review
can certify photorealism.

## 6. Stop rules and delivery

Workflow outcomes are separate from legacy `scene.json.status` enums:

- **DRAFT**: incomplete object/scenario/material work; list defects.
- **REWORK_REQUIRED**: unexplained object, failed role check, obvious visual
  regression, illustrated exterior under a realistic brief, missing evidence or
  unresolved rejection. Technical success cannot override this outcome.
- **READY_FOR_USER_REVIEW**: Q1-Q8 applicability resolved, role/visual passes have
  concrete evidence, runtime checks pass, and no known quality blocker is being
  delegated back to the user. Human acceptance is still pending.
- **VISUALLY_ACCEPTED**: explicit human verdict for the identified version/views.
  Rights, publication permission and promotion remain separate decisions.

Run inexpensive structural/visual feedback early. Once quality is clear, freeze
source, run deterministic/bundle/performance checks and use normal immutable
CI/staging publication. Repeat relevant visual and functional checks on the exact
deployed commit before calling review delivery complete. An explicitly requested
WIP preview may be published earlier with its DRAFT/REWORK_REQUIRED status and
defects visible; it is not a finished handoff.

Keep source acceptance, current-release selection, technical validity, publication
permission and human visual acceptance distinct. Record later rejection in separate
review evidence/root documentation. Never rewrite an immutable release to hide its
limitations; scene corrections require a new version.

## 7. Feedback propagates across scenes

Classify each new criticism as shared or scene-local. Update this contract/task
packet for shared rules in the same work item, before the next scene. Add its
check/evidence obligation to every in-scope scene. Record exceptions explicitly.

All entry points must lead here: platform AGENTS, scene-pipeline skill, factory
instructions and every candidate's AGENTS. Tasks record the exact policy revision
and check for newer applicable user feedback. One accepted scene is a benchmark,
not automatic acceptance of another scene made by similar scripts.

See the [session flow audit](reviews/2026-09-19-scene-flow-quality-regression.md).
The [0.4.0 normal-product investigation](reviews/2026-09-20-scene-040-normal-product-blockers.md)
records concrete failures caught by these checks; none is waived by clean captures.
