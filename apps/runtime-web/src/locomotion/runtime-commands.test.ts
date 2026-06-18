import test from "node:test";
import assert from "node:assert/strict";

import { executeRuntimeCommands, planInteractionCommands, type RuntimeCommandHandlers } from "./runtime-commands.js";

test("interaction planner claims a standing seat through commands", () => {
  const result = planInteractionCommands({
    target: { kind: "seat", point: { x: 1, y: 0, z: 2 }, seatId: "seat-a", label: "Front" },
    mode: { kind: "standing", floorY: 0 },
    pendingSeatId: null,
    seatingAvailable: true,
    nowMs: 1000,
    lastInteractionConfirmAtMs: 0
  });

  assert.deepEqual(result.commands, [
    { type: "request_seat_claim", seatId: "seat-a" },
    { type: "telemetry", kind: "seat_claim" },
    { type: "send_seat_claim", seatId: "seat-a" },
    { type: "status", message: "Claiming seat Front" }
  ]);
  assert.equal(result.lastInteractionConfirmAtMs, 1000);
});

test("interaction planner suppresses duplicate pending seat claims", () => {
  const result = planInteractionCommands({
    target: { kind: "seat", point: { x: 1, y: 0, z: 2 }, seatId: "seat-a" },
    mode: { kind: "standing", floorY: 0 },
    pendingSeatId: "seat-a",
    seatingAvailable: true,
    nowMs: 1000,
    lastInteractionConfirmAtMs: 0
  });

  assert.deepEqual(result.commands, []);
  assert.equal(result.lastInteractionConfirmAtMs, 1000);
});

test("interaction planner switches seated seat through claim without local teleport", () => {
  const result = planInteractionCommands({
    target: { kind: "seat", point: { x: 4, y: 0, z: 5 }, seatId: "seat-b" },
    mode: { kind: "seated", seatId: "seat-a", allowYaw: true },
    pendingSeatId: null,
    seatingAvailable: true,
    nowMs: 1000,
    lastInteractionConfirmAtMs: 0
  });

  assert.deepEqual(result.commands, [
    { type: "request_seat_claim", seatId: "seat-b" },
    { type: "telemetry", kind: "seat_claim" },
    { type: "send_seat_claim", seatId: "seat-b" },
    { type: "status", message: "Claiming seat seat-b" }
  ]);
  assert.equal(result.commands.some((command) => command.type === "teleport_to_floor"), false);
});

test("interaction planner reports unavailable seating without claiming", () => {
  const result = planInteractionCommands({
    target: { kind: "seat", point: { x: 1, y: 0, z: 2 }, seatId: "seat-a" },
    mode: { kind: "standing", floorY: 0 },
    pendingSeatId: null,
    seatingAvailable: false,
    nowMs: 1000,
    lastInteractionConfirmAtMs: 0
  });

  assert.deepEqual(result.commands, [{ type: "status", message: "Seating unavailable" }]);
  assert.equal(result.lastInteractionConfirmAtMs, 1000);
});

test("interaction planner teleports standing users without seat release", () => {
  const result = planInteractionCommands({
    target: { kind: "floor", point: { x: 2, y: 0, z: -3 } },
    mode: { kind: "standing", floorY: 0 },
    pendingSeatId: null,
    seatingAvailable: true,
    nowMs: 1000,
    lastInteractionConfirmAtMs: 0
  });

  assert.deepEqual(result.commands, [
    { type: "teleport_to_floor", point: { x: 2, y: 0, z: -3 } },
    { type: "status", message: "Teleported" }
  ]);
});

test("interaction planner releases seated users before floor teleport", () => {
  const result = planInteractionCommands({
    target: { kind: "floor", point: { x: 2, y: 0, z: -3 } },
    mode: { kind: "seated", seatId: "seat-a", allowYaw: true },
    pendingSeatId: null,
    seatingAvailable: true,
    nowMs: 1000,
    lastInteractionConfirmAtMs: 0
  });

  assert.deepEqual(result.commands, [
    { type: "telemetry", kind: "seat_release" },
    { type: "send_seat_release", seatId: "seat-a" },
    { type: "release_local_seat" },
    { type: "teleport_to_floor", point: { x: 2, y: 0, z: -3 } },
    { type: "status", message: "Teleported" }
  ]);
});

test("interaction planner debounces repeated confirmations", () => {
  const result = planInteractionCommands({
    target: { kind: "floor", point: { x: 2, y: 0, z: -3 } },
    mode: { kind: "standing", floorY: 0 },
    pendingSeatId: null,
    seatingAvailable: true,
    nowMs: 1100,
    lastInteractionConfirmAtMs: 1000
  });

  assert.deepEqual(result.commands, []);
  assert.equal(result.lastInteractionConfirmAtMs, 1000);
});

