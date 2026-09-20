# 0.4.0 scene candidates: normal-product blockers

Status: REWORK_REQUIRED. This is local diagnostic evidence, not release acceptance.
Platform commit: d9eaa25f52bc5ef1bdd8622d83b22a09dc81f84a (PR #98).
Shared contract: docs/scene-quality-contract.md, sections 2, 5 and 6.

## Exact inputs and scope

| Candidate | Diagnostic GLB SHA-256 | Bytes | Mesh nodes |
| --- | --- | --- | --- |
| Personal 0.4.0 | ec8e32a52a604367d92714bc5946d784ab3f357e1f35c7ea0ae85cc1a01b2cf6 | 20924412 | 385 |
| Presentation 0.4.0 | c64db35810448308cef11332c7485f32870048205fe617544cb06e9096cdf8a5 | 17933280 | 207 |

The candidate-owned task packets carry the scene-local correction logs. Historical
0.1.x–0.3.0 releases are unchanged. No release materialization, rights approval,
human visual acceptance, current-release switch, or staging publication occurred.

## Local results

- Khronos: zero errors and warnings for both current GLBs.
- Saved-source/atlas re-export: byte-identical for each candidate (cmp).
- All 10 Personal and 16 Presentation source images rendered.
- Clean browser camera-pair tests: passed for both candidates, all 26 views.
  Browser-delivered GLB SHA and actual camera position/direction were checked.
  These captures hide physical media surfaces and strip anchors; they establish
  camera binding and technical loading only, not normal product functionality.
- Normal tests retain the manifest anchors/surfaces and enable seats. A second
  participant observes server occupancy. They use requestSeatClaimById, never
  force-only claimSeatById, and do not use setSceneReviewPose.
- Normal test verdict: both failed. All 1+8 server claim/release transitions and
  seated movement locks completed; the failures below remain blocking.

## Reproduced failures

1. **Desktop seated eye height:** Personal eye y=2.079m at a 0.479m cushion;
   Presentation eye y=2.083m at a 0.4825m cushion. The runtime adds the standing
   1.6m head offset on top of the seat root, instead of matching the 1.20m designed
   seated eye. Evidence includes actual camera world coordinates and screenshots.
   Relevant ownership: local pose/rig and avatar pose publication. Preserve the
   already-accepted real-headset locomotion path when correcting desktop posture.
2. **Personal workspace-main logical surface:** the physical plane is visible at
   the manifest transform but absent in room-state. Diagnostics list it under
   physicalSurfaceIdsWithoutLogicalState; inputEnabled=false, allowedObjectTypes=[],
   and creating a markdown-board returns missing-surface. The default shared media
   state defines debug-main, whiteboard and laptop surfaces, not workspace-main.
3. **Presentation teleport-out test:** after every seat release, authoritative
   occupancy clears but the sampled rig root stays at the seated location instead
   of the requested floor point. The final test polls actual x/y/z after release.
   Determine whether command/frame ordering or the immediate test helper is at
   fault; occupancy alone is not evidence of successful teleport placement.

Presentation debug-main accepts a screen-share object. This proves object creation,
not streaming/playback: this test supplies no shared video frames.

## Checks that are still incomplete

- Candidate support checkers discover contacts within allowed assemblies; they
  do not yet validate intended per-part construction/load paths. Joined chair
  assemblies also need constituent-part coverage.
- Personal notebook reach fails the restored uniform 0.85m screening ceiling
  (0.9944m). Per-target limit relaxation was erroneous; its prior green result is
  withdrawn. Source layout/posture and frequent-use reach need correction.
- Route screening does not replace approach/stand-up envelopes; Presentation's
  checker currently excludes the destination chair.
- Material close-ups and the 4K panorama still need the full visual quality pass.
- Full repository checks and local e2e have not been claimed for these unfinished
  candidate changes. Earlier PR #98 CI results cover that runtime commit only.

## Reproduction

The temporary local harness is tests/e2e/scene-quality-0.4-local.spec.ts. Supply
SCENE_QUALITY_DIR with the candidate build directory, SCENE_QUALITY_ASSET with
scene-0.4.0.glb, SCENE_QUALITY_NORMAL=1 and a separate SCENE_QUALITY_OUTPUT.
Run pnpm test:e2e:private-assets -- tests/e2e/scene-quality-0.4-local.spec.ts --workers=1 --retries=0.
Use isolated local API/room-state ports. The resulting normal-product-evidence.json
records the platform commit, input manifest/GLB hashes, actual seat/release poses,
logical-surface diagnostics and the failing verdict.

These failures must propagate to both scene task packets before source freeze.
PR #98 still requires external approval. Its successful CI run is 35497118122;
it is not a staging validation of these candidates.

## Resolution work (same-day follow-up)

The user authorized admin merges. PR #98 was merged as
dcd6bdd49280a57a819bc30ff0aac171644097ec. The follow-up working tree fixes desktop
seat-root mapping while preserving the tracked-XR mapping, suppresses stale
pre-release occupancy until server acknowledgement, and registers missing logical
surfaces from the API-signed stored scene manifest contract.

Both exact-asset normal-product local runs now pass, including all nine seats,
camera height, authoritative occupancy, floor placement and media object creation.
The public normal-product regression additionally exercises rendered shared sticky
notes on workspace-main and an unrelated custom surface ID, and checks the outbound
avatar head height. Its staging variant uses only a project-authored inline fixture.
These fixes do not resolve the remaining scene-local reach, construction, visual or
rights gates, and are not themselves evidence of scene publication approval.
