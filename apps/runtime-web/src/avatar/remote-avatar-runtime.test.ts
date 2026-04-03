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
    remoteAvatarPoseFrames: [] as Array<{ participantId: string; seq: number; locomotionMode: number; sentAtMs: number }>,
    remoteAvatarParticipants: [] as Array<{
      participantId: string;
      avatarId: string | null;
      inputMode: string | null;
      presenceSeen: boolean;
      hasReliableState: boolean;
      hasPoseFrame: boolean;
      leftHandVisible: boolean;
      rightHandVisible: boolean;
      poseBufferDepth: number;
      droppedStaleCount: number;
      droppedReorderCount: number;
      lastPoseSeq: number | null;
      poseAgeMs: number | null;
    }>
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
  const sentAtMs = Date.now();

  runtime.ingestReliableState({
    participantId: "remote-1",
    avatarId: "preset-01",
    inputMode: "desktop",
    updatedAt: new Date(0).toISOString(),
    audioActive: true
  }, debugState);
  runtime.ingestPoseFrame("remote-1", {
    seq: 1,
    sentAtMs,
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
  const model = runtime.getParticipantModel("remote-1");
  assert.equal(model?.reliableState?.avatarId, "preset-01");
  assert.equal(model?.poseFrame?.seq, 1);
  assert.equal(debugState.remoteAvatarParticipants[0]?.participantId, "remote-1");
  assert.equal(debugState.remoteAvatarParticipants[0]?.presenceSeen, false);
  assert.equal(debugState.remoteAvatarParticipants[0]?.hasReliableState, true);
  assert.equal(debugState.remoteAvatarParticipants[0]?.hasPoseFrame, true);
  assert.equal(debugState.remoteAvatarParticipants[0]?.poseBufferDepth, 1);
  assert.equal(debugState.remoteAvatarParticipants[0]?.lastPoseSeq, 1);
});

test("remote avatar runtime reflects hand visibility from pose gestures", () => {
  const scene = new THREE.Scene();
  const runtime = createRemoteAvatarRuntime({
    scene,
    bodyGeometry: new THREE.CapsuleGeometry(0.24, 0.8, 6, 12),
    headGeometry: new THREE.SphereGeometry(0.18, 20, 20),
    localParticipantId: "local"
  });
  const debugState = createDebugState();

  runtime.applySnapshotParticipants([{
    participantId: "remote-2",
    displayName: "Remote 2",
    mode: "desktop",
    rootTransform: { x: 1, y: 0, z: 2 },
    bodyTransform: { x: 1, y: 0, z: 2 },
    headTransform: { x: 1, y: 0, z: 2 },
    muted: false,
    activeMedia: { audio: true, screenShare: false },
    updatedAt: new Date(0).toISOString()
  }], debugState);
  const sentAtMs = Date.now();
  runtime.ingestPoseFrame("remote-2", {
    seq: 2,
    sentAtMs,
    flags: 0,
    root: { x: 1, y: 0, z: 2, yaw: 0, vx: 0, vz: 0 },
    head: { x: 1, y: 1.6, z: 2, qx: 0, qy: 0, qz: 0, qw: 1 },
    leftHand: { x: 0.8, y: 1.2, z: 2.1, qx: 0, qy: 0, qz: 0, qw: 1, gesture: 1 },
    rightHand: { x: 1.2, y: 1.2, z: 2.1, qx: 0, qy: 0, qz: 0, qw: 1, gesture: 0 },
    locomotion: { mode: 1, speed: 1, angularVelocity: 0 }
  }, debugState);

  runtime.update(0.016, debugState);

  assert.equal(debugState.remoteAvatarParticipants[0]?.presenceSeen, true);
  assert.equal(debugState.remoteAvatarParticipants[0]?.leftHandVisible, true);
  assert.equal(debugState.remoteAvatarParticipants[0]?.rightHandVisible, false);
});

test("remote avatar runtime ignores reordered pose frames", () => {
  const scene = new THREE.Scene();
  const runtime = createRemoteAvatarRuntime({
    scene,
    bodyGeometry: new THREE.CapsuleGeometry(0.24, 0.8, 6, 12),
    headGeometry: new THREE.SphereGeometry(0.18, 20, 20),
    localParticipantId: "local"
  });
  const debugState = createDebugState();

  runtime.ingestPoseFrame("remote-3", {
    seq: 5,
    sentAtMs: 500,
    flags: 0,
    root: { x: 5, y: 0, z: 5, yaw: 0, vx: 0, vz: 0 },
    head: { x: 5, y: 1.6, z: 5, qx: 0, qy: 0, qz: 0, qw: 1 },
    leftHand: { x: 5, y: 1.2, z: 5, qx: 0, qy: 0, qz: 0, qw: 1, gesture: 1 },
    rightHand: { x: 5, y: 1.2, z: 5, qx: 0, qy: 0, qz: 0, qw: 1, gesture: 1 },
    locomotion: { mode: 1, speed: 1, angularVelocity: 0 }
  }, debugState);
  runtime.ingestPoseFrame("remote-3", {
    seq: 4,
    sentAtMs: 400,
    flags: 0,
    root: { x: 4, y: 0, z: 4, yaw: 0, vx: 0, vz: 0 },
    head: { x: 4, y: 1.6, z: 4, qx: 0, qy: 0, qz: 0, qw: 1 },
    leftHand: { x: 4, y: 1.2, z: 4, qx: 0, qy: 0, qz: 0, qw: 1, gesture: 1 },
    rightHand: { x: 4, y: 1.2, z: 4, qx: 0, qy: 0, qz: 0, qw: 1, gesture: 1 },
    locomotion: { mode: 1, speed: 1, angularVelocity: 0 }
  }, debugState);

  const model = runtime.getParticipantModel("remote-3");
  assert.equal(model?.poseFrame?.seq, 5);
  assert.equal(debugState.remoteAvatarParticipants[0]?.droppedReorderCount, 1);
  assert.equal(debugState.remoteAvatarParticipants[0]?.lastPoseSeq, 5);
});
