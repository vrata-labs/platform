import type { SceneBundleSeatAnchor } from "../scene-bundle.js";
import type { Vector3Like } from "./local-pose.js";

export const NON_XR_CAMERA_HEIGHT = 1.6;
export const SEATED_EYE_ABOVE_CUSHION = 0.72;

// The desktop rig origin is the virtual feet origin, not the cushion. Keep its
// standing camera/avatar offsets and lower the entire rig to the seated eye.
// XR continues to use its tracked headset and the established seat-root mapping.
export function resolveLocalSeatRootPosition(anchor: SceneBundleSeatAnchor, xrPresenting: boolean): Vector3Like {
  return {
    x: anchor.position.x,
    y: anchor.position.y + anchor.seatHeight + (xrPresenting ? 0 : (anchor.eyeHeight ?? SEATED_EYE_ABOVE_CUSHION) - NON_XR_CAMERA_HEIGHT),
    z: anchor.position.z
  };
}

/** At seat entry only: align the current tracked eye with the authored eye.
 * Subsequent tracking is free, including translations/rotations of the head. */
export function alignTrackedSeatEye(anchor: SceneBundleSeatAnchor, viewer: { position: Vector3Like; yaw: number }) {
  const yaw = anchor.yaw - viewer.yaw;
  const { x, y, z } = viewer.position;
  return { yaw, position: {
    x: anchor.position.x - (x * Math.cos(yaw) + z * Math.sin(yaw)),
    y: anchor.position.y + anchor.seatHeight + (anchor.eyeHeight ?? SEATED_EYE_ABOVE_CUSHION) - y,
    z: anchor.position.z - (-x * Math.sin(yaw) + z * Math.cos(yaw))
  } };
}
