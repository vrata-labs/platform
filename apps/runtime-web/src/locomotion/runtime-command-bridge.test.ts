import test from "node:test";
import assert from "node:assert/strict";

import type { RoomStateClient } from "../room-state-client.js";
import { createRuntimeCommandExecutor } from "./runtime-command-bridge.js";

test("runtime command bridge wires seating, room-state, pose, status, and telemetry handlers", () => {
  const calls: string[] = [];
  const client = {} as RoomStateClient;
  const executeRuntimeCommandList = createRuntimeCommandExecutor({
    seatingController: {
      requestSeatClaim: (seatId) => {
        calls.push(`request:${seatId}`);
        return {
          state: { kind: "claiming", pendingSeatId: seatId },
          currentSeatId: null,
          pendingSeatId: seatId
        };
      }
    },
    getRoomStateClient: () => client,
    isRoomStateConnected: () => true,
    syncSeatDebugState: () => calls.push("sync-seat-debug"),
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
    markTelemetry: (kind) => calls.push(`telemetry:${kind}`),
    sendSeatClaim: (_client, seatId) => calls.push(`send-claim:${seatId}`),
    sendSeatRelease: (_client, seatId) => calls.push(`send-release:${seatId}`)
  });

  executeRuntimeCommandList([
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
  ]);

  assert.deepEqual(calls, [
    "request:seat-a",
    "sync-seat-debug",
    "send-claim:seat-a",
    "telemetry:seat_release",
    "send-release:seat-a",
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

test("runtime command bridge does not send seat commands without a connected room-state client", () => {
  const calls: string[] = [];
  const client = {} as RoomStateClient;
  let connected = false;
  const executeRuntimeCommandList = createRuntimeCommandExecutor({
    seatingController: {
      requestSeatClaim: (seatId) => ({
        state: { kind: "claiming", pendingSeatId: seatId },
        currentSeatId: null,
        pendingSeatId: seatId
      })
    },
    getRoomStateClient: () => client,
    isRoomStateConnected: () => connected,
    syncSeatDebugState: () => undefined,
    releaseLocalSeat: () => undefined,
    lockToSeat: () => undefined,
    moveFlatTo: () => undefined,
    applySnapTurnYaw: () => undefined,
    setXrInputProfile: () => undefined,
    setDebugXrAxes: () => undefined,
    setXrRayVisibleLatched: () => undefined,
    setXrTurnCooldown: () => undefined,
    setXrTurnArmed: () => undefined,
    setXrSelectPressedLastFrame: () => undefined,
    clearXrAvatarDebug: () => undefined,
    setDebugLocomotionMode: () => undefined,
    setLastAppliedSeatLockId: () => undefined,
    setAvatarMovement: () => undefined,
    updateLocalPositionDebug: () => undefined,
    teleportToFloor: () => undefined,
    setStatus: () => undefined,
    markTelemetry: () => undefined,
    sendSeatClaim: (_client, seatId) => calls.push(`send-claim:${seatId}`),
    sendSeatRelease: (_client, seatId) => calls.push(`send-release:${seatId}`)
  });

  executeRuntimeCommandList([
    { type: "send_seat_claim", seatId: "seat-a" },
    { type: "send_seat_release", seatId: "seat-a" }
  ]);
  connected = true;
  executeRuntimeCommandList([
    { type: "send_seat_claim", seatId: "seat-b" },
    { type: "send_seat_release", seatId: "seat-b" }
  ]);

  assert.deepEqual(calls, ["send-claim:seat-b", "send-release:seat-b"]);
});
