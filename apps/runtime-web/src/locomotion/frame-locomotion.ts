import type { RuntimeFrameContext } from "../input/runtime-frame-context.js";
import type { LocalPose, LocalPoseMutationReason, Vector3Like } from "../local/local-pose.js";
import { applySnapTurn, projectMovementToWorld, type FlatVector, type XrAxesSample } from "../movement.js";
import { resolveLocomotionMode, stepLocalLocomotion } from "./local-locomotion.js";
import type { RuntimeCommand } from "./runtime-commands.js";

export type FrameXrControlPlan =
  | {
    kind: "xr";
    inputProfile: string;
    sanitizedAxes: XrAxesSample;
    clearAvatarDebug: false;
    rayVisibleLatched: boolean;
    turnCooldownSeconds: number;
    turnArmed: boolean;
    nextYaw: number | null;
    confirmInteraction: boolean;
    triggerPressedLastFrame: boolean;
  }
  | {
    kind: "non_xr";
    inputProfile: null;
    sanitizedAxes: XrAxesSample;
    clearAvatarDebug: true;
    rayVisibleLatched: false;
    turnArmed: true;
    confirmInteraction: false;
    triggerPressedLastFrame: false;
  };

export interface FrameXrControlInput {
  frameContext: RuntimeFrameContext;
  yaw: number;
  turnCooldownSeconds: number;
  turnArmed: boolean;
  deltaSeconds: number;
}

export type FrameLocomotionMovementPlan =
  | {
    kind: "seat_lock";
    seatId: string;
    position: Vector3Like;
    reason: Extract<LocalPoseMutationReason, "seat_enter" | "seat_lock">;
    yaw?: number;
    commands: RuntimeCommand[];
    avatarMove: FlatVector;
    avatarTurnRate: number;
  }
  | {
    kind: "standing";
    pose: LocalPose;
    movementReason: Extract<LocalPoseMutationReason, "desktop_move" | "xr_move"> | null;
    debugLocomotionMode: "desktop" | "mobile-touch" | null;
    commands: RuntimeCommand[];
    avatarMove: FlatVector;
    avatarTurnRate: number;
  };

export interface FrameLocomotionMovementInput {
  pose: LocalPose;
  frameContext: Pick<RuntimeFrameContext, "source" | "intents">;
  deltaSeconds: number;
  floorY: number;
  currentSeatId: string | null;
  seatRootPosition?: Vector3Like | null;
  seatYaw?: number;
  lastAppliedSeatLockId: string | null;
  cameraForward: FlatVector;
  desktopFastMove: boolean;
  botMove?: FlatVector | null;
}

const ZERO_MOVE: FlatVector = { x: 0, z: 0 };

function createZeroXrAxes(): XrAxesSample {
  return { moveX: 0, moveY: 0, turnX: 0, turnY: 0 };
}

function hasMove(move: FlatVector): boolean {
  return move.x !== 0 || move.z !== 0;
}

function planStandingDebugLocomotionMode(input: FrameLocomotionMovementInput): "desktop" | "mobile-touch" | null {
  if (input.frameContext.source === "xr") {
    return null;
  }

  if (input.frameContext.source === "touch" && !input.botMove) {
    return "mobile-touch";
  }

  return "desktop";
}

export function planFrameXrControls(input: FrameXrControlInput): FrameXrControlPlan {
  if (input.frameContext.source !== "xr" || !input.frameContext.xr) {
    return {
      kind: "non_xr",
      inputProfile: null,
      sanitizedAxes: createZeroXrAxes(),
      clearAvatarDebug: true,
      rayVisibleLatched: false,
      turnArmed: true,
      confirmInteraction: false,
      triggerPressedLastFrame: false
    };
  }

  const sanitizedAxes = input.frameContext.xr.sanitizedAxes;
  const turn = applySnapTurn(
    { angle: input.yaw, cooldownSeconds: input.turnCooldownSeconds, armed: input.turnArmed },
    input.frameContext.intents.snapTurn.axis,
    input.deltaSeconds,
    sanitizedAxes.turnX
  );
  const nextYaw = turn.angle !== input.yaw ? turn.angle : null;
  return {
    kind: "xr",
    inputProfile: input.frameContext.xr.profile,
    sanitizedAxes,
    clearAvatarDebug: false,
    rayVisibleLatched: input.frameContext.xr.rayVisibleLatched,
    turnCooldownSeconds: turn.cooldownSeconds,
    turnArmed: turn.armed ?? true,
    nextYaw,
    confirmInteraction: input.frameContext.intents.confirmInteraction,
    triggerPressedLastFrame: input.frameContext.xr.triggerPressed
  };
}

export function planFrameLocomotionMovement(input: FrameLocomotionMovementInput): FrameLocomotionMovementPlan {
  const xrLocomotionActive = input.frameContext.source === "xr";
  const mode = resolveLocomotionMode({ seatId: input.currentSeatId, floorY: input.floorY });
  if (mode.kind === "seated" && input.seatRootPosition) {
    return {
      kind: "seat_lock",
      seatId: mode.seatId,
      position: input.seatRootPosition,
      reason: input.lastAppliedSeatLockId === mode.seatId ? "seat_lock" : "seat_enter",
      yaw: input.lastAppliedSeatLockId === mode.seatId ? undefined : input.seatYaw,
      commands: [],
      avatarMove: ZERO_MOVE,
      avatarTurnRate: 0
    };
  }

  const commands: RuntimeCommand[] = [];
  if (mode.kind === "seated") {
    commands.push({ type: "release_local_seat" });
  }

  const speed = xrLocomotionActive ? 2.4 : input.desktopFastMove ? 5 : 3.2;
  const avatarMove = !xrLocomotionActive && input.botMove ? input.botMove : {
    x: input.frameContext.intents.move.x,
    z: input.frameContext.intents.move.z
  };
  const debugLocomotionMode = planStandingDebugLocomotionMode(input);
  if (!hasMove(avatarMove)) {
    return {
      kind: "standing",
      pose: input.pose,
      movementReason: null,
      debugLocomotionMode,
      commands,
      avatarMove,
      avatarTurnRate: 0
    };
  }

  const locomotion = stepLocalLocomotion({
    pose: input.pose,
    mode: resolveLocomotionMode({ seatId: null, floorY: input.floorY }),
    intents: input.frameContext.intents,
    deltaSeconds: input.deltaSeconds,
    speed,
    worldMove: projectMovementToWorld(avatarMove, input.cameraForward)
  });

  return {
    kind: "standing",
    pose: locomotion.pose,
    movementReason: xrLocomotionActive ? "xr_move" : "desktop_move",
    debugLocomotionMode,
    commands,
    avatarMove,
    avatarTurnRate: 0
  };
}
