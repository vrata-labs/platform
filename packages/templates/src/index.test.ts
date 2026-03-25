import test from "node:test";
import assert from "node:assert/strict";

import { createSpaceManifest } from "./registry.js";

test("createSpaceManifest resolves template slot config", () => {
  const manifest = createSpaceManifest("meeting-room-basic");
  assert.equal(manifest.templateId, "meeting-room-basic");
  assert.deepEqual(manifest.assetSlots, ["logo", "hero-screen"]);
});
