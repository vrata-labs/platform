import test from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";

import type { SceneBundleSeatAnchor } from "../scene-bundle.js";
import {
  createInteractionCommandPlanner,
  planInteractionTargetCommands,
  toRuntimeCommandInteractionTarget
} from "./interaction-command-planner.js";

function seatAnchor(id: string, label?: string): SceneBundleSeatAnchor {
  return {
    id,
    label,
    position: { x: 1, y: 0, z: -2 },
    yaw: 0,
    seatHeight: 0.5,
    radius: 0.8
  };
}

test("interaction command planner converts seat targets without local teleport", () => {
  const anchor = seatAnchor("seat-a", "Front");
  const point = new THREE.Vector3(1, 0.5, -2);
  const target = { kind: "seat" as const, point, seatId: anchor.id, seatAnchor: anchor };

  const converted = toRuntimeCommandInteractionTarget(target);

  assert.equal(converted.kind, "seat");
  if (converted.kind === "seat") {
    assert.equal(converted.point, point);
    assert.equal(converted.seatId, "seat-a");
    assert.equal(converted.label, "Front");
  }

  const planned = planInteractionTargetCommands({
    target,
    currentSeatId: null,
    pendingSeatId: null,
    floorY: 0,
    seatingAvailable: true,
    nowMs: 1000,
    lastInteractionConfirmAtMs: 0
  });

  assert.deepEqual(planned.commands.map((command) => command.type), [
    "request_seat_claim",
    "telemetry",
    "send_seat_claim",
    "status"
  ]);
  assert.equal(planned.commands.some((command) => command.type === "teleport_to_floor"), false);
});

test("interaction command planner owns confirm debounce state", () => {
  const planner = createInteractionCommandPlanner({ initialLastInteractionConfirmAtMs: 0 });
  const target = { kind: "floor" as const, point: new THREE.Vector3(2, 0, -3) };

  const firstCommands = planner.plan({
    target,
    currentSeatId: null,
    pendingSeatId: null,
    floorY: 0,
    seatingAvailable: true,
    nowMs: 1000
  });

  assert.deepEqual(firstCommands.map((command) => command.type), ["teleport_to_floor", "status"]);
  assert.equal(planner.getLastInteractionConfirmAtMs(), 1000);

  const repeatedCommands = planner.plan({
    target,
    currentSeatId: null,
    pendingSeatId: null,
    floorY: 0,
    seatingAvailable: true,
    nowMs: 1100
  });

  assert.deepEqual(repeatedCommands, []);
  assert.equal(planner.getLastInteractionConfirmAtMs(), 1000);
});

test("interaction command planner releases seated users before floor teleport", () => {
  const planner = createInteractionCommandPlanner();
  const target = { kind: "floor" as const, point: new THREE.Vector3(2, 0, -3) };

  const commands = planner.plan({
    target,
    currentSeatId: "seat-a",
    pendingSeatId: null,
    floorY: 0,
    seatingAvailable: true,
    nowMs: 1000
  });

  assert.deepEqual(commands.map((command) => command.type), [
    "telemetry",
    "send_seat_release",
    "release_local_seat",
    "teleport_to_floor",
    "status"
  ]);
  const teleportCommand = commands.find((command) => command.type === "teleport_to_floor");
  assert.ok(teleportCommand);
  if (teleportCommand.type === "teleport_to_floor") {
    assert.equal(teleportCommand.point.x, 2);
    assert.equal(teleportCommand.point.z, -3);
  }
});
