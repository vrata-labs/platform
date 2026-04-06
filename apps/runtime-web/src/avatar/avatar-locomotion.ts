import type { AvatarQualityProfile } from "./avatar-types.js";

export type AvatarLocomotionState = "idle" | "walk" | "strafe" | "backpedal" | "turn";
export type AvatarQualityMode = "near" | "far";

export interface AvatarLocomotionSnapshot {
  state: AvatarLocomotionState;
  previousState: AvatarLocomotionState | null;
  speed: number;
  turnRate: number;
  transitioned: boolean;
}

export interface AvatarFootingCorrection {
  skatingMetric: number;
  correctionActive: boolean;
  footLockStrength: number;
  lowerBodyBobScale: number;
}

export interface AvatarFootPlantingResult {
  qualityMode: AvatarQualityMode;
  plantingActive: boolean;
  plantedFoot: "left" | "right" | "both" | "none";
  stanceOffsetX: number;
  stanceOffsetZ: number;
  lowerBodyYaw: number;
}

const MOVE_THRESHOLD = 0.12;
const MOVE_EXIT_THRESHOLD = 0.08;
const TURN_THRESHOLD = 0.8;
const TURN_EXIT_THRESHOLD = 0.55;
const STRAFE_DOMINANCE_ENTER = 1.2;
const STRAFE_DOMINANCE_EXIT = 0.9;

export function mapAvatarLocomotionStateToMode(state: AvatarLocomotionState): number {
  switch (state) {
    case "walk":
      return 1;
    case "strafe":
      return 2;
    case "backpedal":
      return 3;
    case "turn":
      return 4;
    case "idle":
    default:
      return 0;
  }
}

export function mapAvatarLocomotionModeToState(mode: number): AvatarLocomotionState {
  switch (mode) {
    case 1:
      return "walk";
    case 2:
      return "strafe";
    case 3:
      return "backpedal";
    case 4:
      return "turn";
    case 0:
    default:
      return "idle";
  }
}

export function resolveAvatarLocomotion(input: {
  moveX: number;
  moveZ: number;
  turnRate: number;
  previousState?: AvatarLocomotionState | null;
}): AvatarLocomotionSnapshot {
  const speed = Math.hypot(input.moveX, input.moveZ);
  const absTurnRate = Math.abs(input.turnRate);
  const previousState = input.previousState ?? null;
  const moveThreshold = previousState === "idle" || previousState === "turn" || previousState === null
    ? MOVE_THRESHOLD
    : MOVE_EXIT_THRESHOLD;
  const turnThreshold = previousState === "turn" ? TURN_EXIT_THRESHOLD : TURN_THRESHOLD;

  let state: AvatarLocomotionState;

  if (speed < moveThreshold) {
    state = absTurnRate >= turnThreshold ? "turn" : "idle";
  } else {
    const absMoveX = Math.abs(input.moveX);
    const absMoveZ = Math.abs(input.moveZ);
    const strafeDominance = absMoveZ > 0.001 ? absMoveX / absMoveZ : Number.POSITIVE_INFINITY;
    const strafeThreshold = previousState === "strafe" ? STRAFE_DOMINANCE_EXIT : STRAFE_DOMINANCE_ENTER;
    if (strafeDominance >= strafeThreshold) {
      state = "strafe";
    } else if (input.moveZ < 0) {
      state = "backpedal";
    } else {
      state = "walk";
    }
  }

  return {
    state,
    previousState,
    speed,
    turnRate: input.turnRate,
    transitioned: previousState !== null && previousState !== state
  };
}

export function resolveAvatarFootingCorrection(input: {
  locomotionState: AvatarLocomotionState;
  speed: number;
  turnRate: number;
  transitioned?: boolean;
}): AvatarFootingCorrection {
  const normalizedSpeed = Math.min(Math.max(input.speed, 0), 1.5) / 1.5;
  const turnInfluence = Math.min(Math.abs(input.turnRate), 1.5) / 1.5;
  const expectedMotion = input.locomotionState === "idle" || input.locomotionState === "turn"
    ? 0
    : input.locomotionState === "backpedal"
      ? 0.42
      : input.locomotionState === "strafe"
        ? 0.5
        : 0.58;
  const slipRisk = Math.max(0, expectedMotion - normalizedSpeed);
  const transitionPenalty = input.transitioned ? 0.18 : 0;
  const turnPenalty = input.locomotionState === "turn" ? Math.max(0, 0.2 - turnInfluence * 0.2) : 0;
  const skatingMetric = Math.min(1, slipRisk + transitionPenalty + turnPenalty);
  const correctionActive = skatingMetric >= 0.18;
  const footLockStrength = correctionActive ? Math.min(1, skatingMetric * 1.4) : 0;

  return {
    skatingMetric,
    correctionActive,
    footLockStrength,
    lowerBodyBobScale: correctionActive ? Math.max(0.45, 1 - footLockStrength * 0.55) : 1
  };
}

export function resolveAvatarQualityMode(input: {
  distanceToObserver: number;
  qualityProfile?: AvatarQualityProfile;
}): AvatarQualityMode {
  const nearDistance = input.qualityProfile === "mobile-lite"
    ? 3.5
    : input.qualityProfile === "xr"
      ? 5.5
      : 4.5;
  return input.distanceToObserver <= nearDistance ? "near" : "far";
}

export function resolveAvatarFootPlanting(input: {
  locomotionState: AvatarLocomotionState;
  elapsedSeconds: number;
  speed: number;
  footLockStrength: number;
  qualityMode: AvatarQualityMode;
}): AvatarFootPlantingResult {
  if (input.qualityMode === "far" || input.locomotionState === "idle" || input.locomotionState === "turn") {
    return {
      qualityMode: input.qualityMode,
      plantingActive: false,
      plantedFoot: input.locomotionState === "idle" ? "both" : "none",
      stanceOffsetX: 0,
      stanceOffsetZ: 0,
      lowerBodyYaw: 0
    };
  }

  const cycle = input.elapsedSeconds * (2 + Math.min(input.speed, 1.5) * 1.8);
  const phase = Math.sin(cycle);
  const plantedFoot = phase >= 0 ? "left" : "right";
  const plantStrength = Math.max(0.18, 1 - input.footLockStrength * 0.55);
  const lateralSign = plantedFoot === "left" ? -1 : 1;
  const stanceBase = input.locomotionState === "strafe" ? 0.045 : 0.032;
  const depthBase = input.locomotionState === "backpedal" ? -0.016 : 0.02;
  const lowerBodyYaw = input.locomotionState === "strafe" ? 0 : lateralSign * 0.035 * plantStrength;

  return {
    qualityMode: input.qualityMode,
    plantingActive: true,
    plantedFoot,
    stanceOffsetX: lateralSign * stanceBase * plantStrength,
    stanceOffsetZ: depthBase * plantStrength,
    lowerBodyYaw
  };
}
