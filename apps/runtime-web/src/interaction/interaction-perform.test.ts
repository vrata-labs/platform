import test from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";

import type { InteractionCommandPlanner } from "../locomotion/interaction-command-planner.js";
import type { RuntimeCommand } from "../locomotion/runtime-commands.js";
import type { InteractionRayDebugState } from "./interaction-ray-view.js";
import { createInteractionTargetPerformer } from "./interaction-perform.js";

function emptyDebugState(): InteractionRayDebugState {
  return {
    active: false,
    mode: "none",
    targetKind: "none",
    seatId: null,
    point: null,
    origin: null,
    direction: null,
    source: null
  };
}

function plannerWith(plan: InteractionCommandPlanner["plan"]): InteractionCommandPlanner {
  return {
    plan,
    getLastInteractionConfirmAtMs() {
      return 0;
    }
  };
}

test("interaction target performer delegates target planning through executor", () => {
  const planned: RuntimeCommand[] = [{ type: "status", message: "planned" }];
  const capturedInputs: Array<Parameters<InteractionCommandPlanner["plan"]>[0]> = [];
  const executed: RuntimeCommand[][] = [];
  const performer = createInteractionTargetPerformer({
    planner: plannerWith((input) => {
      capturedInputs.push(input);
      return planned;
    }),
    executeCommands(commands) {
      executed.push(commands);
    },
    getContext: () => ({
      currentSeatId: "seat-a",
      pendingSeatId: "seat-b",
      floorY: 0.25,
      seatingAvailable: false,
      nowMs: 500
    })
  });
  const target = { kind: "floor" as const, point: new THREE.Vector3(1, 0.25, -2) };

  const commands = performer.performTarget(target, { debounceMs: 0, nowMs: 600 });

  assert.equal(commands, planned);
  assert.deepEqual(executed, [planned]);
  const captured = capturedInputs[0];
  assert.ok(captured);
  assert.equal(captured.target, target);
  assert.equal(captured.currentSeatId, "seat-a");
  assert.equal(captured.pendingSeatId, "seat-b");
  assert.equal(captured.floorY, 0.25);
  assert.equal(captured.seatingAvailable, false);
  assert.equal(captured.nowMs, 600);
  assert.equal(captured.debounceMs, 0);
});

test("interaction target performer clears visuals when direct ray has no target", () => {
  let clearCount = 0;
  const executed: RuntimeCommand[][] = [];
  const performer = createInteractionTargetPerformer({
    planner: plannerWith(() => {
      throw new Error("planner should not run without a target");
    }),
    executeCommands(commands) {
      executed.push(commands);
    },
    getContext: () => ({
      currentSeatId: null,
      pendingSeatId: null,
      floorY: 0,
      seatingAvailable: true,
      nowMs: 1000
    })
  });

  const target = performer.performDirectRayTarget({
    ray: new THREE.Ray(new THREE.Vector3(0, 1, 0), new THREE.Vector3(0, 1, 0)),
    seatMarkerHitMeshes: [],
    seatAnchorMap: new Map(),
    raycaster: new THREE.Raycaster(),
    seatAnchors: [],
    teleportFloorY: 0,
    state: emptyDebugState(),
    clearVisuals() {
      clearCount += 1;
    }
  });

  assert.equal(target.kind, "none");
  assert.equal(clearCount, 1);
  assert.deepEqual(executed, []);
});

test("interaction target performer resolves direct floor rays before executing", () => {
  const state = emptyDebugState();
  const executed: RuntimeCommand[][] = [];
  let capturedTarget: Parameters<InteractionCommandPlanner["plan"]>[0]["target"] | null = null;
  const performer = createInteractionTargetPerformer({
    planner: plannerWith((input) => {
      capturedTarget = input.target;
      return [{ type: "status", message: "performed" }];
    }),
    executeCommands(commands) {
      executed.push(commands);
    },
    getContext: () => ({
      currentSeatId: null,
      pendingSeatId: null,
      floorY: 0,
      seatingAvailable: true,
      nowMs: 1000
    })
  });

  const target = performer.performDirectRayTarget({
    ray: new THREE.Ray(new THREE.Vector3(0, 1, 0), new THREE.Vector3(0, -1, 0)),
    seatMarkerHitMeshes: [],
    seatAnchorMap: new Map(),
    raycaster: new THREE.Raycaster(),
    seatAnchors: [],
    teleportFloorY: 0,
    state,
    mode: "cursor",
    clearVisuals() {
      throw new Error("clearVisuals should not run for a floor target");
    }
  });

  assert.equal(target.kind, "floor");
  assert.equal(capturedTarget, target);
  assert.deepEqual(executed, [[{ type: "status", message: "performed" }]]);
  assert.equal(state.active, true);
  assert.equal(state.mode, "cursor");
  assert.equal(state.targetKind, "floor");
  assert.deepEqual(state.point, { x: 0, y: 0, z: 0 });
});
