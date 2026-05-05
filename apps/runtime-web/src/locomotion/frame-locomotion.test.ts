import test from "node:test";
import assert from "node:assert/strict";

import type { InputIntents } from "../input/input-intents.js";
import type { LocalPose } from "../local/local-pose.js";
import { planFrameLocomotionMovement } from "./frame-locomotion.js";

const idleIntents: InputIntents = {
  move: { x: 0, z: 0 },
  snapTurn: { axis: 0 },
  aimRay: false,
  confirmInteraction: false,
  source: "desktop"
};

const pose: LocalPose = {
  position: { x: 0, y: 0, z: 0 },
  yaw: 0,
  pitch: 0
};

test("frame locomotion plans standing desktop movement from frame intents", () => {
  const plan = planFrameLocomotionMovement({
    pose,
    frameContext: {
      source: "desktop",
      intents: { ...idleIntents, move: { x: 0, z: -1 } }
    },
    deltaSeconds: 1,
    floorY: 0,
    currentSeatId: null,
    lastAppliedSeatLockId: null,
    cameraForward: { x: 1, z: 0 },
    desktopFastMove: false
  });

  assert.equal(plan.kind, "standing");
  if (plan.kind !== "standing") {
    throw new Error("expected standing plan");
  }
  assert.deepEqual(plan.commands, []);
  assert.deepEqual(plan.avatarMove, { x: 0, z: -1 });
  assert.equal(plan.movementReason, "desktop_move");
  assert.equal(plan.pose.position.x, 3.2);
  assert.equal(plan.pose.position.z, 0);
});

test("frame locomotion keeps seated user locked to the seat anchor", () => {
  const plan = planFrameLocomotionMovement({
    pose,
    frameContext: {
      source: "xr",
      intents: { ...idleIntents, source: "xr", move: { x: 1, z: -1 } }
    },
    deltaSeconds: 1,
    floorY: 0,
    currentSeatId: "seat-a",
    seatRootPosition: { x: 5, y: 0.45, z: -2 },
    seatYaw: Math.PI / 2,
    lastAppliedSeatLockId: null,
    cameraForward: { x: 0, z: -1 },
    desktopFastMove: false
  });

  assert.equal(plan.kind, "seat_lock");
  if (plan.kind !== "seat_lock") {
    throw new Error("expected seat lock plan");
  }
  assert.equal(plan.seatId, "seat-a");
  assert.equal(plan.reason, "seat_enter");
  assert.equal(plan.yaw, Math.PI / 2);
  assert.deepEqual(plan.position, { x: 5, y: 0.45, z: -2 });
  assert.deepEqual(plan.avatarMove, { x: 0, z: 0 });
  assert.equal(plan.avatarTurnRate, 0);
});

test("frame locomotion keeps repeated seat lock yaw unchanged", () => {
  const plan = planFrameLocomotionMovement({
    pose,
    frameContext: { source: "xr", intents: { ...idleIntents, source: "xr" } },
    deltaSeconds: 0.016,
    floorY: 0,
    currentSeatId: "seat-a",
    seatRootPosition: { x: 5, y: 0.45, z: -2 },
    seatYaw: Math.PI / 2,
    lastAppliedSeatLockId: "seat-a",
    cameraForward: { x: 0, z: -1 },
    desktopFastMove: false
  });

  assert.equal(plan.kind, "seat_lock");
  if (plan.kind !== "seat_lock") {
    throw new Error("expected seat lock plan");
  }
  assert.equal(plan.reason, "seat_lock");
  assert.equal(plan.yaw, undefined);
});

test("frame locomotion releases missing seat anchor and falls through to standing movement", () => {
  const plan = planFrameLocomotionMovement({
    pose,
    frameContext: {
      source: "xr",
      intents: { ...idleIntents, source: "xr", move: { x: 0, z: -1 } }
    },
    deltaSeconds: 1,
    floorY: 0,
    currentSeatId: "missing-seat",
    seatRootPosition: null,
    lastAppliedSeatLockId: "missing-seat",
    cameraForward: { x: 0, z: -1 },
    desktopFastMove: false
  });

  assert.equal(plan.kind, "standing");
  if (plan.kind !== "standing") {
    throw new Error("expected standing plan");
  }
  assert.deepEqual(plan.commands, [{ type: "release_local_seat" }]);
  assert.equal(plan.movementReason, "xr_move");
  assert.equal(plan.pose.position.x, 0);
  assert.equal(plan.pose.position.z, -2.4);
});

test("frame locomotion uses bot move for non-XR movement planning", () => {
  const plan = planFrameLocomotionMovement({
    pose,
    frameContext: {
      source: "desktop",
      intents: { ...idleIntents, move: { x: 0, z: 0 } }
    },
    deltaSeconds: 1,
    floorY: 0,
    currentSeatId: null,
    lastAppliedSeatLockId: null,
    cameraForward: { x: 0, z: -1 },
    desktopFastMove: true,
    botMove: { x: 1, z: 0 }
  });

  assert.equal(plan.kind, "standing");
  if (plan.kind !== "standing") {
    throw new Error("expected standing plan");
  }
  assert.deepEqual(plan.avatarMove, { x: 1, z: 0 });
  assert.equal(plan.movementReason, "desktop_move");
  assert.equal(plan.pose.position.x, 5);
  assert.equal(plan.pose.position.z, 0);
});
