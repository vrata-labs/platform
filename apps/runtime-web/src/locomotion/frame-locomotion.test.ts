import test from "node:test";
import assert from "node:assert/strict";

import type { InputIntents } from "../input/input-intents.js";
import type { RuntimeFrameContext } from "../input/runtime-frame-context.js";
import type { LocalPose } from "../local/local-pose.js";
import { executeFrameXrControlPlan, planFrameLocomotionMovement, planFrameXrControls } from "./frame-locomotion.js";

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

function xrFrameContext(input: {
  intents?: Partial<InputIntents>;
  turnX?: number;
  turnY?: number;
  triggerPressed?: boolean;
  rayVisibleLatched?: boolean;
}): RuntimeFrameContext {
  const sanitizedAxes = {
    moveX: 0,
    moveY: 0,
    turnX: input.turnX ?? 0,
    turnY: input.turnY ?? 0
  };
  return {
    deltaSeconds: 0.016,
    nowMs: 1000,
    source: "xr",
    intents: {
      ...idleIntents,
      source: "xr",
      ...input.intents,
      move: input.intents?.move ?? idleIntents.move,
      snapTurn: input.intents?.snapTurn ?? idleIntents.snapTurn
    },
    xr: {
      frame: undefined,
      session: undefined,
      referenceSpace: null,
      inputSources: [],
      profile: "synthetic-right",
      sanitizedAxes,
      rawAxes: sanitizedAxes,
      triggerPressed: input.triggerPressed ?? false,
      rayVisibleLatched: input.rayVisibleLatched ?? false
    }
  };
}

test("frame XR controls plan snap turn from sampled frame context", () => {
  const plan = planFrameXrControls({
    frameContext: xrFrameContext({ intents: { snapTurn: { axis: -0.8 } }, turnX: -0.8 }),
    yaw: 0,
    currentSeatId: null,
    turnCooldownSeconds: 0,
    turnArmed: true,
    deltaSeconds: 0.016
  });

  assert.equal(plan.kind, "xr");
  if (plan.kind !== "xr") {
    throw new Error("expected xr control plan");
  }
  assert.equal(Number(plan.nextYaw?.toFixed(3)), Number((Math.PI / 6).toFixed(3)));
  assert.equal(plan.turnCooldownSeconds, 0.28);
  assert.equal(plan.turnArmed, false);
  assert.equal(plan.clearAvatarDebug, false);
  assert.equal(plan.debugLocomotionMode, "vr");
  assert.deepEqual(plan.snapTurnCommands, [
    { type: "apply_snap_turn_yaw", yaw: Math.PI / 6 },
    { type: "telemetry", kind: "snap_turn" }
  ]);
  assert.equal(plan.confirmInteraction, false);
  assert.deepEqual(plan.confirmInteractionCommands, []);
  assert.equal(plan.triggerPressedLastFrame, false);
});

test("frame XR controls plan seated debug mode from the pre-frame seat state", () => {
  const plan = planFrameXrControls({
    frameContext: xrFrameContext({}),
    yaw: 0,
    currentSeatId: "seat-a",
    turnCooldownSeconds: 0,
    turnArmed: true,
    deltaSeconds: 0.016
  });

  assert.equal(plan.kind, "xr");
  if (plan.kind !== "xr") {
    throw new Error("expected xr control plan");
  }
  assert.equal(plan.debugLocomotionMode, "vr-seated");
});

test("frame XR controls suppress snap turn while ray intent consumes diagonal input", () => {
  const plan = planFrameXrControls({
    frameContext: xrFrameContext({
      intents: { snapTurn: { axis: 0 }, aimRay: true },
      turnX: -0.8,
      turnY: -0.6,
      rayVisibleLatched: true
    }),
    yaw: 0,
    currentSeatId: null,
    turnCooldownSeconds: 0,
    turnArmed: true,
    deltaSeconds: 0.016
  });

  assert.equal(plan.kind, "xr");
  if (plan.kind !== "xr") {
    throw new Error("expected xr control plan");
  }
  assert.equal(plan.nextYaw, null);
  assert.equal(plan.turnArmed, false);
  assert.equal(plan.rayVisibleLatched, true);
});

test("frame XR controls expose confirm interaction trigger edge", () => {
  const plan = planFrameXrControls({
    frameContext: xrFrameContext({
      intents: { confirmInteraction: true },
      triggerPressed: true
    }),
    yaw: 0,
    currentSeatId: null,
    turnCooldownSeconds: 0,
    turnArmed: true,
    deltaSeconds: 0.016
  });

  assert.equal(plan.kind, "xr");
  if (plan.kind !== "xr") {
    throw new Error("expected xr control plan");
  }
  assert.equal(plan.confirmInteraction, true);
  assert.deepEqual(plan.confirmInteractionCommands, [{ type: "telemetry", kind: "trigger_press" }]);
  assert.equal(plan.triggerPressedLastFrame, true);
});

