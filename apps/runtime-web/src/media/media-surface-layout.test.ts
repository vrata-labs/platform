import test from "node:test";
import assert from "node:assert/strict";

import { mediaSurfaceDimensionsChanged, planMediaSurfaceMismatches } from "./media-surface-layout.js";

test("mediaSurfaceDimensionsChanged resets caches only for geometry or pixel changes", () => {
  const current = { widthM: 3.2, heightM: 1.8, widthPx: 1920, heightPx: 1080 };

  assert.equal(mediaSurfaceDimensionsChanged(current, { ...current }), false);
  assert.equal(mediaSurfaceDimensionsChanged(current, { ...current, widthM: 3.3 }), true);
  assert.equal(mediaSurfaceDimensionsChanged(current, { ...current, heightM: 1.9 }), true);
  assert.equal(mediaSurfaceDimensionsChanged(current, { ...current, widthPx: 2048 }), true);
  assert.equal(mediaSurfaceDimensionsChanged(current, { ...current, heightPx: 1000 }), true);
});

test("planMediaSurfaceMismatches preserves physical, logical, and object mismatch evidence", () => {
  assert.deepEqual(planMediaSurfaceMismatches({
    physicalSurfaceIds: ["debug-main", "scene-only"],
    logicalSurfaceIds: ["debug-main", "laptop-screen"],
    objects: [
      { objectId: "rendered", surfaceId: "debug-main" },
      { objectId: "unrendered", surfaceId: "laptop-screen" }
    ]
  }), {
    physicalSurfaceIdsWithoutLogicalState: ["scene-only"],
    logicalSurfaceIdsWithoutPhysicalView: ["laptop-screen"],
    unrenderedObjectIds: ["unrendered"]
  });
});
