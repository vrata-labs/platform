import type { AvatarInputMode } from "./avatar-types.js";

export type AvatarSelfVisibility = "full-body" | "upper-body" | "hands-only" | "hidden";
export interface AvatarPoseProfile {
  headHeight: number;
  handHeight: number;
  handForward: number;
  handSpread: number;
}

export interface AvatarViewProfile {
  visibility: AvatarSelfVisibility;
  poseProfile: AvatarPoseProfile;
}

const DESKTOP_PROFILE: AvatarPoseProfile = {
  headHeight: 1.58,
  handHeight: 1.16,
  handForward: -0.08,
  handSpread: 0.28
};

const MOBILE_PROFILE: AvatarPoseProfile = {
  headHeight: 1.5,
  handHeight: 1.02,
  handForward: 0.04,
  handSpread: 0.22
};

const VR_PROFILE: AvatarPoseProfile = {
  headHeight: 1.6,
  handHeight: 1.18,
  handForward: 0.12,
  handSpread: 0.3
};

export function resolveSelfAvatarVisibility(input: {
  inputMode: AvatarInputMode;
  xrPresenting: boolean;
  fallbackActive?: boolean;
}): AvatarSelfVisibility {
  if (input.fallbackActive) {
    return "hidden";
  }

  if (input.xrPresenting || input.inputMode === "vr-controller" || input.inputMode === "vr-hand") {
    return "hands-only";
  }

  if (input.inputMode === "mobile") {
    return "upper-body";
  }

  return "full-body";
}

export function resolveAvatarViewProfile(input: {
  inputMode: AvatarInputMode;
  xrPresenting: boolean;
  fallbackActive?: boolean;
}): AvatarViewProfile {
  const visibility = resolveSelfAvatarVisibility(input);
  if (visibility === "hands-only") {
    return { visibility, poseProfile: VR_PROFILE };
  }
  if (visibility === "upper-body") {
    return { visibility, poseProfile: MOBILE_PROFILE };
  }
  return {
    visibility,
    poseProfile: input.inputMode === "mobile" ? MOBILE_PROFILE : DESKTOP_PROFILE
  };
}
