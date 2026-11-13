import test from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";

import { createRemoteAvatarRuntime, resolveRemoteBodyShape } from "./remote-avatar-runtime.js";

function createDebugState() {
  return {
    remoteAvatarCount: 0,
    remoteTargets: [] as Array<{ id: string; x: number; z: number }>,
    remoteParticipants: [] as Array<{
      participantId: string;
      mode: "desktop" | "mobile" | "vr";
      root: { x: number; y: number; z: number; yaw: number };
      body: { x: number; y: number; z: number; yaw: number };
      head: { x: number; y: number; z: number; yaw: number; pitch: number };
      lastSeq: number;
      staleMs: number;
      updateHz: number;
      interpolationDelayMs: number;
      maxObservedJumpM: number;
      audioJoined: boolean;
      muted: boolean;
      speaking: boolean;
      activeAudio: boolean;
      hasVisualEntity: boolean;
      hasAudioNode: boolean;
      appliedRootYaw: number;
      appliedHeadYaw: number;
      seatCushionY: number | null;
      renderedBody: { x: number; y: number; z: number; bottomY: number; topY: number; visible: boolean } | null;
    }>,
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
      playbackDelayMs: number;
      mouthAmount: number;
      speakingActive: boolean;
      lipsyncSourceState: "idle" | "active" | "muted" | "missing" | null;
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
    audioActive: true,
    seated: false
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
  assert.equal((debugState.remoteAvatarParticipants[0]?.playbackDelayMs ?? 0) >= 100, true);
  assert.equal(debugState.remoteAvatarParticipants[0]?.mouthAmount, 0);
  assert.equal(debugState.remoteAvatarParticipants[0]?.lipsyncSourceState, "idle");
});

