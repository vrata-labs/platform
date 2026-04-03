export interface XrAxesSnapshot {
  moveX: number;
  moveY: number;
  turnX: number;
}

export type XrControllerInputProfile = "dual" | "left-only" | "right-only" | "none";

function pickPrimaryAxes(axes: readonly number[] | null | undefined): { x: number; y: number } {
  const primary = {
    x: axes?.[0] ?? 0,
    y: axes?.[1] ?? 0
  };
  const secondary = {
    x: axes?.[2] ?? 0,
    y: axes?.[3] ?? 0
  };
  const primaryMagnitude = Math.abs(primary.x) + Math.abs(primary.y);
  const secondaryMagnitude = Math.abs(secondary.x) + Math.abs(secondary.y);
  return secondaryMagnitude > primaryMagnitude ? secondary : primary;
}

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
    const axes = pickPrimaryAxes(input.gamepad?.axes);
    if (input.handedness === "left") {
      moveX = axes.x;
      moveY = axes.y;
      hasLeft = true;
      continue;
    }
    if (input.handedness === "right") {
      turnX = axes.x;
      hasRight = true;
      continue;
    }
    if (!hasLeft) {
      moveX = axes.x;
      moveY = axes.y;
      hasLeft = true;
      continue;
    }
    if (!hasRight) {
      turnX = axes.x;
      hasRight = true;
    }
  }

  return {
    axes: { moveX, moveY, turnX },
    profile: hasLeft && hasRight ? "dual" : hasLeft ? "left-only" : hasRight ? "right-only" : "none"
  };
}
