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
