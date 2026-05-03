import { resolveXrSnapTurnAxis, sanitizeXrAxes, type XrAxesSample } from "../movement.js";

export interface InputIntents {
  move: { x: number; z: number };
  snapTurn: { axis: number };
  aimRay: boolean;
  confirmInteraction: boolean;
  source: "desktop" | "xr" | "touch";
}

export interface ResolvedXrInputIntents {
  intents: InputIntents;
  sanitizedAxes: XrAxesSample;
  rayVisibleLatched: boolean;
}

export function isXrRayVisibleFromStick(turnY: number, latched: boolean): boolean {
  if (latched) {
    return turnY <= -0.45;
  }
  return turnY <= -0.75;
}

export function createIdleInputIntents(source: InputIntents["source"]): InputIntents {
  return {
    move: { x: 0, z: 0 },
    snapTurn: { axis: 0 },
    aimRay: false,
    confirmInteraction: false,
    source
  };
}

export function resolveXrInputIntents(input: {
  axes: XrAxesSample;
  triggerPressed: boolean;
  rayVisibleLatched: boolean;
}): ResolvedXrInputIntents {
  const sanitizedAxes = sanitizeXrAxes(input.axes);
  const aimRay = isXrRayVisibleFromStick(sanitizedAxes.turnY, input.rayVisibleLatched);
  return {
    sanitizedAxes,
    rayVisibleLatched: aimRay,
    intents: {
      move: {
        x: sanitizedAxes.moveX,
        z: sanitizedAxes.moveY
      },
      snapTurn: {
        axis: resolveXrSnapTurnAxis(sanitizedAxes.turnX, sanitizedAxes.turnY)
      },
      aimRay,
      confirmInteraction: input.triggerPressed,
      source: "xr"
    }
  };
}
