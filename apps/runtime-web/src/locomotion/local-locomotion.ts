import { stepFlatMovement, type FlatVector } from "../movement.js";
import type { InputIntents } from "../input/input-intents.js";
import type { LocalPose, Vector3Like } from "../local/local-pose.js";
import type { RuntimeCommand } from "./runtime-commands.js";

export type { RuntimeCommand } from "./runtime-commands.js";

export type LocomotionMode =
  | { kind: "standing"; floorY: number }
  | { kind: "seated"; seatId: string; allowYaw: boolean };

export type LocomotionInteractionTarget =
  | { kind: "none" }
  | { kind: "floor"; point: Vector3Like }
  | { kind: "seat"; point: Vector3Like; seatId: string };

export interface LocalLocomotionStepInput {
  pose: LocalPose;
  mode: LocomotionMode;
  intents: InputIntents;
  deltaSeconds: number;
  speed: number;
  worldMove: FlatVector;
  seatRootPosition?: Vector3Like | null;
  nextYaw?: number;
  interactionTarget?: LocomotionInteractionTarget;
}

export interface LocalLocomotionStepResult {
  pose: LocalPose;
  mode: LocomotionMode;
  commands: RuntimeCommand[];
}

function clonePose(pose: LocalPose): LocalPose {
  return {
    position: { ...pose.position },
    yaw: pose.yaw,
    pitch: pose.pitch
  };
}

export function resolveLocomotionMode(input: { seatId: string | null; floorY: number; allowSeatedYaw?: boolean }): LocomotionMode {
  if (input.seatId) {
    return {
      kind: "seated",
      seatId: input.seatId,
      allowYaw: input.allowSeatedYaw ?? true
    };
  }
  return { kind: "standing", floorY: input.floorY };
}

export function stepLocalLocomotion(input: LocalLocomotionStepInput): LocalLocomotionStepResult {
  let pose = clonePose(input.pose);
  let mode = input.mode;
  const commands: RuntimeCommand[] = [];
  const target = input.interactionTarget ?? { kind: "none" as const };

  if (target.kind === "seat" && input.intents.confirmInteraction && mode.kind === "standing") {
    commands.push({ type: "send_seat_claim", seatId: target.seatId });
  }

  if (target.kind === "floor" && input.intents.confirmInteraction) {
    if (mode.kind === "seated") {
      commands.push({ type: "send_seat_release", seatId: mode.seatId });
    }
    mode = { kind: "standing", floorY: target.point.y };
    pose = {
      ...pose,
      position: { ...target.point }
    };
  }

  if (typeof input.nextYaw === "number" && (mode.kind === "standing" || mode.allowYaw)) {
    pose = {
      ...pose,
      yaw: input.nextYaw
    };
  }

  if (mode.kind === "seated") {
    if (input.seatRootPosition) {
      pose = {
        ...pose,
        position: { ...input.seatRootPosition }
      };
    }
    return { pose, mode, commands };
  }

  if (target.kind !== "floor" && (input.worldMove.x !== 0 || input.worldMove.z !== 0)) {
    const next = stepFlatMovement(
      { x: pose.position.x, z: pose.position.z },
      input.worldMove,
      input.speed,
      input.deltaSeconds
    );
    pose = {
      ...pose,
      position: {
        ...pose.position,
        x: next.x,
        z: next.z
      }
    };
  }

  return { pose, mode, commands };
}