test("runtime command executor preserves command order", () => {
  const calls: string[] = [];
  const handlers: RuntimeCommandHandlers = {
    requestSeatClaim: (seatId) => calls.push(`request:${seatId}`),
    sendSeatClaim: (seatId) => calls.push(`claim:${seatId}`),
    sendSeatRelease: (seatId) => calls.push(`release:${seatId}`),
    releaseLocalSeat: () => calls.push("release-local"),
    lockToSeat: (position, reason, options) => {
      calls.push(`lock:${position.x},${position.y},${position.z}:${reason}:${options?.yaw ?? "none"}`);
    },
    moveFlatTo: (position, reason) => calls.push(`move:${position.x},${position.z}:${reason}`),
    applySnapTurnYaw: (yaw) => calls.push(`snap-yaw:${yaw}`),
    setXrInputProfile: (profile) => calls.push(`profile:${profile ?? "none"}`),
    setDebugXrAxes: (axes) => calls.push(`axes:${axes.turnX}`),
    setXrRayVisibleLatched: (visible) => calls.push(`ray:${visible}`),
    setXrTurnCooldown: (seconds) => calls.push(`cooldown:${seconds}`),
    setXrTurnArmed: (armed) => calls.push(`armed:${armed}`),
    setXrSelectPressedLastFrame: (pressed) => calls.push(`pressed:${pressed}`),
    clearXrAvatarDebug: () => calls.push("clear-xr-avatar-debug"),
    setDebugLocomotionMode: (mode) => calls.push(`mode:${mode}`),
    setLastAppliedSeatLockId: (seatId) => calls.push(`last-seat:${seatId}`),
    setAvatarMovement: (move, turnRate) => calls.push(`avatar-move:${move.x},${move.z}:${turnRate}`),
    updateLocalPositionDebug: () => calls.push("position-debug"),
    teleportToFloor: (point) => calls.push(`teleport:${point.x},${point.y},${point.z}`),
    setStatus: (message) => calls.push(`status:${message}`),
    markTelemetry: (kind) => calls.push(`telemetry:${kind}`)
  };

  executeRuntimeCommands([
    { type: "request_seat_claim", seatId: "seat-a" },
    { type: "send_seat_claim", seatId: "seat-a" },
    { type: "telemetry", kind: "seat_release" },
    { type: "send_seat_release", seatId: "seat-a" },
    { type: "release_local_seat" },
    { type: "lock_to_seat", seatId: "seat-a", position: { x: 2, y: 0.4, z: 3 }, reason: "seat_enter", yaw: 1.2 },
    { type: "move_flat_to", position: { x: 4, z: 5 }, reason: "desktop_move" },
    { type: "apply_snap_turn_yaw", yaw: 0.5 },
    { type: "set_xr_input_profile", profile: "synthetic-right" },
    { type: "set_debug_xr_axes", axes: { moveX: 0, moveY: 0, turnX: 0.5, turnY: 0 } },
    { type: "set_xr_ray_visible_latched", visible: true },
    { type: "set_xr_turn_cooldown", seconds: 0.28 },
    { type: "set_xr_turn_armed", armed: false },
    { type: "set_xr_select_pressed_last_frame", pressed: true },
    { type: "clear_xr_avatar_debug" },
    { type: "set_debug_locomotion_mode", mode: "vr" },
    { type: "set_last_applied_seat_lock_id", seatId: "seat-a" },
    { type: "set_avatar_movement", move: { x: 0, z: -1 }, turnRate: 0.25 },
    { type: "update_local_position_debug" },
    { type: "teleport_to_floor", point: { x: 1, y: 0, z: 2 } },
    { type: "status", message: "Teleported" }
  ], handlers);

  assert.deepEqual(calls, [
    "request:seat-a",
    "claim:seat-a",
    "telemetry:seat_release",
    "release:seat-a",
    "release-local",
    "lock:2,0.4,3:seat_enter:1.2",
    "move:4,5:desktop_move",
    "snap-yaw:0.5",
    "profile:synthetic-right",
    "axes:0.5",
    "ray:true",
    "cooldown:0.28",
    "armed:false",
    "pressed:true",
    "clear-xr-avatar-debug",
    "mode:vr",
    "last-seat:seat-a",
    "avatar-move:0,-1:0.25",
    "position-debug",
    "teleport:1,0,2",
    "status:Teleported"
  ]);
});
