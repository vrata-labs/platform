import test from "node:test";
import assert from "node:assert/strict";

import type { InputIntents } from "../input/input-intents.js";
import type { RuntimeFrameContext } from "../input/runtime-frame-context.js";
import type { LocalPose, Vector3Like } from "../local/local-pose.js";
import type { FlatVector, XrAxesSample } from "../movement.js";
import { resolveLocomotionMode } from "./local-locomotion.js";
import { executeFrameLocomotionCommands, type FrameLocomotionCommand } from "./frame-command-bridge.js";
import {
  executeFrameLocomotionPipeline,
  type FrameLocomotionPipelineResult
} from "./frame-locomotion.js";
import {
  executeRuntimeCommands,
  planInteractionCommands,
  type RuntimeCommand,
  type RuntimeCommandInteractionTarget
} from "./runtime-commands.js";

const idleIntents: InputIntents = {
  move: { x: 0, z: 0 },
  snapTurn: { axis: 0 },
  aimRay: false,
  confirmInteraction: false,
  source: "desktop"
};

interface FlowState {
  pose: LocalPose;
  currentSeatId: string | null;
  pendingSeatId: string | null;
  lastAppliedSeatLockId: string | null;
  xrInputProfile: string | null;
  debugXrAxes: XrAxesSample;
  xrRayVisibleLatched: boolean;
  xrTurnCooldown: number;
  xrTurnArmed: boolean;
  xrSelectPressedLastFrame: boolean;
  xrAvatarDebugCleared: boolean;
  lastInteractionConfirmAtMs: number;
  debugLocomotionMode: string | null;
  commands: RuntimeCommand[];
  lastAvatarMove: FlatVector;
  lastAvatarTurnRate: number;
  localPositionDebugUpdates: number;
  sentSeatClaims: string[];
  sentSeatReleases: string[];
  telemetry: string[];
  statuses: string[];
}

function createState(input: Partial<FlowState> = {}): FlowState {
  return {
    pose: input.pose ?? { position: { x: 0, y: 0, z: 0 }, yaw: 0, pitch: 0 },
    currentSeatId: input.currentSeatId ?? null,
    pendingSeatId: input.pendingSeatId ?? null,
    lastAppliedSeatLockId: input.lastAppliedSeatLockId ?? null,
    xrInputProfile: input.xrInputProfile ?? null,
    debugXrAxes: input.debugXrAxes ?? { moveX: 0, moveY: 0, turnX: 0, turnY: 0 },
    xrRayVisibleLatched: input.xrRayVisibleLatched ?? false,
    xrTurnCooldown: input.xrTurnCooldown ?? 0,
    xrTurnArmed: input.xrTurnArmed ?? true,
    xrSelectPressedLastFrame: input.xrSelectPressedLastFrame ?? false,
    xrAvatarDebugCleared: input.xrAvatarDebugCleared ?? false,
    lastInteractionConfirmAtMs: input.lastInteractionConfirmAtMs ?? 0,
    debugLocomotionMode: input.debugLocomotionMode ?? null,
    commands: input.commands ?? [],
    lastAvatarMove: input.lastAvatarMove ?? { x: 0, z: 0 },
    lastAvatarTurnRate: input.lastAvatarTurnRate ?? 0,
    localPositionDebugUpdates: input.localPositionDebugUpdates ?? 0,
    sentSeatClaims: input.sentSeatClaims ?? [],
    sentSeatReleases: input.sentSeatReleases ?? [],
    telemetry: input.telemetry ?? [],
    statuses: input.statuses ?? []
  };
}

