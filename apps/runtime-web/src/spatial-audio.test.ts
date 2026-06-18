import test from "node:test";
import assert from "node:assert/strict";

import { createSpatialAudioSettings } from "./spatial-audio.js";

test("createSpatialAudioSettings returns stable defaults", () => {
  const settings = createSpatialAudioSettings();
  assert.equal(settings.panningModel, "HRTF");
  assert.equal(settings.distanceModel, "inverse");
  assert.equal(settings.refDistance, 1);
  assert.equal(settings.maxDistance, 25);
});
