import test from "node:test";
import assert from "node:assert/strict";

import { createFeatureFlags, resolveQualityProfile } from "./index.js";

test("resolveQualityProfile maps vr to xr", () => {
  assert.equal(resolveQualityProfile("vr"), "xr");
});

test("feature flags allow overrides", () => {
  assert.equal(createFeatureFlags({ screenShare: true }).screenShare, true);
});
