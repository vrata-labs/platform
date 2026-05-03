import * as THREE from "three";

import type { LocalPose, Vector3Like } from "./local-pose.js";

export class PlayerRigAdapter {
  constructor(
    private readonly player: THREE.Object3D,
    private readonly pitch: THREE.Object3D
  ) {}

  applyPose(pose: LocalPose): void {
    this.player.position.set(pose.position.x, pose.position.y, pose.position.z);
    this.player.rotation.y = pose.yaw;
    this.pitch.rotation.x = pose.pitch;
    this.player.updateMatrixWorld(true);
  }

  readPosition(): Vector3Like {
    return {
      x: this.player.position.x,
      y: this.player.position.y,
      z: this.player.position.z
    };
  }

  applyYawPreservingCameraXz(pose: LocalPose, nextYaw: number, camera: THREE.Camera): LocalPose {
    const before = new THREE.Vector3();
    const after = new THREE.Vector3();
    this.player.updateMatrixWorld(true);
    camera.getWorldPosition(before);

    const nextPose: LocalPose = {
      ...pose,
      position: { ...pose.position },
      yaw: nextYaw
    };
    this.applyPose(nextPose);
    camera.getWorldPosition(after);

    nextPose.position = {
      x: nextPose.position.x + before.x - after.x,
      y: nextPose.position.y,
      z: nextPose.position.z + before.z - after.z
    };
    this.applyPose(nextPose);
    return nextPose;
  }

  teleportToFloor(input: {
    pose: LocalPose;
    floorPoint: Vector3Like;
    floorY: number;
    camera?: THREE.Camera;
    preserveCameraOffset: boolean;
  }): LocalPose {
    if (!input.preserveCameraOffset || !input.camera) {
      const nextPose: LocalPose = {
        ...input.pose,
        position: {
          x: input.floorPoint.x,
          y: input.floorY,
          z: input.floorPoint.z
        }
      };
      this.applyPose(nextPose);
      return nextPose;
    }

    const cameraWorld = new THREE.Vector3();
    this.player.updateMatrixWorld(true);
    input.camera.getWorldPosition(cameraWorld);
    const currentPosition = this.readPosition();
    const nextPose: LocalPose = {
      ...input.pose,
      position: {
        x: input.floorPoint.x - (cameraWorld.x - currentPosition.x),
        y: input.floorY,
        z: input.floorPoint.z - (cameraWorld.z - currentPosition.z)
      }
    };
    this.applyPose(nextPose);
    return nextPose;
  }
}
