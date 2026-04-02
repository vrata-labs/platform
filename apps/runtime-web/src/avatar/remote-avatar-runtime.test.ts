import test from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";

import { createRemoteAvatarRuntime } from "./remote-avatar-runtime.js";

function createDebugState() {
  return {
    remoteAvatarCount: 0,
    remoteTargets: [] as Array<{ id: string; x: number; z: number }>,
    remoteAvatarReliableCount: 0,
    remoteAvatarPoseCount: 0,
    remoteAvatarReliableStates: [] as Array<{ participantId: string; avatarId: string; inputMode: string; updatedAt: string }>,
    remoteAvatarPoseFrames: [] as Array<{ participantId: string; seq: number; locomotionMode: number; sentAtMs: number }>
  };
}

test("remote avatar runtime ingests reliable state and pose frame into debug state", () => {
  const scene = new THREE.Scene();
  const runtime = createRemoteAvatarRuntime({
    scene,
    bodyGeometry: new THREE.CapsuleGeometry(0.24, 0.8, 6, 12),
    headGeometry: new THREE.SphereGeometry(0.18, 20, 20),
    localParticipantId: "local"
  });
  const debugState = createDebugState();

  runtime.ingestReliableState({
    participantId: "remote-1",
    avatarId: "preset-01",
    inputMode: "desktop",
    updatedAt: new Date(0).toISOString(),
    audioActive: true
  }, debugState);
  runtime.ingestPoseFrame("remote-1", {
    seq: 1,
    sentAtMs: 1,
    flags: 0,
    root: { x: 0, y: 0, z: 0, yaw: 0, vx: 0, vz: 0 },
    head: { x: 0, y: 1.6, z: 0, qx: 0, qy: 0, qz: 0, qw: 1 },
    leftHand: { x: -0.2, y: 1.2, z: 0.1, qx: 0, qy: 0, qz: 0, qw: 1, gesture: 1 },
    rightHand: { x: 0.2, y: 1.2, z: 0.1, qx: 0, qy: 0, qz: 0, qw: 1, gesture: 1 },
    locomotion: { mode: 1, speed: 1, angularVelocity: 0 }
  }, debugState);

  assert.equal(debugState.remoteAvatarReliableCount, 1);
  assert.equal(debugState.remoteAvatarPoseCount, 1);
  assert.equal(debugState.remoteAvatarReliableStates[0]?.participantId, "remote-1");
  assert.equal(debugState.remoteAvatarPoseFrames[0]?.participantId, "remote-1");
});
