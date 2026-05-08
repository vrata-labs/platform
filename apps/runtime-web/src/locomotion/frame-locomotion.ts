import type { RuntimeFrameContext } from "../input/runtime-frame-context.js";
import type { LocalPose, Vector3Like } from "../local/local-pose.js";
import type { FlatVector } from "../movement.js";
import {
  executeFrameLocomotionMovementPlan,
  planFrameLocomotionMovement,
  type FrameLocomotionMovementInput,
  type FrameLocomotionMovementPlan
} from "./frame-movement.js";
import {
  executeFrameXrControlPlan,
  planFrameXrControls,
  type FrameXrControlPlan
} from "./frame-xr-controls.js";
import type { RuntimeCommand } from "./runtime-commands.js";

export {
  executeFrameLocomotionMovementPlan,
  planFrameLocomotionMovement,
  planFrameLocomotionMovementCommands,
  type FrameLocomotionMovementInput,
  type FrameLocomotionMovementPlan,
  type FrameLocomotionMovementPlanHandlers
} from "./frame-movement.js";
export {
  executeFrameXrControlPlan,
  planFrameXrControlCommands,
  planFrameXrControls,
  type FrameXrControlInput,
  type FrameXrControlPlan,
  type FrameXrControlPlanHandlers
} from "./frame-xr-controls.js";

export type FrameLocomotionCommand = RuntimeCommand | { type: "confirm_interaction_target" };

export interface FrameLocomotionCommandHandlers {
  executeRuntimeCommands(commands: RuntimeCommand[]): void;
  confirmInteractionTarget(): void;
}

export interface FrameLocomotionPipelineInput {
  frameContext: RuntimeFrameContext;
  deltaSeconds: number;
  floorY: number;
  turnCooldownSeconds: number;
  turnArmed: boolean;
}

export interface FrameLocomotionReadModel {
  getYaw(): number;
  getPose(): LocalPose;
  getCurrentSeatId(): string | null;
  getSeatRootPosition(seatId: string): Vector3Like | null;
  getSeatYaw(seatId: string): number | undefined;
  getLastAppliedSeatLockId(): string | null;
  getCameraForward(): FlatVector;
  getDesktopFastMove(): boolean;
  getBotMove(): FlatVector | null;
}

export interface FrameLocomotionCommandSink {
  executeCommands(commands: FrameLocomotionCommand[]): void;
}

export type FrameLocomotionPipelineHandlers = FrameLocomotionReadModel & FrameLocomotionCommandSink;

export interface FrameLocomotionPipelineResult {
  xrControlPlan: FrameXrControlPlan;
  movementPlan: FrameLocomotionMovementPlan;
}

export function executeFrameLocomotionCommands(
  commands: FrameLocomotionCommand[],
  handlers: FrameLocomotionCommandHandlers
): void {
  const runtimeCommands: RuntimeCommand[] = [];
  const flushRuntimeCommands = () => {
    if (runtimeCommands.length > 0) {
      handlers.executeRuntimeCommands(runtimeCommands.splice(0));
    }
  };

  for (const command of commands) {
    if (command.type === "confirm_interaction_target") {
      flushRuntimeCommands();
      handlers.confirmInteractionTarget();
      continue;
    }
    runtimeCommands.push(command);
  }

  flushRuntimeCommands();
}

function executeFrameXrControlStage(
  input: FrameLocomotionPipelineInput,
  handlers: FrameLocomotionPipelineHandlers
): FrameXrControlPlan {
  const xrControlPlan = planFrameXrControls({
    frameContext: input.frameContext,
    yaw: handlers.getYaw(),
    currentSeatId: handlers.getCurrentSeatId(),
    turnCooldownSeconds: input.turnCooldownSeconds,
    turnArmed: input.turnArmed,
    deltaSeconds: input.deltaSeconds
  });

  executeFrameXrControlPlan(xrControlPlan, handlers);
  return xrControlPlan;
}

function buildFrameMovementInput(
  input: FrameLocomotionPipelineInput,
  readModel: FrameLocomotionReadModel
): FrameLocomotionMovementInput {
  const currentSeatId = readModel.getCurrentSeatId();
  return {
    pose: readModel.getPose(),
    frameContext: input.frameContext,
    deltaSeconds: input.deltaSeconds,
    floorY: input.floorY,
    currentSeatId,
    seatRootPosition: currentSeatId ? readModel.getSeatRootPosition(currentSeatId) : null,
    seatYaw: currentSeatId ? readModel.getSeatYaw(currentSeatId) : undefined,
    lastAppliedSeatLockId: readModel.getLastAppliedSeatLockId(),
    cameraForward: readModel.getCameraForward(),
    desktopFastMove: readModel.getDesktopFastMove(),
    botMove: readModel.getBotMove()
  };
}

function executeFrameMovementStage(
  input: FrameLocomotionPipelineInput,
  handlers: FrameLocomotionPipelineHandlers
): FrameLocomotionMovementPlan {
  const movementPlan = planFrameLocomotionMovement(buildFrameMovementInput(input, handlers));

  executeFrameLocomotionMovementPlan(movementPlan, handlers);
  return movementPlan;
}

export function executeFrameLocomotionPipeline(
  input: FrameLocomotionPipelineInput,
  handlers: FrameLocomotionPipelineHandlers
): FrameLocomotionPipelineResult {
  const xrControlPlan = executeFrameXrControlStage(input, handlers);
  const movementPlan = executeFrameMovementStage(input, handlers);

  return { xrControlPlan, movementPlan };
}
