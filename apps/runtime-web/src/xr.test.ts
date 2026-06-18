import test from "node:test";
import assert from "node:assert/strict";

import { detectXrSupport, getEnterVrVisibility } from "./xr.js";

test("detectXrSupport hides enter vr without navigator.xr", () => {
  const support = detectXrSupport({ navigatorXr: undefined, immersiveVrSupported: false });
  assert.equal(getEnterVrVisibility(support, true), false);
});
