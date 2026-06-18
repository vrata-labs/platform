import type { InteractionTarget } from "../interaction/interaction-targets.js";
import { resolveLocomotionMode } from "./local-locomotion.js";
import {
  planInteractionCommands,
  type PlanInteractionCommandResult,
  type RuntimeCommand,
  type RuntimeCommandInteractionTarget
} from "./runtime-commands.js";

export interface PlanInteractionTargetCommandsInput {
  target: InteractionTarget;
  currentSeatId: string | null;
  pendingSeatId: string | null;
  floorY: number;
  seatingAvailable: boolean;
  nowMs: number;
  lastInteractionConfirmAtMs: number;
  debounceMs?: number;
}

export interface InteractionCommandPlannerInput {
  target: InteractionTarget;
  currentSeatId: string | null;
  pendingSeatId: string | null;
  floorY: number;
  seatingAvailable: boolean;
  nowMs: number;
  debounceMs?: number;
}

export interface InteractionCommandPlanner {
  plan(input: InteractionCommandPlannerInput): RuntimeCommand[];
  getLastInteractionConfirmAtMs(): number;
}

export function toRuntimeCommandInteractionTarget(target: InteractionTarget): RuntimeCommandInteractionTarget {
  if (target.kind === "seat") {
    return {
      kind: "seat",
      point: target.point,
      seatId: target.seatAnchor.id,
      label: target.seatAnchor.label
    };
  }
  if (target.kind === "floor") {
    return {
      kind: "floor",
      point: target.point
    };
  }
  return { kind: "none" };
}

export function planInteractionTargetCommands(input: PlanInteractionTargetCommandsInput): PlanInteractionCommandResult {
  return planInteractionCommands({
    target: toRuntimeCommandInteractionTarget(input.target),
    mode: resolveLocomotionMode({ seatId: input.currentSeatId, floorY: input.floorY }),
    pendingSeatId: input.pendingSeatId,
    seatingAvailable: input.seatingAvailable,
    nowMs: input.nowMs,
    lastInteractionConfirmAtMs: input.lastInteractionConfirmAtMs,
    debounceMs: input.debounceMs
  });
}

export function createInteractionCommandPlanner(input: { initialLastInteractionConfirmAtMs?: number } = {}): InteractionCommandPlanner {
  let lastInteractionConfirmAtMs = input.initialLastInteractionConfirmAtMs ?? 0;
  return {
    plan(planInput) {
      const planned = planInteractionTargetCommands({
        ...planInput,
        lastInteractionConfirmAtMs
      });
      lastInteractionConfirmAtMs = planned.lastInteractionConfirmAtMs;
      return planned.commands;
    },
    getLastInteractionConfirmAtMs() {
      return lastInteractionConfirmAtMs;
    }
  };
}
