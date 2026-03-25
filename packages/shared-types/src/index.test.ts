import test from "node:test";
import assert from "node:assert/strict";

import type { ClientMode, UserRole } from "./index.js";

test("shared role and mode types compile in tests", () => {
  const role: UserRole = "guest";
  const mode: ClientMode = "desktop";
  assert.equal(`${role}:${mode}`, "guest:desktop");
});
