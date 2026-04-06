import type { AvatarLocomotionState } from "./avatar-locomotion.js";

export interface AvatarAnimationSelection {
  clip: string;
  fallback: boolean;
}

export interface AvatarAnimationPose {
  bodyBob: number;
  bodyRoll: number;
  headTilt: number;
  leftHandYOffset: number;
  rightHandYOffset: number;
  leftHandForward: number;
  rightHandForward: number;
  auraScale: number;
}

const CLIP_BY_STATE: Record<AvatarLocomotionState, string> = {
  idle: "idle",
  walk: "walk",
  strafe: "strafe",
  backpedal: "backpedal",
  turn: "turn"
};

export function selectAvatarAnimationClip(input: {
  locomotionState: AvatarLocomotionState;
  availableClips: string[];
}): AvatarAnimationSelection {
  const desiredClip = CLIP_BY_STATE[input.locomotionState];
  if (input.availableClips.includes(desiredClip)) {
    return {
      clip: desiredClip,
      fallback: false
    };
  }

  if (input.availableClips.includes("idle")) {
    return {
      clip: "idle",
      fallback: desiredClip !== "idle"
    };
  }

  return {
    clip: input.availableClips[0] ?? "procedural-idle",
    fallback: true
  };
}

export function computeAvatarAnimationPose(input: {
  clip: string;
  elapsedSeconds: number;
  speed: number;
  turnRate: number;
}): AvatarAnimationPose {
  const cycle = input.elapsedSeconds * (1.8 + Math.min(input.speed, 1.5) * 2.2);
  const sin = Math.sin(cycle);
  const cos = Math.cos(cycle);
  const turnInfluence = Math.max(-1, Math.min(1, input.turnRate));

  switch (input.clip) {
    case "walk":
      return {
        bodyBob: 0.045 * Math.abs(sin),
        bodyRoll: 0.05 * sin,
        headTilt: 0.03 * sin,
        leftHandYOffset: 0.08 * sin,
        rightHandYOffset: -0.08 * sin,
        leftHandForward: 0.12 * cos,
        rightHandForward: -0.12 * cos,
        auraScale: 1.06 + Math.abs(sin) * 0.08
      };
    case "strafe":
      return {
        bodyBob: 0.025 * Math.abs(sin),
        bodyRoll: 0,
        headTilt: 0,
        leftHandYOffset: -0.03 * sin,
        rightHandYOffset: 0.03 * sin,
        leftHandForward: 0.06,
        rightHandForward: 0.06,
        auraScale: 1.04 + Math.abs(sin) * 0.06
      };
    case "backpedal":
      return {
        bodyBob: 0.03 * Math.abs(cos),
        bodyRoll: -0.04 * sin,
        headTilt: -0.025 * sin,
        leftHandYOffset: 0.04 * sin,
        rightHandYOffset: -0.04 * sin,
        leftHandForward: -0.08,
        rightHandForward: -0.08,
        auraScale: 1.03 + Math.abs(cos) * 0.05
      };
    case "turn":
      return {
        bodyBob: 0.01,
        bodyRoll: 0.14 * turnInfluence,
        headTilt: 0.08 * turnInfluence,
        leftHandYOffset: 0.02 * sin,
        rightHandYOffset: -0.02 * sin,
        leftHandForward: 0.02 * turnInfluence,
        rightHandForward: -0.02 * turnInfluence,
        auraScale: 1.05 + Math.abs(turnInfluence) * 0.05
      };
    case "idle":
    default:
      return {
        bodyBob: 0.012 + 0.008 * Math.abs(sin),
        bodyRoll: 0.015 * sin,
        headTilt: 0.01 * sin,
        leftHandYOffset: 0.012 * sin,
        rightHandYOffset: -0.012 * sin,
        leftHandForward: 0,
        rightHandForward: 0,
        auraScale: 1.01 + Math.abs(sin) * 0.02
      };
  }
}
