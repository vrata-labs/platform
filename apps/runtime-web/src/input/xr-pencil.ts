import * as THREE from "three";

import type { AvatarHandPose } from "../avatar/avatar-xr-hands.js";

export interface XrPencilPose {
  sourceIndex: number;
  anchorWorld: THREE.Vector3;
  orientationWorld: THREE.Quaternion;
  tipWorld: THREE.Vector3;
}

export function resolveXrPencilPose(input: {
  handPose: AvatarHandPose | null;
  tipLocalZ: number;
}): XrPencilPose | null {
  if (!input.handPose) {
    return null;
  }
  const anchorWorld = new THREE.Vector3(
    input.handPose.position.x,
    input.handPose.position.y,
    input.handPose.position.z
  );
  const orientationWorld = new THREE.Quaternion(
    input.handPose.orientation.x,
    input.handPose.orientation.y,
    input.handPose.orientation.z,
    input.handPose.orientation.w
  ).normalize();
  const tipWorld = new THREE.Vector3(0, 0, input.tipLocalZ).applyQuaternion(orientationWorld).add(anchorWorld);
  return {
    sourceIndex: input.handPose.sourceIndex,
    anchorWorld,
    orientationWorld,
    tipWorld
  };
}
