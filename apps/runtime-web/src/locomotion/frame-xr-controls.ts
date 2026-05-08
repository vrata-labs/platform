import type { RuntimeFrameContext } from "../input/runtime-frame-context.js";
import { applySnapTurn, type XrAxesSample } from "../movement.js";
import type { FrameLocomotionCommand } from "./frame-locomotion.js";
import type { RuntimeCommand, RuntimeDebugLocomotionMode } from "./runtime-commands.js";

export type FrameXrControlPlan =
  | {
    kind: "xr";
    inputProfile: string;
    sanitizedAxes: XrAxesSample;
    clearAvatarDebug: false;
    debugLocomotionMode: Extract<RuntimeDebugLocomotionMode, "vr" | "vr-seated">;
    rayVisibleLatched: boolean;
    turnCooldownSeconds: number;
    turnArmed: boolean;
    nextYaw: number | null;
    snapTurnCommands: RuntimeCommand[];
    confirmInteraction: boolean;
    confirmInteractionCommands: FrameLocomotionCommand[];
    triggerPressedLastFrame: boolean;
  }
  | {
    kind: "non_xr";
    inputProfile: null;
    sanitizedAxes: XrAxesSample;
    clearAvatarDebug: true;
    debugLocomotionMode: null;
    rayVisibleLatched: false;
    turnArmed: true;
    confirmInteraction: false;
    snapTurnCommands: RuntimeCommand[];
    confirmInteractionCommands: FrameLocomotionCommand[];
    triggerPressedLastFrame: false;
  };

export interface FrameXrControlInput {
  frameContext: RuntimeFrameContext;
  yaw: number;
  currentSeatId: string | null;
  turnCooldownSeconds: number;
  turnArmed: boolean;
  deltaSeconds: number;
}

export interface FrameXrControlPlanHandlers {
  executeCommands(commands: FrameLocomotionCommand[]): void;
}

function createZeroXrAxes(): XrAxesSample {
  return { moveX: 0, moveY: 0, turnX: 0, turnY: 0 };
}

export function planFrameXrControls(input: FrameXrControlInput): FrameXrControlPlan {
  if (input.frameContext.source !== "xr" || !input.frameContext.xr) {
    return {
      kind: "non_xr",
      inputProfile: null,
      sanitizedAxes: createZeroXrAxes(),
      clearAvatarDebug: true,
      debugLocomotionMode: null,
      rayVisibleLatched: false,
      turnArmed: true,
      confirmInteraction: false,
      snapTurnCommands: [],
      confirmInteractionCommands: [],
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
  const snapTurnCommands: RuntimeCommand[] = nextYaw === null ? [] : [
    { type: "apply_snap_turn_yaw", yaw: nextYaw },
    { type: "telemetry", kind: "snap_turn" }
  ];
  const confirmInteraction = input.frameContext.intents.confirmInteraction;
  return {
    kind: "xr",
    inputProfile: input.frameContext.xr.profile,
    sanitizedAxes,
    clearAvatarDebug: false,
    debugLocomotionMode: input.currentSeatId ? "vr-seated" : "vr",
    rayVisibleLatched: input.frameContext.xr.rayVisibleLatched,
    turnCooldownSeconds: turn.cooldownSeconds,
    turnArmed: turn.armed ?? true,
    nextYaw,
    snapTurnCommands,
    confirmInteraction,
    confirmInteractionCommands: confirmInteraction
      ? [{ type: "telemetry", kind: "trigger_press" }, { type: "confirm_interaction_target" }]
      : [],
    triggerPressedLastFrame: input.frameContext.xr.triggerPressed
  };
}

export function executeFrameXrControlPlan(
  plan: FrameXrControlPlan,
  handlers: FrameXrControlPlanHandlers
): void {
  const commands = planFrameXrControlCommands(plan);
  if (commands.length > 0) {
    handlers.executeCommands(commands);
  }
}

export function planFrameXrControlCommands(plan: FrameXrControlPlan): FrameLocomotionCommand[] {
  if (plan.kind === "xr") {
    return [
      { type: "set_xr_input_profile", profile: plan.inputProfile },
      { type: "set_debug_xr_axes", axes: plan.sanitizedAxes },
      { type: "set_xr_ray_visible_latched", visible: plan.rayVisibleLatched },
      { type: "set_xr_turn_cooldown", seconds: plan.turnCooldownSeconds },
      { type: "set_xr_turn_armed", armed: plan.turnArmed },
      ...plan.snapTurnCommands,
      { type: "set_debug_locomotion_mode", mode: plan.debugLocomotionMode },
      ...plan.confirmInteractionCommands,
      { type: "set_xr_select_pressed_last_frame", pressed: plan.triggerPressedLastFrame }
    ];
  }

  return [
    { type: "set_xr_select_pressed_last_frame", pressed: plan.triggerPressedLastFrame },
    { type: "set_xr_ray_visible_latched", visible: plan.rayVisibleLatched },
    { type: "set_xr_turn_armed", armed: plan.turnArmed },
    { type: "set_xr_input_profile", profile: plan.inputProfile },
    ...(plan.clearAvatarDebug ? [{ type: "clear_xr_avatar_debug" } as const] : []),
    { type: "set_debug_xr_axes", axes: plan.sanitizedAxes }
  ];
}
