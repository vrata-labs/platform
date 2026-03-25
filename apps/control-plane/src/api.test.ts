import test from "node:test";
import assert from "node:assert/strict";

import { fetchTemplates } from "./index.js";

test("fetchTemplates is exported", () => {
  assert.equal(typeof fetchTemplates, "function");
});
