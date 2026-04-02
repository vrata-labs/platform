import type { AvatarLocomotionState } from "./avatar-locomotion.js";

export interface AvatarAnimationSelection {
  clip: string;
  fallback: boolean;
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
