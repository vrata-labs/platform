import test from "node:test";
import assert from "node:assert/strict";

import { createAvatarOutboundPublisher } from "./avatar-publish.js";
import type { LocalAvatarSnapshotV1 } from "./avatar-types.js";

function createSnapshot(): LocalAvatarSnapshotV1 {
  return {
    schemaVersion: 1,
    avatarId: "preset-01",
    inputMode: "desktop",
    visibilityState: "full-body",
    controllerProfile: "desktop_no_controllers",
    locomotionState: "walk",
    animationState: "idle",
    fallbackReason: null,
    root: { x: 1, y: 0, z: 2, yaw: 0.5 },
    head: { x: 0, y: 1.58, z: 0 },
    leftHand: { x: -0.2, y: 1.1, z: 0.1, visible: true },
    rightHand: { x: 0.2, y: 1.1, z: 0.1, visible: true },
    updatedAt: new Date(0).toISOString()
  };
}

test("createAvatarOutboundPublisher increments pose sequence across builds", () => {
  const publisher = createAvatarOutboundPublisher();
  const first = publisher.build({
    participantId: "p-1",
    snapshot: createSnapshot(),
    muted: false,
    audioActive: true,
    sentAtMs: 100
  });
  const second = publisher.build({
    participantId: "p-1",
    snapshot: createSnapshot(),
    muted: false,
    audioActive: true,
    sentAtMs: 200
  });

  assert.equal(first.poseFrame.seq, 1);
  assert.equal(second.poseFrame.seq, 2);
  assert.equal(second.reliableState.avatarId, "preset-01");
});
