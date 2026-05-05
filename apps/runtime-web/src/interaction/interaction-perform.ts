import type { RuntimeCommand } from "../locomotion/runtime-commands.js";
import type { InteractionCommandPlanner } from "../locomotion/interaction-command-planner.js";
import { resolveInteractionTargetForRay, type RuntimeInteractionTargetInput } from "./interaction-frame.js";
import { setInteractionRayDebugTarget, type InteractionRayDebugState, type InteractionRayMode } from "./interaction-ray-view.js";
import type { InteractionTarget } from "./interaction-targets.js";

export interface InteractionPerformContext {
  currentSeatId: string | null;
  pendingSeatId: string | null;
  floorY: number;
  seatingAvailable: boolean;
  nowMs: number;
}

export interface InteractionPerformOptions {
  debounceMs?: number;
  nowMs?: number;
}

export interface DirectInteractionRayPerformInput extends RuntimeInteractionTargetInput {
  state: InteractionRayDebugState;
  mode?: InteractionRayMode;
  clearVisuals(): void;
  options?: InteractionPerformOptions;
}

export interface InteractionTargetPerformer {
  performTarget(target: InteractionTarget, options?: InteractionPerformOptions): RuntimeCommand[];
  performDirectRayTarget(input: DirectInteractionRayPerformInput): InteractionTarget;
}

export function createInteractionTargetPerformer(input: {
  planner: InteractionCommandPlanner;
  executeCommands(commands: RuntimeCommand[]): void;
  getContext(): InteractionPerformContext;
}): InteractionTargetPerformer {
  function performTarget(target: InteractionTarget, options: InteractionPerformOptions = {}): RuntimeCommand[] {
    const context = input.getContext();
    const commands = input.planner.plan({
      target,
      currentSeatId: context.currentSeatId,
      pendingSeatId: context.pendingSeatId,
      floorY: context.floorY,
      seatingAvailable: context.seatingAvailable,
      nowMs: options.nowMs ?? context.nowMs,
      debounceMs: options.debounceMs
    });
    input.executeCommands(commands);
    return commands;
  }

  return {
    performTarget,
    performDirectRayTarget(directInput) {
      const target = resolveInteractionTargetForRay(directInput);
      if (target.kind === "none") {
        directInput.clearVisuals();
        return target;
      }

      setInteractionRayDebugTarget({
        state: directInput.state,
        target,
        mode: directInput.mode ?? "cursor"
      });
      performTarget(target, directInput.options);
      return target;
    }
  };
}
