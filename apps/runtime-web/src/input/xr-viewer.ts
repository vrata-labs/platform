import { Quaternion, Vector3, type Object3D } from "three";

export interface XrViewerPose {
  position: Vector3;
  orientation: Quaternion;
}

type TrackedViewer = { position: Pick<Vector3, "x" | "y" | "z">; orientation: Pick<Quaternion, "x" | "y" | "z" | "w"> };

/** Project this frame's tracking-space pose through the post-locomotion player rig. */
export function resolveXrViewerPose(
  rig: Object3D,
  tracked: TrackedViewer | null | undefined,
  syntheticCamera?: Object3D
): XrViewerPose | null {
  const position = new Vector3();
  const orientation = new Quaternion();
  if (tracked) {
    position.copy(tracked.position);
    orientation.copy(tracked.orientation);
    return {
      position: rig.localToWorld(position),
      orientation: orientation.premultiply(rig.getWorldQuaternion(new Quaternion())).normalize()
    };
  }
  if (!syntheticCamera) return null;
  return {
    position: syntheticCamera.getWorldPosition(position),
    orientation: syntheticCamera.getWorldQuaternion(orientation)
  };
}
