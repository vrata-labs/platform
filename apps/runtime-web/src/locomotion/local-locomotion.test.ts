import test from "node:test";
import assert from "node:assert/strict";

import { resolveLocomotionMode, stepLocalLocomotion } from "./local-locomotion.js";
import type { InputIntents } from "../input/input-intents.js";

const idleIntents: InputIntents = {
  move: { x: 0, z: 0 },
  snapTurn: { axis: 0 },
  aimRay: false,
  confirmInteraction: false,
  source: "desktop"
};

const pose = {
  position: { x: 0, y: 0, z: 0 },
  yaw: 0,
  pitch: 0
};

test("standing locomotion move changes xz", () => {
  const result = stepLocalLocomotion({
    pose,
    mode: resolveLocomotionMode({ seatId: null, floorY: 0 }),
    intents: idleIntents,
    deltaSeconds: 1,
    speed: 2,
    worldMove: { x: 1, z: 0 }
  });

  assert.equal(result.pose.position.x, 2);
  assert.equal(result.pose.position.z, 0);
});

test("standing locomotion snap turn changes yaw", () => {
  const result = stepLocalLocomotion({
    pose,
    mode: resolveLocomotionMode({ seatId: null, floorY: 0 }),
    intents: idleIntents,
    deltaSeconds: 0.016,
    speed: 2,
    worldMove: { x: 0, z: 0 },
    nextYaw: Math.PI / 2
  });

  assert.equal(result.pose.yaw, Math.PI / 2);
});

test("seated locomotion move keeps seat anchor position", () => {
  const result = stepLocalLocomotion({
    pose,
    mode: resolveLocomotionMode({ seatId: "seat-a", floorY: 0 }),
    intents: idleIntents,
    deltaSeconds: 1,
    speed: 2,
    worldMove: { x: 1, z: 0 },
    seatRootPosition: { x: 5, y: 0.45, z: -2 }
  });

  assert.deepEqual(result.pose.position, { x: 5, y: 0.45, z: -2 });
});

test("seated locomotion snap turn changes yaw but keeps position", () => {
  const result = stepLocalLocomotion({
    pose,
    mode: resolveLocomotionMode({ seatId: "seat-a", floorY: 0 }),
    intents: idleIntents,
    deltaSeconds: 0.016,
    speed: 2,
    worldMove: { x: 1, z: 0 },
    seatRootPosition: { x: 5, y: 0.45, z: -2 },
    nextYaw: Math.PI
  });

  assert.deepEqual(result.pose.position, { x: 5, y: 0.45, z: -2 });
  assert.equal(result.pose.yaw, Math.PI);
});

test("seated floor confirm releases seat and applies teleport transition", () => {
  const result = stepLocalLocomotion({
    pose,
    mode: resolveLocomotionMode({ seatId: "seat-a", floorY: 0 }),
    intents: { ...idleIntents, confirmInteraction: true },
    deltaSeconds: 0.016,
    speed: 2,
    worldMove: { x: 0, z: 0 },
    interactionTarget: { kind: "floor", point: { x: 2, y: 0, z: -3 } }
  });

  assert.deepEqual(result.commands, [{ type: "send_seat_release", seatId: "seat-a" }]);
  assert.equal(result.mode.kind, "standing");
  assert.deepEqual(result.pose.position, { x: 2, y: 0, z: -3 });
});

test("standing seat confirm emits claim and does not locally teleport", () => {
  const result = stepLocalLocomotion({
    pose,
    mode: resolveLocomotionMode({ seatId: null, floorY: 0 }),
    intents: { ...idleIntents, confirmInteraction: true },
    deltaSeconds: 0.016,
    speed: 2,
    worldMove: { x: 0, z: 0 },
    interactionTarget: { kind: "seat", point: { x: 5, y: 0.45, z: -2 }, seatId: "seat-a" }
  });

  assert.deepEqual(result.commands, [{ type: "send_seat_claim", seatId: "seat-a" }]);
  assert.deepEqual(result.pose.position, pose.position);
});