test("frame XR controls reset transient XR flags outside XR frames", () => {
  const plan = planFrameXrControls({
    frameContext: {
      deltaSeconds: 0.016,
      nowMs: 1000,
      source: "desktop",
      intents: idleIntents
    },
    yaw: 0,
    currentSeatId: null,
    turnCooldownSeconds: 0.2,
    turnArmed: false,
    deltaSeconds: 0.016
  });

  assert.equal(plan.kind, "non_xr");
  assert.equal(plan.inputProfile, null);
  assert.deepEqual(plan.sanitizedAxes, { moveX: 0, moveY: 0, turnX: 0, turnY: 0 });
  assert.equal(plan.clearAvatarDebug, true);
  assert.equal(plan.debugLocomotionMode, null);
  assert.equal(plan.rayVisibleLatched, false);
  assert.equal(plan.turnArmed, true);
  assert.equal(plan.confirmInteraction, false);
  assert.equal(plan.triggerPressedLastFrame, false);
});

test("frame XR controls executor resets non-XR frame debug state", () => {
  const plan = planFrameXrControls({
    frameContext: {
      deltaSeconds: 0.016,
      nowMs: 1000,
      source: "desktop",
      intents: idleIntents
    },
    yaw: 0,
    currentSeatId: null,
    turnCooldownSeconds: 0.2,
    turnArmed: false,
    deltaSeconds: 0.016
  });
  const calls: string[] = [];

  executeFrameXrControlPlan(plan, {
    setXrInputProfile: (profile) => calls.push(`profile:${profile ?? "none"}`),
    setDebugXrAxes: (axes) => calls.push(`axes:${axes.turnX}`),
    setXrRayVisibleLatched: (visible) => calls.push(`ray:${visible}`),
    setXrTurnCooldown: (seconds) => calls.push(`cooldown:${seconds}`),
    setXrTurnArmed: (armed) => calls.push(`armed:${armed}`),
    setXrSelectPressedLastFrame: (pressed) => calls.push(`pressed:${pressed}`),
    clearXrAvatarDebug: () => calls.push("clear-avatar-debug"),
    setDebugLocomotionMode: (mode) => calls.push(`mode:${mode}`),
    executeCommands: (commands) => calls.push(`commands:${commands.map((command) => command.type).join(",")}`),
    confirmInteractionTarget: () => calls.push("confirm")
  });

  assert.deepEqual(calls, [
    "pressed:false",
    "ray:false",
    "armed:true",
    "profile:none",
    "clear-avatar-debug",
    "axes:0"
  ]);
});

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
  assert.deepEqual(plan.commands, [
    { type: "move_flat_to", position: { x: 3.2, z: 0 }, reason: "desktop_move" }
  ]);
  assert.deepEqual(plan.avatarMove, { x: 0, z: -1 });
  assert.equal(plan.avatarTurnRate, 0);
  assert.equal(plan.movementReason, "desktop_move");
  assert.equal(plan.debugLocomotionMode, "desktop");
  assert.equal(plan.pose.position.x, 3.2);
  assert.equal(plan.pose.position.z, 0);
});

test("frame locomotion plans mobile touch debug mode without desktop movement", () => {
  const plan = planFrameLocomotionMovement({
    pose,
    frameContext: {
      source: "touch",
      intents: { ...idleIntents, source: "touch" }
    },
    deltaSeconds: 1,
    floorY: 0,
    currentSeatId: null,
    lastAppliedSeatLockId: null,
    cameraForward: { x: 0, z: -1 },
    desktopFastMove: false
  });

  assert.equal(plan.kind, "standing");
  if (plan.kind !== "standing") {
    throw new Error("expected standing plan");
  }
  assert.equal(plan.movementReason, null);
  assert.equal(plan.debugLocomotionMode, "mobile-touch");
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
  assert.deepEqual(plan.commands, [
    { type: "release_local_seat" },
    { type: "move_flat_to", position: { x: 0, z: -2.4 }, reason: "xr_move" }
  ]);
  assert.equal(plan.movementReason, "xr_move");
  assert.equal(plan.debugLocomotionMode, null);
  assert.equal(plan.avatarTurnRate, 0);
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
  assert.equal(plan.avatarTurnRate, 0);
  assert.equal(plan.movementReason, "desktop_move");
  assert.equal(plan.debugLocomotionMode, "desktop");
  assert.equal(plan.pose.position.x, 5);
  assert.equal(plan.pose.position.z, 0);
});
