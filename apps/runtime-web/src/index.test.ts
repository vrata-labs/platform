import test from "node:test";
import assert from "node:assert/strict";

import { describeManifest, resolveJoinMode } from "./index.js";

test("resolveJoinMode detects mobile agents", () => {
  assert.equal(resolveJoinMode("Mozilla/5.0 (iPhone)"), "mobile");
});

test("describeManifest returns room and template", () => {
  assert.equal(
    describeManifest({
      roomId: "demo-room",
      template: "meeting-room-basic",
      assets: [],
      features: { voice: true, spatialAudio: true, screenShare: false }
    }),
    "demo-room:meeting-room-basic"
  );
});
