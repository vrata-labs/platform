export interface XrAxesSnapshot {
  moveX: number;
  moveY: number;
  turnX: number;
}

export type XrControllerInputProfile = "dual" | "left-only" | "right-only" | "none";

export function resolveAvatarXrInput(inputSources: Array<{ handedness?: string; gamepad?: { axes?: readonly number[] | null } | null }>): {
  axes: XrAxesSnapshot;
  profile: XrControllerInputProfile;
} {
  let moveX = 0;
  let moveY = 0;
  let turnX = 0;
  let hasLeft = false;
  let hasRight = false;

  for (const input of inputSources) {
    const axes = input.gamepad?.axes ?? [];
    if (input.handedness === "left") {
      moveX = axes[2] ?? axes[0] ?? moveX;
      moveY = axes[3] ?? axes[1] ?? moveY;
      hasLeft = true;
      continue;
    }
    if (input.handedness === "right") {
      turnX = axes[2] ?? axes[0] ?? turnX;
      hasRight = true;
      continue;
    }
    if (!hasLeft && axes.length >= 2) {
      moveX = axes[2] ?? axes[0] ?? moveX;
      moveY = axes[3] ?? axes[1] ?? moveY;
      hasLeft = true;
      continue;
    }
    if (!hasRight && axes.length >= 2) {
      turnX = axes[2] ?? axes[0] ?? turnX;
      hasRight = true;
    }
  }

  return {
    axes: { moveX, moveY, turnX },
    profile: hasLeft && hasRight ? "dual" : hasLeft ? "left-only" : hasRight ? "right-only" : "none"
  };
}
