import test from "node:test";
import assert from "node:assert/strict";

import type { PresenceState, TransformState } from "./schema.js";

test("TransformState accepts legacy coordinates and optional orientation", () => {
  const legacy: TransformState = { x: 1, y: 2, z: 3 };
  const oriented: TransformState = { x: 1, y: 2, z: 3, yaw: 0.5, pitch: -0.2, roll: 0.1 };

  assert.equal(legacy.yaw ?? 0, 0);
  assert.equal(oriented.yaw, 0.5);
  assert.equal(oriented.pitch, -0.2);
});

test("PresenceState carries sequence timing metadata", () => {
  const state: PresenceState = {
    participantId: "p1",
    displayName: "Guest",
    role: "guest",
    permissions: ["room.join", "audio.join", "surface.view"],
    mode: "desktop",
    rootTransform: { x: 0, y: 0, z: 0, yaw: 1 },
    headTransform: { x: 0, y: 1.6, z: 0, yaw: 1, pitch: 0.2 },
    muted: true,
    activeMedia: { audio: false, screenShare: false },
    seq: 3,
    clientTimeMs: 100,
    serverTimeMs: 120,
    updatedAt: new Date(0).toISOString()
  };

  assert.equal(state.seq, 3);
  assert.equal(state.clientTimeMs, 100);
  assert.equal(state.serverTimeMs, 120);
});