test("remote avatar runtime stores participant lipsync debug state", () => {
  const scene = new THREE.Scene();
  const runtime = createRemoteAvatarRuntime({
    scene,
    bodyGeometry: new THREE.CapsuleGeometry(0.24, 0.8, 6, 12),
    headGeometry: new THREE.SphereGeometry(0.18, 20, 20),
    localParticipantId: "local"
  });
  const debugState = createDebugState();

  runtime.setParticipantLipsync("remote-lipsync", {
    mouthAmount: 0.4,
    speakingActive: true,
    sourceState: "active"
  }, debugState);

  assert.equal(debugState.remoteAvatarParticipants[0]?.participantId, "remote-lipsync");
  assert.equal(debugState.remoteAvatarParticipants[0]?.mouthAmount, 0.4);
  assert.equal(debugState.remoteAvatarParticipants[0]?.speakingActive, true);
  assert.equal(debugState.remoteAvatarParticipants[0]?.lipsyncSourceState, "active");
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

test("remote avatar runtime does not add visible direction helpers", () => {
  const scene = new THREE.Scene();
  const runtime = createRemoteAvatarRuntime({
    scene,
    bodyGeometry: new THREE.CapsuleGeometry(0.24, 0.8, 6, 12),
    headGeometry: new THREE.SphereGeometry(0.18, 20, 20),
    localParticipantId: "local"
  });
  const debugState = createDebugState();

  runtime.applySnapshotParticipants([{
    participantId: "remote-no-helper",
    displayName: "Remote No Helper",
    mode: "desktop",
    rootTransform: { x: 1, y: 0, z: 2 },
    bodyTransform: { x: 1, y: 0, z: 2 },
    headTransform: { x: 1, y: 0, z: 2 },
    muted: false,
    activeMedia: { audio: false, screenShare: false },
    updatedAt: new Date(0).toISOString()
  }], debugState);

  const hasDirectionHelper = scene.children.some((child) => {
    if (!(child instanceof THREE.Mesh) || !(child.material instanceof THREE.MeshStandardMaterial)) {
      return false;
    }
    return child.material.color.getHex() === 0x9cff8f;
  });
  assert.equal(hasDirectionHelper, false);
});

test("remote avatar runtime forces VR hands visible when pose frames arrive", () => {
  const scene = new THREE.Scene();
  const runtime = createRemoteAvatarRuntime({
    scene,
    bodyGeometry: new THREE.CapsuleGeometry(0.24, 0.8, 6, 12),
    headGeometry: new THREE.SphereGeometry(0.18, 20, 20),
    localParticipantId: "local"
  });
  const debugState = createDebugState();
  runtime.ingestReliableState({
    participantId: "remote-vr",
    avatarId: "preset-01",
    inputMode: "vr-controller",
    updatedAt: new Date().toISOString(),
    audioActive: false,
    seated: false
  }, debugState);
  runtime.applySnapshotParticipants([
    {
      participantId: "remote-vr",
      displayName: "Remote VR",
      mode: "vr",
      muted: false,
      activeMedia: { audio: false, screenShare: false },
      rootTransform: { x: 0, y: 0, z: 0 },
      bodyTransform: { x: 0, y: 0, z: 0 },
      headTransform: { x: 0, y: 1.6, z: 0 },
      updatedAt: new Date().toISOString()
    }
  ] as never, debugState);
  runtime.ingestPoseFrame("remote-vr", {
    seq: 1,
    sentAtMs: Date.now(),
    flags: 0,
    root: { x: 0, y: 0, z: 0, yaw: 0, vx: 0, vz: 0 },
    head: { x: 0, y: 1.6, z: 0, qx: 0, qy: 0, qz: 0, qw: 1 },
    leftHand: { x: -0.2, y: 1.2, z: 0, qx: 0, qy: 0, qz: 0, qw: 1, gesture: 0 },
    rightHand: { x: 0.2, y: 1.2, z: 0, qx: 0, qy: 0, qz: 0, qw: 1, gesture: 0 },
    locomotion: { mode: 1, speed: 1, angularVelocity: 0 }
  }, debugState);

  runtime.update(0.016, debugState);

  assert.equal(debugState.remoteAvatarParticipants[0]?.leftHandVisible, true);
  assert.equal(debugState.remoteAvatarParticipants[0]?.rightHandVisible, true);
});

test("remote avatar runtime applies transported head yaw independently from body yaw", () => {
  const scene = new THREE.Scene();
  const runtime = createRemoteAvatarRuntime({
    scene,
    bodyGeometry: new THREE.CapsuleGeometry(0.24, 0.8, 6, 12),
    headGeometry: new THREE.SphereGeometry(0.18, 20, 20),
    localParticipantId: "local"
  });
  const debugState = createDebugState();

  runtime.ingestReliableState({
    participantId: "remote-head-yaw",
    avatarId: "preset-01",
    inputMode: "vr-controller",
    updatedAt: new Date().toISOString(),
    audioActive: false,
    seated: false
  }, debugState);
  runtime.applySnapshotParticipants([
    {
      participantId: "remote-head-yaw",
      displayName: "Remote Head Yaw",
      mode: "vr",
      muted: false,
      activeMedia: { audio: false, screenShare: false },
      rootTransform: { x: 0, y: 0, z: 0 },
      bodyTransform: { x: 0, y: 0, z: 0 },
      headTransform: { x: 0, y: 1.6, z: 0 },
      updatedAt: new Date().toISOString()
    }
  ] as never, debugState);
  runtime.ingestPoseFrame("remote-head-yaw", {
    seq: 1,
    sentAtMs: Date.now(),
    flags: 0,
    root: { x: 0, y: 0, z: 0, yaw: 0, vx: 0, vz: 0 },
    head: { x: 0, y: 1.6, z: 0, qx: 0, qy: Math.sin(Math.PI / 4), qz: 0, qw: Math.cos(Math.PI / 4) },
    leftHand: { x: -0.2, y: 1.2, z: 0, qx: 0, qy: 0, qz: 0, qw: 1, gesture: 0 },
    rightHand: { x: 0.2, y: 1.2, z: 0, qx: 0, qy: 0, qz: 0, qw: 1, gesture: 0 },
    locomotion: { mode: 1, speed: 1, angularVelocity: 0 }
  }, debugState);

  runtime.update(0.016, debugState);
  const head = scene.children[1] as THREE.Mesh | undefined;

  assert.ok(head);
  assert.equal(head.rotation.y > 0.5, true);
  assert.equal(head.rotation.y < Math.PI / 2, true);
});

test("remote avatar runtime applies transported head pitch without xz drift", () => {
  const scene = new THREE.Scene();
  const runtime = createRemoteAvatarRuntime({
    scene,
    bodyGeometry: new THREE.CapsuleGeometry(0.24, 0.8, 6, 12),
    headGeometry: new THREE.SphereGeometry(0.18, 20, 20),
    localParticipantId: "local"
  });
  const debugState = createDebugState();
  const pitch = 0.5;
  const headQuaternion = new THREE.Quaternion().setFromEuler(new THREE.Euler(pitch, 0, 0, "YXZ"));

  runtime.ingestReliableState({
    participantId: "remote-head-pitch",
    avatarId: "preset-01",
    inputMode: "desktop",
    updatedAt: new Date().toISOString(),
    audioActive: false,
    seated: false
  }, debugState);
  runtime.applySnapshotParticipants([
    {
      participantId: "remote-head-pitch",
      displayName: "Remote Head Pitch",
      mode: "desktop",
      muted: false,
      activeMedia: { audio: false, screenShare: false },
      rootTransform: { x: 0, y: 0, z: 0 },
      bodyTransform: { x: 0, y: 0, z: 0 },
      headTransform: { x: 0, y: 1.6, z: 0 },
      updatedAt: new Date().toISOString()
    }
  ] as never, debugState);
  runtime.ingestPoseFrame("remote-head-pitch", {
    seq: 1,
    sentAtMs: Date.now(),
    flags: 0,
    root: { x: 0, y: 0, z: 0, yaw: 0, vx: 0, vz: 0 },
    head: { x: 0, y: 1.6, z: 0, qx: headQuaternion.x, qy: headQuaternion.y, qz: headQuaternion.z, qw: headQuaternion.w },
    leftHand: { x: -0.2, y: 1.2, z: 0, qx: 0, qy: 0, qz: 0, qw: 1, gesture: 0 },
    rightHand: { x: 0.2, y: 1.2, z: 0, qx: 0, qy: 0, qz: 0, qw: 1, gesture: 0 },
    locomotion: { mode: 0, speed: 0, angularVelocity: 0 }
  }, debugState);

  runtime.update(0.016, debugState);
  const head = scene.children[1] as THREE.Mesh | undefined;
  const participant = debugState.remoteParticipants[0];

  assert.ok(head);
  assert.equal(Number(head.position.x.toFixed(3)), 0);
  assert.equal(Number(head.position.z.toFixed(3)), 0);
  assert.equal(head.rotation.x > 0.2, true);
  assert.equal(participant?.body.y, 0.92);
  assert.equal(participant?.head.y, 1.6);
  assert.equal((participant?.head.pitch ?? 0) > 0.2, true);
});

test("remote avatar runtime keeps last known hands visible through pose gaps", async () => {
  const scene = new THREE.Scene();
  const runtime = createRemoteAvatarRuntime({
    scene,
    bodyGeometry: new THREE.CapsuleGeometry(0.24, 0.8, 6, 12),
    headGeometry: new THREE.SphereGeometry(0.18, 20, 20),
    localParticipantId: "local"
  });
  const debugState = createDebugState();

  runtime.ingestReliableState({
    participantId: "remote-stable-hands",
    avatarId: "preset-01",
    inputMode: "desktop",
    updatedAt: new Date().toISOString(),
    audioActive: false,
    seated: false
  }, debugState);
  runtime.applySnapshotParticipants([
    {
      participantId: "remote-stable-hands",
      displayName: "Remote Stable Hands",
      mode: "desktop",
      muted: false,
      activeMedia: { audio: false, screenShare: false },
      rootTransform: { x: 0, y: 0, z: 0 },
      bodyTransform: { x: 0, y: 0, z: 0 },
      headTransform: { x: 0, y: 1.6, z: 0 },
      updatedAt: new Date().toISOString()
    }
  ] as never, debugState);
  runtime.ingestPoseFrame("remote-stable-hands", {
    seq: 1,
    sentAtMs: Date.now(),
    flags: 0,
    root: { x: 0, y: 0, z: 0, yaw: 0, vx: 0, vz: 0 },
    head: { x: 0, y: 1.6, z: 0, qx: 0, qy: 0, qz: 0, qw: 1 },
    leftHand: { x: -0.2, y: 1.2, z: 0, qx: 0, qy: 0, qz: 0, qw: 1, gesture: 1 },
    rightHand: { x: 0.2, y: 1.2, z: 0, qx: 0, qy: 0, qz: 0, qw: 1, gesture: 1 },
    locomotion: { mode: 1, speed: 1, angularVelocity: 0 }
  }, debugState);

  runtime.update(0.016, debugState);
  await new Promise((resolve) => setTimeout(resolve, 450));
  runtime.update(0.016, debugState);

  assert.equal(debugState.remoteAvatarParticipants[0]?.leftHandVisible, true);
  assert.equal(debugState.remoteAvatarParticipants[0]?.rightHandVisible, true);
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

test("remote avatar runtime prefers pose root over coarse presence sample", () => {
  const scene = new THREE.Scene();
  const runtime = createRemoteAvatarRuntime({
    scene,
    bodyGeometry: new THREE.CapsuleGeometry(0.24, 0.8, 6, 12),
    headGeometry: new THREE.SphereGeometry(0.18, 20, 20),
    localParticipantId: "local"
  });
  const debugState = createDebugState();

  runtime.applySnapshotParticipants([{
    participantId: "remote-4",
    displayName: "Remote 4",
    mode: "desktop",
    muted: false,
    activeMedia: { audio: false, screenShare: false },
    rootTransform: { x: 10, y: 0, z: 10 },
    bodyTransform: { x: 10, y: 0, z: 10 },
    headTransform: { x: 10, y: 1.6, z: 10 },
    updatedAt: new Date().toISOString()
  }], debugState as never);

  runtime.ingestPoseFrame("remote-4", {
    seq: 1,
    sentAtMs: Date.now(),
    flags: 0,
    root: { x: 1, y: 0, z: 1, yaw: 0, vx: 0, vz: 0 },
    head: { x: 1, y: 1.6, z: 1, qx: 0, qy: 0, qz: 0, qw: 1 },
    leftHand: { x: 0.8, y: 1.2, z: 1, qx: 0, qy: 0, qz: 0, qw: 1, gesture: 1 },
    rightHand: { x: 1.2, y: 1.2, z: 1, qx: 0, qy: 0, qz: 0, qw: 1, gesture: 1 },
    locomotion: { mode: 1, speed: 1, angularVelocity: 0 }
  }, debugState);

  runtime.update(0.016, debugState);
  const body = scene.children.find((item) => item instanceof THREE.Mesh) as THREE.Mesh | undefined;
  assert.ok(body);
  assert.equal(body.position.x < 10, true);
  assert.equal(body.position.z < 10, true);
});

test("remote avatar pose smoothing is normalized by frame delta", () => {
  function simulate(deltaSeconds: number, frames: number): { bodyX: number; headX: number } {
    const scene = new THREE.Scene();
    const runtime = createRemoteAvatarRuntime({
      scene,
      bodyGeometry: new THREE.CapsuleGeometry(0.24, 0.8, 6, 12),
      headGeometry: new THREE.SphereGeometry(0.18, 20, 20),
      localParticipantId: "local"
    });
    const debugState = createDebugState();
    runtime.ingestReliableState({
      participantId: "remote-fps",
      avatarId: "preset-01",
      inputMode: "desktop",
      updatedAt: new Date().toISOString(),
      audioActive: false,
      seated: false
    }, debugState);
    runtime.applySnapshotParticipants([
      {
        participantId: "remote-fps",
        displayName: "Remote FPS",
        mode: "desktop",
        muted: false,
        activeMedia: { audio: false, screenShare: false },
        rootTransform: { x: 0, y: 0, z: 0 },
        bodyTransform: { x: 0, y: 0, z: 0 },
        headTransform: { x: 0, y: 1.6, z: 0 },
        updatedAt: new Date().toISOString()
      }
    ] as never, debugState);
    runtime.ingestPoseFrame("remote-fps", {
      seq: 1,
      sentAtMs: Date.now(),
      flags: 0,
      root: { x: 10, y: 0, z: 0, yaw: 0, vx: 0, vz: 0 },
      head: { x: 10, y: 1.6, z: 0, qx: 0, qy: 0, qz: 0, qw: 1 },
      leftHand: { x: 9.8, y: 1.2, z: 0, qx: 0, qy: 0, qz: 0, qw: 1, gesture: 1 },
      rightHand: { x: 10.2, y: 1.2, z: 0, qx: 0, qy: 0, qz: 0, qw: 1, gesture: 1 },
      locomotion: { mode: 1, speed: 1, angularVelocity: 0 }
    }, debugState);

    for (let index = 0; index < frames; index += 1) {
      runtime.update(deltaSeconds, debugState);
    }

    const body = scene.children[0] as THREE.Mesh | undefined;
    const head = scene.children[1] as THREE.Mesh | undefined;
    assert.ok(body);
    assert.ok(head);
    return { bodyX: body.position.x, headX: head.position.x };
  }

  const lowFps = simulate(1 / 30, 6);
  const highFps = simulate(1 / 120, 24);

  assert.ok(Math.abs(lowFps.bodyX - highFps.bodyX) < 0.001);
  assert.ok(Math.abs(lowFps.headX - highFps.headX) < 0.001);
  assert.ok(lowFps.bodyX > 9.9);
});

test("remote seated avatar is drawn at the seat within playback delay after a receiver stall", () => {
  const scene = new THREE.Scene();
  const runtime = createRemoteAvatarRuntime({
    scene,
    bodyGeometry: new THREE.CapsuleGeometry(0.24, 0.8, 6, 12),
    headGeometry: new THREE.SphereGeometry(0.18, 20, 20),
    localParticipantId: "local"
  });
  const debugState = createDebugState();
  const realNow = Date.now;
  let now = 1_000_000;
  Date.now = () => now;
  const standing = { x: -3.6, y: 0.38, z: 0 };
  const seatRoot = { x: -1.95, y: -0.41, z: -1.15 };
  const frame = (seq: number, sentAtMs: number, root: { x: number; y: number; z: number }) => ({
    seq,
    sentAtMs,
    flags: 0,
    root: { ...root, yaw: Math.PI, vx: 0, vz: 0 },
    head: { x: root.x, y: root.y + 1.6, z: root.z, qx: 0, qy: 0, qz: 0, qw: 1 },
    leftHand: { x: root.x, y: root.y + 1.2, z: root.z, qx: 0, qy: 0, qz: 0, qw: 1, gesture: 1 },
    rightHand: { x: root.x, y: root.y + 1.2, z: root.z, qx: 0, qy: 0, qz: 0, qw: 1, gesture: 1 },
    locomotion: { mode: 0, speed: 0, angularVelocity: 0 }
  });
  try {
    runtime.ingestReliableState({
      participantId: "remote-seated",
      avatarId: "preset-01",
      inputMode: "desktop",
      updatedAt: new Date(now).toISOString(),
      audioActive: false,
      seated: false
    }, debugState);
    runtime.applySnapshotParticipants([{
      participantId: "remote-seated",
      displayName: "Remote seated",
      mode: "desktop",
      muted: true,
      activeMedia: { audio: false, screenShare: false },
      rootTransform: standing,
      bodyTransform: standing,
      headTransform: { ...standing, y: standing.y + 1.6 },
      updatedAt: new Date(now).toISOString()
    }] as never, debugState);
    let seq = 1;
    let sentAtMs = now;
    runtime.ingestPoseFrame("remote-seated", frame(seq, sentAtMs, standing), debugState);
    // The receiver main thread stalls for 2.1 s; the next standing frame is handled late.
    now += 2_100;
    sentAtMs += 100;
    runtime.ingestPoseFrame("remote-seated", frame(++seq, sentAtMs, standing), debugState);
    sentAtMs = now - 5;
    // The participant sits down; seated frames now arrive on time at 10 Hz.
    for (let index = 0; index < 6; index += 1) {
      now += 100;
      sentAtMs += 100;
      runtime.ingestPoseFrame("remote-seated", frame(++seq, sentAtMs, seatRoot), debugState);
      for (let tick = 0; tick < 6; tick += 1) {
        now += 16;
        runtime.update(1 / 60, debugState);
      }
      now -= 96;
    }
    now += 96;
    runtime.update(1 / 60, debugState);
    const participant = debugState.remoteParticipants[0]!;
    assert.deepEqual(participant.body, { x: -1.95, y: 0.51, z: -1.15, yaw: 3.142 });
    assert.ok(participant.renderedBody?.visible);
    assert.ok(Math.hypot(participant.renderedBody!.x - -1.95, participant.renderedBody!.y - 0.51, participant.renderedBody!.z - -1.15) < 0.05,
      `drawn body ${JSON.stringify(participant.renderedBody)} must reach the seat within 600 ms of seated frames`);
  } finally {
    Date.now = realNow;
  }
});

const SEAT = { id: "seat-1", position: { x: -1.95, y: 0, z: -1.15 }, yaw: Math.PI, seatHeight: 0.46, radius: 0.4 };
const CUSHION_Y = SEAT.position.y + SEAT.seatHeight;
const CAPSULE_EXTENT = { minY: -0.64, maxY: 0.64 };

test("remote body shape: standing keeps the full capsule, seated rests on the cushion and reaches the head", () => {
  assert.deepEqual(resolveRemoteBodyShape({ rootY: 0, headY: 1.6, inputMode: "desktop", seatCushionY: null, extent: CAPSULE_EXTENT }),
    { centerY: 0.92, scaleY: 1, bottomY: 0.28, topY: 1.56 });
  assert.deepEqual(resolveRemoteBodyShape({ rootY: 0, headY: 1.7, inputMode: "vr-controller", seatCushionY: null, extent: CAPSULE_EXTENT }),
    { centerY: 0.76, scaleY: 1, bottomY: 0.12, topY: 1.4 });
  const close = (actual: number, expected: number, label: string) =>
    assert.ok(Math.abs(actual - expected) < 1e-9, `${label}: ${actual} != ${expected}`);
  // Desktop: the sender lowers its whole rig so the eye is 0.72 m above the cushion.
  const desktop = resolveRemoteBodyShape({ rootY: CUSHION_Y + 0.72 - 1.6, headY: CUSHION_Y + 0.72, inputMode: "desktop", seatCushionY: CUSHION_Y, extent: CAPSULE_EXTENT });
  close(desktop.bottomY, CUSHION_Y, "desktop bottom");
  close(desktop.topY, CUSHION_Y + 0.68, "desktop top");
  close(desktop.centerY + CAPSULE_EXTENT.minY * desktop.scaleY, CUSHION_Y, "desktop drawn bottom");
  close(desktop.centerY + CAPSULE_EXTENT.maxY * desktop.scaleY, CUSHION_Y + 0.68, "desktop drawn top");
  // VR: the rig origin is the cushion and the tracked head decides the top, higher or lower.
  for (const headAboveCushion of [1.25, 0.9]) {
    const vr = resolveRemoteBodyShape({ rootY: CUSHION_Y, headY: CUSHION_Y + headAboveCushion, inputMode: "vr-hand", seatCushionY: CUSHION_Y, extent: CAPSULE_EXTENT });
    close(vr.bottomY, CUSHION_Y, `vr ${headAboveCushion} bottom`);
    close(vr.centerY + CAPSULE_EXTENT.maxY * vr.scaleY, CUSHION_Y + headAboveCushion - 0.04, `vr ${headAboveCushion} top`);
  }
  // A head dipping to the cushion keeps a short torso instead of inverting the body.
  const dipped = resolveRemoteBodyShape({ rootY: CUSHION_Y, headY: CUSHION_Y + 0.1, inputMode: "vr-hand", seatCushionY: CUSHION_Y, extent: CAPSULE_EXTENT });
  close(dipped.bottomY, CUSHION_Y, "dipped bottom");
  close(dipped.topY, CUSHION_Y + 0.3, "dipped top");
  assert.ok(dipped.scaleY > 0);
});

function createSeatingHarness() {
  const scene = new THREE.Scene();
  const runtime = createRemoteAvatarRuntime({
    scene,
    bodyGeometry: new THREE.CapsuleGeometry(0.24, 0.8, 6, 12),
    headGeometry: new THREE.SphereGeometry(0.18, 20, 20),
    localParticipantId: "local",
    getSeatAnchor: (seatId) => seatId === SEAT.id ? SEAT : undefined
  });
  const debugState = createDebugState();
  let now = 2_000_000;
  const seqs = new Map<string, number>();
  const frame = (participantId: string, root: { x: number; y: number; z: number }, headY: number) => {
    const seq = (seqs.get(participantId) ?? 0) + 1;
    seqs.set(participantId, seq);
    return {
      seq,
      sentAtMs: now,
      flags: 0,
      root: { ...root, yaw: Math.PI, vx: 0, vz: 0 },
      head: { x: root.x, y: headY, z: root.z, qx: 0, qy: 0, qz: 0, qw: 1 },
      leftHand: { x: root.x - 0.2, y: headY - 0.4, z: root.z, qx: 0, qy: 0, qz: 0, qw: 1, gesture: 1 },
      rightHand: { x: root.x + 0.2, y: headY - 0.4, z: root.z, qx: 0, qy: 0, qz: 0, qw: 1, gesture: 1 },
      locomotion: { mode: 0, speed: 0, angularVelocity: 0 }
    };
  };
  return {
    scene,
    runtime,
    debugState,
    now: () => now,
    reliable(participantId: string, inputMode: string, seatId: string | null) {
      runtime.ingestReliableState({
        participantId,
        avatarId: "preset-01",
        inputMode,
        updatedAt: new Date(now).toISOString(),
        audioActive: false,
        seated: seatId !== null,
        ...(seatId === null ? {} : { seatId })
      }, debugState);
    },
    join(participantIds: string[]) {
      runtime.applySnapshotParticipants(participantIds.map((participantId) => ({
        participantId,
        displayName: participantId,
        mode: "desktop",
        muted: true,
        activeMedia: { audio: false, screenShare: false },
        rootTransform: { x: 0, y: 0, z: 0 },
        bodyTransform: { x: 0, y: 0, z: 0 },
        headTransform: { x: 0, y: 1.6, z: 0 },
        updatedAt: new Date(now).toISOString()
      })) as never, debugState);
    },
    /** 10 Hz pose frames, 60 Hz rendering. */
    drive(poses: Record<string, { root: { x: number; y: number; z: number }; headY: number }>, durationMs: number) {
      for (let elapsed = 0; elapsed < durationMs; elapsed += 96) {
        for (const [participantId, pose] of Object.entries(poses)) {
          runtime.ingestPoseFrame(participantId, frame(participantId, pose.root, pose.headY), debugState);
        }
        for (let tick = 0; tick < 6; tick += 1) {
          now += 16;
          runtime.update(1 / 60, debugState);
        }
      }
    },
    participant(participantId: string) {
      const participant = debugState.remoteParticipants.find((item) => item.participantId === participantId);
      assert.ok(participant, `debug state for ${participantId}`);
      return participant;
    },
    headMesh(participantId: string) {
      const head = runtime.getAudioTarget(participantId);
      assert.ok(head);
      return head;
    }
  };
}

function withMockedNow(harness: ReturnType<typeof createSeatingHarness>, body: () => void) {
  const realNow = Date.now;
  Date.now = () => harness.now();
  try {
    body();
  } finally {
    Date.now = realNow;
  }
}

function assertNear(actual: number | undefined, expected: number, tolerance: number, label: string) {
  assert.ok(typeof actual === "number" && Math.abs(actual - expected) <= tolerance, `${label}: ${actual} != ${expected} ±${tolerance}`);
}

test("remote desktop avatar shortens onto the cushion when seated and regains its full body after standing up", () => {
  const harness = createSeatingHarness();
  withMockedNow(harness, () => {
    harness.reliable("sitter", "desktop", null);
    harness.reliable("bystander", "desktop", null);
    harness.join(["sitter", "bystander"]);
    const bystander = { root: { x: 1, y: 0, z: 1 }, headY: 1.6 };
    const standing = { root: { x: -3.6, y: 0, z: 0 }, headY: 1.6 };
    harness.drive({ sitter: standing, bystander }, 1500);
    for (const id of ["sitter", "bystander"]) {
      const participant = harness.participant(id);
      assert.equal(participant.seatCushionY, null);
      assertNear(participant.renderedBody?.bottomY, 0.28, 0.005, `${id} standing bottom`);
      assertNear(participant.renderedBody?.topY, 1.56, 0.005, `${id} standing top`);
    }

    // Seated: the sender lowers the whole desktop rig so the eye is 0.72 m above the cushion.
    const seatedRoot = { x: SEAT.position.x, y: CUSHION_Y + 0.72 - 1.6, z: SEAT.position.z };
    harness.reliable("sitter", "desktop", SEAT.id);
    harness.drive({ sitter: { root: seatedRoot, headY: CUSHION_Y + 0.72 }, bystander }, 1500);
    const seated = harness.participant("sitter");
    assert.equal(seated.seatCushionY, CUSHION_Y);
    assert.deepEqual(seated.root, { x: -1.95, y: -0.42, z: -1.15, yaw: 3.142 });
    assert.equal(seated.head.y, 1.18, "the head stays where the pose puts it");
    assertNear(harness.headMesh("sitter").y, CUSHION_Y + 0.72, 0.005, "drawn head");
    assertNear(seated.renderedBody?.bottomY, CUSHION_Y, 0.005, "seated bottom rests on the cushion");
    assertNear(seated.renderedBody?.topY, CUSHION_Y + 0.68, 0.005, "seated top stays under the head");
    assertNear(seated.renderedBody?.y, seated.body.y, 0.005, "drawn body reaches the seated target");
    assertNear(seated.renderedBody?.x, SEAT.position.x, 0.005, "seated x");
    assertNear(seated.renderedBody?.z, SEAT.position.z, 0.005, "seated z");
    const bystanderWhileSeated = harness.participant("bystander");
    assert.equal(bystanderWhileSeated.seatCushionY, null);
    assertNear(bystanderWhileSeated.renderedBody?.bottomY, 0.28, 0.005, "bystander unchanged");
    assertNear(bystanderWhileSeated.renderedBody?.topY, 1.56, 0.005, "bystander unchanged");

    // Standing up restores the original full body.
    harness.reliable("sitter", "desktop", null);
    harness.drive({ sitter: { root: { x: -1.95, y: 0, z: -0.4 }, headY: 1.6 }, bystander }, 1500);
    const released = harness.participant("sitter");
    assert.equal(released.seatCushionY, null);
    assertNear(released.renderedBody?.y, 0.92, 0.005, "released centre");
    assertNear(released.renderedBody?.bottomY, 0.28, 0.005, "released bottom");
    assertNear(released.renderedBody?.topY, 1.56, 0.005, "released top");
  });
});

test("remote VR avatar seated body spans from the cushion to its tracked head, yaw-only", () => {
  const harness = createSeatingHarness();
  withMockedNow(harness, () => {
    harness.reliable("vr", "vr-controller", SEAT.id);
    harness.join(["vr"]);
    const seatRoot = { x: SEAT.position.x, y: CUSHION_Y, z: SEAT.position.z };
    for (const headAboveCushion of [1.25, 0.9]) {
      harness.drive({ vr: { root: seatRoot, headY: CUSHION_Y + headAboveCushion } }, 1500);
      const participant = harness.participant("vr");
      assertNear(harness.headMesh("vr").y, CUSHION_Y + headAboveCushion, 0.005, `vr ${headAboveCushion} head`);
      assertNear(participant.renderedBody?.bottomY, CUSHION_Y, 0.005, `vr ${headAboveCushion} bottom`);
      assertNear(participant.renderedBody?.topY, CUSHION_Y + headAboveCushion - 0.04, 0.005, `vr ${headAboveCushion} top`);
    }
    const body = harness.scene.children[0] as THREE.Mesh;
    assert.equal(body.rotation.x, 0);
    assert.equal(body.rotation.z, 0);
    harness.reliable("vr", "vr-controller", null);
    harness.drive({ vr: { root: { x: -1.95, y: 0, z: -0.4 }, headY: 1.7 } }, 1500);
    const standing = harness.participant("vr");
    assertNear(standing.renderedBody?.y, 0.76, 0.005, "standing VR centre follows poseFrame.root.y");
    assertNear(standing.renderedBody?.topY, 1.4, 0.005, "standing VR top");
  });
});

test("remote avatar seated on a seat unknown to this scene keeps the standing body", () => {
  const harness = createSeatingHarness();
  withMockedNow(harness, () => {
    harness.reliable("remote", "desktop", "seat-elsewhere");
    harness.join(["remote"]);
    harness.drive({ remote: { root: { x: 0, y: -0.42, z: 0 }, headY: 1.18 } }, 1500);
    const participant = harness.participant("remote");
    assert.equal(participant.seatCushionY, null);
    assertNear(participant.renderedBody?.y, 0.5, 0.005, "unknown seat centre");
    assertNear((participant.renderedBody?.topY ?? 0) - (participant.renderedBody?.bottomY ?? 0), 1.28, 0.005, "full height");
  });
});
