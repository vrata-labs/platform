export type AvatarLocomotionState = "idle" | "walk" | "strafe" | "backpedal" | "turn";

export interface AvatarLocomotionSnapshot {
  state: AvatarLocomotionState;
  speed: number;
  turnRate: number;
}

const MOVE_THRESHOLD = 0.12;
const TURN_THRESHOLD = 0.8;

export function resolveAvatarLocomotion(input: {
  moveX: number;
  moveZ: number;
  turnRate: number;
}): AvatarLocomotionSnapshot {
  const speed = Math.hypot(input.moveX, input.moveZ);
  const absTurnRate = Math.abs(input.turnRate);

  if (speed < MOVE_THRESHOLD) {
    if (absTurnRate >= TURN_THRESHOLD) {
      return { state: "turn", speed, turnRate: input.turnRate };
    }
    return { state: "idle", speed, turnRate: input.turnRate };
  }

  if (Math.abs(input.moveX) > Math.abs(input.moveZ)) {
    return { state: "strafe", speed, turnRate: input.turnRate };
  }

  if (input.moveZ < 0) {
    return { state: "backpedal", speed, turnRate: input.turnRate };
  }

  return { state: "walk", speed, turnRate: input.turnRate };
}
