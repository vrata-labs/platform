# Scene-authoring task packet

Read [the shared quality contract](scene-quality-contract.md) and inspect the
accepted visual benchmark before using this packet. It applies to every room
type and resumed task. Unfilled fields are unfinished work, not a pass.

## Start / handoff prompt

> Design a credible real place. Inherit Q1-Q8 from the shared scene-quality
> contract and the latest applicable user feedback. Identify every visible
> object, who could use it, how, how a builder could assemble/install it, and
> what physically supports it. Review those questions against actual geometry
> and real use views. Passive/deferred props are allowed and still need plausible
> affordances. Preserve realistic materials and photographic-quality distant
> surroundings in the browser. Inspect the accepted benchmark and paired source/
> runtime images yourself, correct defects, and retain evidence. Technical validity,
> repeatability and same-candidate image metrics do not establish visual quality.
> Do not call the scene ready while a known shared requirement fails.
> For each meaningful object group, explain who left it in that arrangement,
> after what activity, and why. Compare real-use photographs; check grouping,
> mutual support and retrieval rather than adding random disorder.

## 1. Identity and inherited target

- Scene ID, purpose, intended users and proposed version:
- Source/release repository and base commit:
- Common quality contract URL, exact commit/revision:
- Latest applicable feedback and accepted benchmark commit/views:
- Scene-specific setting/palette and explicit style exceptions:
- What must be preserved from the previous accepted version:

## 2. Requirement-to-evidence matrix

Fill every row. Add scene-local requirements without removing shared rows.

| ID | Applies / justified N/A | Implementation / objects | Actual check and evidence | Result / remaining defect |
| --- | --- | --- | --- | --- |
| Q1 Browser quality and multi-view convergence | | | | |
| Q2 Object identities, purposes and real use | | | | |
| Q3 Constructibility, support and physical plausibility | | | | |
| Q4 Passive/deferred affordances; claimed interactions | | | | |
| Q5 All-seat visibility, routes and assembly contacts | | | | |
| Q6 Photographic-quality exterior where visible | | | | |
| Q7 Inherited quality floor and feedback propagation | | | | |
| Q8 Context, grouping and plausible arrangement after real use | | | | |

## 3. Object and scenario coverage

Record each object/family's type, purpose, users, expected actions, dimensions,
material/finish, parts, assembly/attachment/support, interaction status and scenario
IDs. Enumerate repeated placements. Account for every recognizable item and
exported visible part; explain mapping exceptions.

For every meaningful arrangement record its state/use history, group members,
real-photo references and observed relationships, density/spacing rationale,
orientation, mutual support and retrieval clearance. Explain regularity/variation
from use or construction. Include a group-level source/browser view and measurable
contacts where relevant; per-object support alone does not cover arrangement.

For each User/Builder/Physics scenario record:

- actor, object/part IDs, use/assembly sequence and viewpoint/envelope;
- expected relationship/numeric criterion with its physical rationale;
- measured final geometry/runtime result, method and exact artifact identity;
- view/crop and any visible defect the geometric check cannot resolve;
- verdict, correction and recheck evidence.

## 4. Material, exterior and view plan

- Material families, real finishes, scale/orientation, PBR/export method:
- Lighting/contact-shadow/reflection transfer and runtime/device budget:
- Window construction, panorama source/license/bytes, location/horizon/yaw:
- Source/browser camera pairs, seated views, material/joint close-ups, walkthrough:
- Normal product-mode view with actual surfaces/interactions:
- Source-to-runtime discrepancies and corrections:

## 5. Correction log and completion record

For each iteration: view/object, observed defect, change, before/after images,
role checks rerun, remaining issues. Metric totals do not replace this log.

- Quality verdict against inherited target:
- Source-to-runtime fidelity verdict:
- Regression/reproducibility result (distinct from quality):
- Workflow outcome: DRAFT / REWORK_REQUIRED / READY_FOR_USER_REVIEW:
- Human visual verdict and scope, if actually received:
- Exact source/release/capture identities and technical gate results:
- Published exact-SHA room and post-deploy views, when authorized:
- Shared feedback updates and affected other scenes:

On resumption, read this packet and unresolved defects before more technical
audits or publication. Successful CI does not erase REWORK_REQUIRED.
