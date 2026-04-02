import type { AvatarInputMode } from "./avatar-types.js";

export type AvatarSelfVisibility = "full-body" | "hands-only" | "hidden";

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

  return "full-body";
}