function frameContext(input: {
  source?: "desktop" | "xr" | "touch";
  move?: FlatVector;
  snapTurnAxis?: number;
  aimRay?: boolean;
  confirmInteraction?: boolean;
  xrAxes?: Partial<XrAxesSample>;
  triggerPressed?: boolean;
  rayVisibleLatched?: boolean;
} = {}): RuntimeFrameContext {
  const source = input.source ?? "desktop";
  const intents: InputIntents = {
    ...idleIntents,
    source,
    move: input.move ?? idleIntents.move,
    snapTurn: { axis: input.snapTurnAxis ?? 0 },
    aimRay: input.aimRay ?? false,
    confirmInteraction: input.confirmInteraction ?? false
  };
  const baseContext = {
    deltaSeconds: 0.016,
    nowMs: 1000,
    source,
    intents
  };

  if (source !== "xr") {
    return baseContext;
  }

  const sanitizedAxes = {
    moveX: input.xrAxes?.moveX ?? 0,
    moveY: input.xrAxes?.moveY ?? 0,
    turnX: input.xrAxes?.turnX ?? 0,
    turnY: input.xrAxes?.turnY ?? 0
  };
  return {
    ...baseContext,
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

function executeCommands(state: FlowState, commands: RuntimeCommand[]): void {
  state.commands.push(...commands);
  executeRuntimeCommands(commands, {
    requestSeatClaim: (seatId) => {
      state.pendingSeatId = seatId;
    },
    sendSeatClaim: (seatId) => {
      state.sentSeatClaims.push(seatId);
    },
    sendSeatRelease: (seatId) => {
      state.sentSeatReleases.push(seatId);
    },
    releaseLocalSeat: () => {
      state.currentSeatId = null;
      state.lastAppliedSeatLockId = null;
    },
    lockToSeat: (position, _reason, options) => {
      state.pose = {
        ...state.pose,
        position,
        yaw: options?.yaw ?? state.pose.yaw
      };
    },
    moveFlatTo: (position) => {
      state.pose = {
        ...state.pose,
        position: {
          ...state.pose.position,
          x: position.x,
          z: position.z
        }
      };
    },
    applySnapTurnYaw: (yaw) => {
      state.pose = { ...state.pose, yaw };
    },
    setXrInputProfile: (profile) => {
      state.xrInputProfile = profile;
    },
    setDebugXrAxes: (axes) => {
      state.debugXrAxes = axes;
    },
    setXrRayVisibleLatched: (visible) => {
      state.xrRayVisibleLatched = visible;
    },
    setXrTurnCooldown: (seconds) => {
      state.xrTurnCooldown = seconds;
    },
    setXrTurnArmed: (armed) => {
      state.xrTurnArmed = armed;
    },
    setXrSelectPressedLastFrame: (pressed) => {
      state.xrSelectPressedLastFrame = pressed;
    },
    clearXrAvatarDebug: () => {
      state.xrAvatarDebugCleared = true;
    },
    setDebugLocomotionMode: (mode) => {
      state.debugLocomotionMode = mode;
    },
    setLastAppliedSeatLockId: (seatId) => {
      state.lastAppliedSeatLockId = seatId;
    },
    setAvatarMovement: (move, turnRate) => {
      state.lastAvatarMove = move;
      state.lastAvatarTurnRate = turnRate;
    },
    updateLocalPositionDebug: () => {
      state.localPositionDebugUpdates += 1;
    },
    teleportToFloor: (point) => {
      state.pose = { ...state.pose, position: { x: point.x, y: point.y, z: point.z } };
    },
    setStatus: (message) => {
      state.statuses.push(message);
    },
    markTelemetry: (kind) => {
      state.telemetry.push(kind);
    }
  });
}

function runFrame(state: FlowState, input: {
  frameContext: RuntimeFrameContext;
  target?: RuntimeCommandInteractionTarget;
  deltaSeconds?: number;
  floorY?: number;
  seatRootPosition?: Vector3Like | null;
  seatYaw?: number;
  cameraForward?: FlatVector;
  nowMs?: number;
}): FrameLocomotionPipelineResult {
  const deltaSeconds = input.deltaSeconds ?? input.frameContext.deltaSeconds;
  const floorY = input.floorY ?? 0;
  const executeFrameCommands = (commands: FrameLocomotionCommand[]) => {
    executeFrameLocomotionCommands(commands, {
      executeRuntimeCommands: (runtimeCommands) => executeCommands(state, runtimeCommands),
      confirmInteractionTarget() {
        if (!input.target) {
          return;
        }
        const interactionPlan = planInteractionCommands({
          target: input.target,
          mode: resolveLocomotionMode({ seatId: state.currentSeatId, floorY }),
          pendingSeatId: state.pendingSeatId,
          seatingAvailable: true,
          nowMs: input.nowMs ?? input.frameContext.nowMs,
          lastInteractionConfirmAtMs: state.lastInteractionConfirmAtMs,
          debounceMs: 0
        });
        state.lastInteractionConfirmAtMs = interactionPlan.lastInteractionConfirmAtMs;
        executeCommands(state, interactionPlan.commands);
      }
    });
  };

  return executeFrameLocomotionPipeline({
    frameContext: input.frameContext,
    deltaSeconds,
    floorY,
    turnCooldownSeconds: state.xrTurnCooldown,
    turnArmed: state.xrTurnArmed
  }, {
    getYaw: () => state.pose.yaw,
    getPose: () => state.pose,
    getCurrentSeatId: () => state.currentSeatId,
    getSeatRootPosition: () => input.seatRootPosition ?? null,
    getSeatYaw: () => input.seatYaw,
    getLastAppliedSeatLockId: () => state.lastAppliedSeatLockId,
    getCameraForward: () => input.cameraForward ?? { x: 0, z: -1 },
    getDesktopFastMove: () => false,
    getBotMove: () => null,
    executeCommands: executeFrameCommands
  });
}

test("frame locomotion flow moves a standing desktop user from sampled frame intents", () => {
  const state = createState();

  runFrame(state, {
    frameContext: frameContext({ move: { x: 0, z: -1 } }),
    deltaSeconds: 1,
    cameraForward: { x: 1, z: 0 }
  });

  assert.equal(state.pose.position.x, 3.2);
  assert.equal(state.pose.position.z, 0);
  assert.equal(state.debugLocomotionMode, "desktop");
  assert.deepEqual(state.lastAvatarMove, { x: 0, z: -1 });
  assert.equal(state.localPositionDebugUpdates, 1);
  assert.deepEqual(state.commands.map((command) => command.type), [
    "set_xr_select_pressed_last_frame",
    "set_xr_ray_visible_latched",
    "set_xr_turn_armed",
    "set_xr_input_profile",
    "clear_xr_avatar_debug",
    "set_debug_xr_axes",
    "set_debug_locomotion_mode",
    "move_flat_to",
    "set_avatar_movement",
    "update_local_position_debug"
  ]);
});

test("frame locomotion flow keeps a seated user locked to the seat anchor", () => {
  const state = createState({ currentSeatId: "seat-a" });

  runFrame(state, {
    frameContext: frameContext({ source: "xr", move: { x: 1, z: -1 } }),
    deltaSeconds: 1,
    seatRootPosition: { x: 5, y: 0.45, z: -2 },
    seatYaw: Math.PI / 2
  });

  assert.deepEqual(state.pose.position, { x: 5, y: 0.45, z: -2 });
  assert.equal(state.pose.yaw, Math.PI / 2);
  assert.equal(state.lastAppliedSeatLockId, "seat-a");
  assert.equal(state.debugLocomotionMode, "vr-seated");
  assert.deepEqual(state.lastAvatarMove, { x: 0, z: 0 });
  assert.equal(state.localPositionDebugUpdates, 1);
  assert.deepEqual(state.commands.map((command) => command.type), [
    "set_xr_input_profile",
    "set_debug_xr_axes",
    "set_xr_ray_visible_latched",
    "set_xr_turn_cooldown",
    "set_xr_turn_armed",
    "set_debug_locomotion_mode",
    "set_xr_select_pressed_last_frame",
    "lock_to_seat",
    "set_last_applied_seat_lock_id",
    "set_avatar_movement",
    "update_local_position_debug"
  ]);
});

test("frame locomotion flow applies XR snap-turn before movement planning", () => {
  const state = createState();

  runFrame(state, {
    frameContext: frameContext({
      source: "xr",
      snapTurnAxis: -0.8,
      xrAxes: { turnX: -0.8 }
    })
  });

  assert.equal(Number(state.pose.yaw.toFixed(3)), Number((Math.PI / 6).toFixed(3)));
  assert.equal(state.xrTurnCooldown, 0.28);
  assert.equal(state.xrTurnArmed, false);
  assert.deepEqual(state.telemetry, ["snap_turn"]);
  assert.deepEqual(state.commands.map((command) => command.type), [
    "set_xr_input_profile",
    "set_debug_xr_axes",
    "set_xr_ray_visible_latched",
    "set_xr_turn_cooldown",
    "set_xr_turn_armed",
    "apply_snap_turn_yaw",
    "telemetry",
    "set_debug_locomotion_mode",
    "set_xr_select_pressed_last_frame",
    "set_avatar_movement",
    "update_local_position_debug"
  ]);
});

test("frame locomotion flow suppresses snap-turn while the XR ray intent owns diagonal stick input", () => {
  const state = createState();

  runFrame(state, {
    frameContext: frameContext({
      source: "xr",
      aimRay: true,
      snapTurnAxis: 0,
      xrAxes: { turnX: -0.8, turnY: -0.6 },
      rayVisibleLatched: true
    })
  });

  assert.equal(state.pose.yaw, 0);
  assert.equal(state.xrTurnArmed, false);
  assert.deepEqual(state.telemetry, []);
  assert.deepEqual(state.commands.map((command) => command.type), [
    "set_xr_input_profile",
    "set_debug_xr_axes",
    "set_xr_ray_visible_latched",
    "set_xr_turn_cooldown",
    "set_xr_turn_armed",
    "set_debug_locomotion_mode",
    "set_xr_select_pressed_last_frame",
    "set_avatar_movement",
    "update_local_position_debug"
  ]);
});

test("frame locomotion flow releases a seated user before floor teleport", () => {
  const state = createState({ currentSeatId: "seat-a", lastAppliedSeatLockId: "seat-a" });

  runFrame(state, {
    frameContext: frameContext({ source: "xr", confirmInteraction: true, triggerPressed: true }),
    target: { kind: "floor", point: { x: 2, y: 0, z: -3 } }
  });

  assert.deepEqual(state.commands.map((command) => command.type), [
    "set_xr_input_profile",
    "set_debug_xr_axes",
    "set_xr_ray_visible_latched",
    "set_xr_turn_cooldown",
    "set_xr_turn_armed",
    "set_debug_locomotion_mode",
    "telemetry",
    "telemetry",
    "send_seat_release",
    "release_local_seat",
    "teleport_to_floor",
    "status",
    "set_xr_select_pressed_last_frame",
    "set_avatar_movement",
    "update_local_position_debug"
  ]);
  assert.deepEqual(state.sentSeatReleases, ["seat-a"]);
  assert.deepEqual(state.telemetry, ["trigger_press", "seat_release"]);
  assert.equal(state.currentSeatId, null);
  assert.deepEqual(state.pose.position, { x: 2, y: 0, z: -3 });
});

test("frame locomotion movement stage reads post-confirm seat release state", () => {
  const state = createState({ currentSeatId: "seat-a", lastAppliedSeatLockId: "seat-a" });

  const result = runFrame(state, {
    frameContext: frameContext({ source: "xr", confirmInteraction: true, triggerPressed: true }),
    target: { kind: "floor", point: { x: 2, y: 0, z: -3 } },
    seatRootPosition: { x: 5, y: 0.45, z: -2 },
    seatYaw: Math.PI / 2
  });

  assert.equal(result.movementPlan.kind, "standing");
  if (result.movementPlan.kind !== "standing") {
    throw new Error("expected movement stage to observe released seat state");
  }
  assert.deepEqual(result.movementPlan.commands, []);
  assert.equal(state.currentSeatId, null);
  assert.equal(state.lastAppliedSeatLockId, null);
  assert.deepEqual(state.pose.position, { x: 2, y: 0, z: -3 });
  assert.equal(state.commands.some((command) => command.type === "lock_to_seat"), false);
});

test("frame locomotion flow claims a targeted seat without local teleport", () => {
  const state = createState();

  runFrame(state, {
    frameContext: frameContext({ source: "xr", confirmInteraction: true, triggerPressed: true }),
    target: { kind: "seat", seatId: "seat-a", label: "Front", point: { x: 5, y: 0.45, z: -2 } }
  });

  assert.deepEqual(state.commands.map((command) => command.type), [
    "set_xr_input_profile",
    "set_debug_xr_axes",
    "set_xr_ray_visible_latched",
    "set_xr_turn_cooldown",
    "set_xr_turn_armed",
    "set_debug_locomotion_mode",
    "telemetry",
    "request_seat_claim",
    "telemetry",
    "send_seat_claim",
    "status",
    "set_xr_select_pressed_last_frame",
    "set_avatar_movement",
    "update_local_position_debug"
  ]);
  assert.equal(state.pendingSeatId, "seat-a");
  assert.deepEqual(state.sentSeatClaims, ["seat-a"]);
  assert.deepEqual(state.telemetry, ["trigger_press", "seat_claim"]);
  assert.deepEqual(state.pose.position, { x: 0, y: 0, z: 0 });
});
