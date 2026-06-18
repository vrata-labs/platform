import type * as THREE from "three";

import { PlayerRigAdapter } from "./player-rig-adapter.js";

export interface Vector3Like {
  x: number;
  y: number;
  z: number;
}

export interface LocalPose {
  position: Vector3Like;
  yaw: number;
  pitch: number;
}

export type LocalPoseMutationReason =
  | "spawn"
  | "debug_fit"
  | "desktop_move"
  | "xr_move"
  | "snap_turn"
  | "teleport"
  | "seat_enter"
  | "seat_lock"
  | "seat_exit"
  | "xr_session_start";

export interface LocalPoseController {
  getPose(): LocalPose;
  getPosition(): Vector3Like;
  getYaw(): number;
  getPitch(): number;
  getLastMutationReason(): LocalPoseMutationReason | null;
  setPose(pose: LocalPose, reason: LocalPoseMutationReason): LocalPose;
  setYaw(nextYaw: number, reason: LocalPoseMutationReason, options?: { preserveCameraXz?: boolean; camera?: THREE.Camera }): LocalPose;
  setPitch(nextPitch: number, reason: LocalPoseMutationReason): LocalPose;
  setYawPitch(next: { yaw: number; pitch: number }, reason: LocalPoseMutationReason): LocalPose;
  applyPointerLookDelta(delta: { movementX: number; movementY: number }, reason?: LocalPoseMutationReason): LocalPose;
  moveFlatTo(position: { x: number; z: number }, reason: LocalPoseMutationReason): LocalPose;
  teleportToFloor(point: Vector3Like, floorY: number, reason: LocalPoseMutationReason, options?: { preserveCameraOffset?: boolean; camera?: THREE.Camera }): LocalPose;
  lockToSeat(position: Vector3Like, reason: LocalPoseMutationReason, options?: { yaw?: number }): LocalPose;
  alignFloorY(floorY: number, reason: LocalPoseMutationReason): LocalPose;
}

function clonePose(pose: LocalPose): LocalPose {
  return {
    position: { ...pose.position },
    yaw: pose.yaw,
    pitch: pose.pitch
  };
}

function clampPitch(pitch: number): number {
  return Math.max(-1.1, Math.min(1.1, pitch));
}

class DefaultLocalPoseController implements LocalPoseController {
  private pose: LocalPose;
  private lastReason: LocalPoseMutationReason | null = null;

  constructor(private readonly rig: PlayerRigAdapter, initialPose: LocalPose) {
    this.pose = clonePose(initialPose);
    this.rig.applyPose(this.pose);
    this.lastReason = "spawn";
  }

  getPose(): LocalPose {
    return clonePose(this.pose);
  }

  getPosition(): Vector3Like {
    return { ...this.pose.position };
  }

  getYaw(): number {
    return this.pose.yaw;
  }

  getPitch(): number {
    return this.pose.pitch;
  }

  getLastMutationReason(): LocalPoseMutationReason | null {
    return this.lastReason;
  }

  setPose(pose: LocalPose, reason: LocalPoseMutationReason): LocalPose {
    this.pose = clonePose({
      ...pose,
      pitch: clampPitch(pose.pitch)
    });
    this.lastReason = reason;
    this.rig.applyPose(this.pose);
    return this.getPose();
  }

  setYaw(nextYaw: number, reason: LocalPoseMutationReason, options: { preserveCameraXz?: boolean; camera?: THREE.Camera } = {}): LocalPose {
    if (options.preserveCameraXz && options.camera) {
      this.pose = this.rig.applyYawPreservingCameraXz(this.pose, nextYaw, options.camera);
      this.lastReason = reason;
      return this.getPose();
    }
    return this.setPose({ ...this.pose, yaw: nextYaw }, reason);
  }

  setPitch(nextPitch: number, reason: LocalPoseMutationReason): LocalPose {
    return this.setPose({ ...this.pose, pitch: nextPitch }, reason);
  }

  setYawPitch(next: { yaw: number; pitch: number }, reason: LocalPoseMutationReason): LocalPose {
    return this.setPose({ ...this.pose, yaw: next.yaw, pitch: next.pitch }, reason);
  }

  applyPointerLookDelta(delta: { movementX: number; movementY: number }, reason: LocalPoseMutationReason = "desktop_move"): LocalPose {
    return this.setYawPitch({
      yaw: this.pose.yaw - delta.movementX * 0.003,
      pitch: this.pose.pitch - delta.movementY * 0.003
    }, reason);
  }

  moveFlatTo(position: { x: number; z: number }, reason: LocalPoseMutationReason): LocalPose {
    return this.setPose({
      ...this.pose,
      position: {
        x: position.x,
        y: this.pose.position.y,
        z: position.z
      }
    }, reason);
  }

  teleportToFloor(point: Vector3Like, floorY: number, reason: LocalPoseMutationReason, options: { preserveCameraOffset?: boolean; camera?: THREE.Camera } = {}): LocalPose {
    this.pose = this.rig.teleportToFloor({
      pose: this.pose,
      floorPoint: point,
      floorY,
      camera: options.camera,
      preserveCameraOffset: options.preserveCameraOffset ?? false
    });
    this.lastReason = reason;
    return this.getPose();
  }

  lockToSeat(position: Vector3Like, reason: LocalPoseMutationReason, options: { yaw?: number } = {}): LocalPose {
    return this.setPose({
      ...this.pose,
      position: { ...position },
      yaw: options.yaw ?? this.pose.yaw
    }, reason);
  }

  alignFloorY(floorY: number, reason: LocalPoseMutationReason): LocalPose {
    return this.setPose({
      ...this.pose,
      position: {
        ...this.pose.position,
        y: floorY
      }
    }, reason);
  }
}

export function createLocalPoseController(input: {
  player: THREE.Object3D;
  pitch: THREE.Object3D;
  initialPose?: LocalPose;
}): LocalPoseController {
  return new DefaultLocalPoseController(
    new PlayerRigAdapter(input.player, input.pitch),
    input.initialPose ?? {
      position: { x: 0, y: 0, z: 0 },
      yaw: 0,
      pitch: 0
    }
  );
}
