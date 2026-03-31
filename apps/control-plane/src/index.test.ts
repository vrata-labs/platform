import test from "node:test";
import assert from "node:assert/strict";

import { createControlPlanePageState, createRoomUrl } from "./index.js";

test("createRoomUrl builds room path", () => {
  assert.equal(createRoomUrl("https://example.com", "abc"), "https://example.com/rooms/abc");
});

test("control-plane page starts idle", () => {
  const state = createControlPlanePageState();
  assert.equal(state.publishStatus, "idle");
  assert.deepEqual(state.sceneBundles, []);
  assert.deepEqual(state.sceneBundleVersions, []);
});
