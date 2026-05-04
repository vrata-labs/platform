import { computeKeyboardDirection, resolveXrSnapTurnAxis, sanitizeXrAxes, type FlatVector, type XrAxesSample } from "../movement.js";

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

export interface DesktopTouchInputSample {
  keys: Record<string, boolean>;
  touchActive: boolean;
  touchVector: FlatVector;
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

function clampInputAxis(value: number): number {
  return Math.max(-1, Math.min(1, value));
}

export function resolveTouchMoveVector(input: {
  clientX: number;
  clientY: number;
  viewportWidth: number;
  viewportHeight: number;
}): FlatVector {
  if (input.viewportWidth <= 0 || input.viewportHeight <= 0) {
    return { x: 0, z: 0 };
  }
  return {
    x: clampInputAxis((input.clientX / input.viewportWidth) * 2 - 1),
    z: clampInputAxis((input.clientY / input.viewportHeight) * 2 - 1)
  };
}

export function resolveDesktopTouchInputIntents(input: DesktopTouchInputSample): InputIntents {
  const keyboardMove = computeKeyboardDirection(input.keys);
  const touchMove = input.touchActive ? input.touchVector : { x: 0, z: 0 };
  return {
    move: {
      x: keyboardMove.x + touchMove.x,
      z: keyboardMove.z + touchMove.z
    },
    snapTurn: { axis: 0 },
    aimRay: false,
    confirmInteraction: false,
    source: input.touchActive ? "touch" : "desktop"
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
