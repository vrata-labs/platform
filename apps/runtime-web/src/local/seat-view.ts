import * as THREE from "three";
import type { SceneBundleSeatAnchor } from "../scene-bundle.js";
import { alignTrackedSeatEye, NON_XR_CAMERA_HEIGHT, resolveLocalSeatRootPosition } from "./seat-pose.js";

/** Desktop look pivots at the seated eye. In XR the tracked eye (including
 * room-scale offset and heading) is aligned once, never pinned every frame. */
export function createSeatView(camera: THREE.Camera, pitch: THREE.Object3D) {
  let desktopPivot = false;
  let tracked: { seat: SceneBundleSeatAnchor; pose: ReturnType<typeof alignTrackedSeatEye> } | null = null;
  function pivot(enabled: boolean) {
    if (enabled === desktopPivot) return;
    desktopPivot = enabled;
    pitch.position.y = enabled ? NON_XR_CAMERA_HEIGHT : 0;
    camera.position.y = enabled ? 0 : NON_XR_CAMERA_HEIGHT;
  }
  return {
    reset() { pivot(false); tracked = null; },
    resolve(seat: SceneBundleSeatAnchor, xr: boolean, viewer: () => XRRigidTransform | undefined) {
      pivot(!xr && seat.eyeHeight !== undefined);
      if (xr && seat.eyeHeight !== undefined) {
        if (tracked?.seat !== seat) {
          const head = viewer();
          if (head) {
            const q = head.orientation;
            const yaw = new THREE.Euler().setFromQuaternion(new THREE.Quaternion(q.x, q.y, q.z, q.w), "YXZ").y;
            tracked = { seat, pose: alignTrackedSeatEye(seat, { position: head.position, yaw }) };
            return { ...tracked.pose, calibrated: true };
          }
        }
        if (tracked?.seat === seat) return { ...tracked.pose, calibrated: false };
      } else tracked = null;
      return { position: resolveLocalSeatRootPosition(seat, xr), yaw: seat.yaw, calibrated: false };
    }
  };
}
