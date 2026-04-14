import test from "node:test";
import assert from "node:assert/strict";

import { resolveXrTurnInput } from "./avatar-xr-interaction.js";

test("resolveXrTurnInput suppresses turn while vertical interaction gesture dominates", () => {
  assert.equal(resolveXrTurnInput(0.8, 0.2), 0.8);
  assert.equal(resolveXrTurnInput(0.4, 0.9), 0);
  assert.equal(resolveXrTurnInput(-0.6, -0.2), -0.6);
});
