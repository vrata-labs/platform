import { test } from "node:test";
import assert from "node:assert/strict";
import { Object3D, Quaternion, Vector3 } from "three";
import { resolveXrViewerPose } from "./xr-viewer.js";

test("the tracked head uses the current frame and the player's translated and rotated rig", () => {
  const rig = new Object3D();
  rig.position.set(4, 3, 8);
  rig.rotation.y = Math.PI / 2;
  const oldCamera = new Object3D();
  rig.add(oldCamera);
  const pose = resolveXrViewerPose(rig, {
    position: { x: .35, y: 1.5, z: -.15 },
    orientation: new Quaternion().setFromAxisAngle(new Vector3(1, 0, 0), .2)
  }, oldCamera);
  assert(pose);
  assert(pose.position.distanceTo(new Vector3(3.85, 4.5, 7.65)) < 1e-9);
  assert(new Vector3(0, 0, -1).applyQuaternion(pose.orientation)
    .distanceTo(new Vector3(-Math.cos(.2), Math.sin(.2), 0)) < 1e-9);
  assert.deepEqual(oldCamera.position.toArray(), [0, 0, 0]);
  assert.equal(resolveXrViewerPose(rig, null), null);
  assert.deepEqual(resolveXrViewerPose(rig, undefined, oldCamera)?.position.toArray(), [4, 3, 8]);
});
