import * as THREE from "three";

import { createAvatarPoseBuffer, pushAvatarPoseFrame, pruneAvatarPoseBuffer, sampleAvatarPoseBuffer, type AvatarPoseBuffer } from "./avatar-pose-buffer.js";
import { createMotionTrack, pushMotionSample, sampleMotion, type MotionTrack } from "../motion-state.js";
import type { PresenceState } from "../index.js";
import type { CompactPoseFrame } from "./avatar-types.js";

export interface RemoteAvatarReliableStateView {
  participantId: string;
  avatarId: string;
  inputMode: string;
  updatedAt: string;
  audioActive: boolean;
}

export interface RemoteAvatarPoseFrameView {
  participantId: string;
  seq: number;
  locomotionMode: number;
  sentAtMs: number;
  frame: CompactPoseFrame;
}

export interface RemoteAvatarDebugState {
  remoteAvatarCount: number;
  remoteTargets: Array<{ id: string; x: number; z: number }>;
  remoteAvatarReliableCount: number;
  remoteAvatarPoseCount: number;
  remoteAvatarReliableStates: Array<{ participantId: string; avatarId: string; inputMode: string; updatedAt: string }>;
  remoteAvatarPoseFrames: Array<{ participantId: string; seq: number; locomotionMode: number; sentAtMs: number }>;
  remoteAvatarParticipants: Array<{
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
  }>;
}

interface RemoteAvatarParticipantModel {
  participantId: string;
  presenceSeen: boolean;
  reliableState: RemoteAvatarReliableStateView | null;
  poseFrame: RemoteAvatarPoseFrameView | null;
  poseBuffer: AvatarPoseBuffer;
  leftHandVisible: boolean;
  rightHandVisible: boolean;
  lastPoseAppliedAtMs: number | null;
}

interface RemoteAvatarEntity {
  body: THREE.Mesh;
  head: THREE.Mesh;
  leftHand: THREE.Mesh;
  rightHand: THREE.Mesh;
}

interface RemoteAvatarMotion {
  root: MotionTrack;
  body: MotionTrack;
  head: MotionTrack;
}

function getPresenceCaptureTime(updatedAt: string | undefined, fallbackNow: number): number {
  const parsed = updatedAt ? Date.parse(updatedAt) : Number.NaN;
  return Number.isFinite(parsed) ? parsed : fallbackNow;
}

function makeBody(bodyGeometry: THREE.BufferGeometry, color: number): THREE.Mesh {
  return new THREE.Mesh(bodyGeometry, new THREE.MeshStandardMaterial({ color, roughness: 0.45, metalness: 0.08 }));
}

function makeHead(headGeometry: THREE.BufferGeometry, color: number): THREE.Mesh {
  return new THREE.Mesh(headGeometry, new THREE.MeshStandardMaterial({ color, roughness: 0.3, metalness: 0.05 }));
}

function makeHand(color: number): THREE.Mesh {
  return new THREE.Mesh(
    new THREE.SphereGeometry(0.09, 16, 16),
    new THREE.MeshStandardMaterial({ color, roughness: 0.35, metalness: 0.04 })
  );
}

function lerpPosePoint(a: { x: number; y: number; z: number }, b: { x: number; y: number; z: number }, alpha: number): { x: number; y: number; z: number } {
  return {
    x: THREE.MathUtils.lerp(a.x, b.x, alpha),
    y: THREE.MathUtils.lerp(a.y, b.y, alpha),
    z: THREE.MathUtils.lerp(a.z, b.z, alpha)
  };
}

function resolveInterpolatedPose(sample: ReturnType<typeof sampleAvatarPoseBuffer>, renderAtMs: number): CompactPoseFrame | null {
  if (sample.previous && sample.next && sample.next.sentAtMs > sample.previous.sentAtMs) {
    const alpha = THREE.MathUtils.clamp(
      (renderAtMs - sample.previous.sentAtMs) / (sample.next.sentAtMs - sample.previous.sentAtMs),
      0,
      1
    );
    return {
      ...sample.next,
      sentAtMs: renderAtMs,
      root: {
        ...sample.next.root,
        ...lerpPosePoint(sample.previous.root, sample.next.root, alpha),
        yaw: THREE.MathUtils.lerp(sample.previous.root.yaw, sample.next.root.yaw, alpha),
        vx: THREE.MathUtils.lerp(sample.previous.root.vx, sample.next.root.vx, alpha),
        vz: THREE.MathUtils.lerp(sample.previous.root.vz, sample.next.root.vz, alpha)
      },
      head: {
        ...sample.next.head,
        ...lerpPosePoint(sample.previous.head, sample.next.head, alpha)
      },
      leftHand: {
        ...sample.next.leftHand,
        ...lerpPosePoint(sample.previous.leftHand, sample.next.leftHand, alpha),
        gesture: alpha < 0.5 ? sample.previous.leftHand.gesture : sample.next.leftHand.gesture
      },
      rightHand: {
        ...sample.next.rightHand,
        ...lerpPosePoint(sample.previous.rightHand, sample.next.rightHand, alpha),
        gesture: alpha < 0.5 ? sample.previous.rightHand.gesture : sample.next.rightHand.gesture
      },
      locomotion: {
        mode: alpha < 0.5 ? sample.previous.locomotion.mode : sample.next.locomotion.mode,
        speed: THREE.MathUtils.lerp(sample.previous.locomotion.speed, sample.next.locomotion.speed, alpha),
        angularVelocity: THREE.MathUtils.lerp(sample.previous.locomotion.angularVelocity, sample.next.locomotion.angularVelocity, alpha)
      }
    };
  }

  const latest = sample.latest;
  if (!latest) {
    return null;
  }
  if (renderAtMs - latest.sentAtMs > 320) {
    return null;
  }
  return latest;
}

export function createRemoteAvatarRuntime(input: {
  scene: THREE.Scene;
  bodyGeometry: THREE.BufferGeometry;
  headGeometry: THREE.BufferGeometry;
  localParticipantId: string;
}) {
  const remoteAvatars = new Map<string, RemoteAvatarEntity>();
  const remoteMotionTracks = new Map<string, RemoteAvatarMotion>();
  const remoteAvatarParticipants = new Map<string, RemoteAvatarParticipantModel>();

  function ensureParticipantModel(participantId: string): RemoteAvatarParticipantModel {
    let model = remoteAvatarParticipants.get(participantId);
    if (!model) {
      model = {
        participantId,
        presenceSeen: false,
        reliableState: null,
        poseFrame: null,
        poseBuffer: createAvatarPoseBuffer(),
        leftHandVisible: false,
        rightHandVisible: false,
        lastPoseAppliedAtMs: null
      };
      remoteAvatarParticipants.set(participantId, model);
    }
    return model;
  }

  function ensureRemoteAvatar(participant: PresenceState): RemoteAvatarEntity {
    let entity = remoteAvatars.get(participant.participantId);
    if (!entity) {
      const body = makeBody(input.bodyGeometry, participant.activeMedia.audio ? 0x5fc8ff : 0xbfd8ee);
      const head = makeHead(input.headGeometry, 0xf6fbff);
      const leftHand = makeHand(0xf2b3a0);
      const rightHand = makeHand(0xf2b3a0);
      input.scene.add(body, head, leftHand, rightHand);
      entity = { body, head, leftHand, rightHand };
      remoteAvatars.set(participant.participantId, entity);
      remoteMotionTracks.set(participant.participantId, {
        root: pushMotionSample(createMotionTrack(), { x: participant.rootTransform.x, z: participant.rootTransform.z, capturedAtMs: getPresenceCaptureTime(participant.updatedAt, Date.now()) }),
        body: pushMotionSample(createMotionTrack(), { x: participant.bodyTransform?.x ?? participant.rootTransform.x, z: participant.bodyTransform?.z ?? participant.rootTransform.z, capturedAtMs: getPresenceCaptureTime(participant.updatedAt, Date.now()) }),
        head: pushMotionSample(createMotionTrack(), { x: participant.headTransform?.x ?? participant.rootTransform.x, z: participant.headTransform?.z ?? participant.rootTransform.z, capturedAtMs: getPresenceCaptureTime(participant.updatedAt, Date.now()) })
      });
    }
    return entity;
  }

  function syncDebugState(debugState: RemoteAvatarDebugState): void {
    debugState.remoteAvatarCount = remoteAvatars.size;
    debugState.remoteTargets = Array.from(remoteMotionTracks.entries()).map(([id, track]) => {
      const latest = track.root.samples[track.root.samples.length - 1];
      return { id, x: Number((latest?.x ?? 0).toFixed(2)), z: Number((latest?.z ?? 0).toFixed(2)) };
    });
    debugState.remoteAvatarReliableStates = Array.from(remoteAvatarParticipants.values())
      .map((participant) => participant.reliableState)
      .filter((state): state is RemoteAvatarReliableStateView => Boolean(state))
      .sort((a, b) => a.participantId.localeCompare(b.participantId))
      .map(({ participantId, avatarId, inputMode, updatedAt }) => ({ participantId, avatarId, inputMode, updatedAt }));
    debugState.remoteAvatarPoseFrames = Array.from(remoteAvatarParticipants.values())
      .map((participant) => participant.poseFrame)
      .filter((frame): frame is RemoteAvatarPoseFrameView => Boolean(frame))
      .sort((a, b) => a.participantId.localeCompare(b.participantId))
      .map(({ participantId, seq, locomotionMode, sentAtMs }) => ({ participantId, seq, locomotionMode, sentAtMs }));
    debugState.remoteAvatarParticipants = Array.from(remoteAvatarParticipants.values())
      .sort((a, b) => a.participantId.localeCompare(b.participantId))
      .map((participant) => {
        const entity = remoteAvatars.get(participant.participantId);
        return {
          participantId: participant.participantId,
          avatarId: participant.reliableState?.avatarId ?? null,
          inputMode: participant.reliableState?.inputMode ?? null,
          presenceSeen: participant.presenceSeen,
          hasReliableState: participant.reliableState !== null,
          hasPoseFrame: participant.poseFrame !== null,
          leftHandVisible: participant.leftHandVisible || entity?.leftHand.visible || false,
          rightHandVisible: participant.rightHandVisible || entity?.rightHand.visible || false,
          poseBufferDepth: participant.poseBuffer.frames.length,
          droppedStaleCount: participant.poseBuffer.droppedStaleCount,
          droppedReorderCount: participant.poseBuffer.droppedReorderCount,
          lastPoseSeq: participant.poseBuffer.lastSeq,
          poseAgeMs: participant.poseFrame ? Math.max(0, Date.now() - participant.poseFrame.sentAtMs) : null,
          playbackDelayMs: participant.poseBuffer.recommendedPlaybackDelayMs
        };
      });
    debugState.remoteAvatarReliableCount = debugState.remoteAvatarReliableStates.length;
    debugState.remoteAvatarPoseCount = debugState.remoteAvatarPoseFrames.length;
  }

  return {
    getAudioTarget(participantId: string): THREE.Vector3 | null {
      const entity = remoteAvatars.get(participantId);
      return entity?.head.position ?? entity?.body.position ?? null;
    },
    applySnapshotParticipants(people: PresenceState[], debugState: RemoteAvatarDebugState): void {
      const activeIds = new Set<string>();
      for (const person of people) {
        if (person.participantId === input.localParticipantId) continue;
        activeIds.add(person.participantId);
        ensureParticipantModel(person.participantId).presenceSeen = true;
        const entity = ensureRemoteAvatar(person);
        const bodyMaterial = entity.body.material;
        if (bodyMaterial instanceof THREE.MeshStandardMaterial) {
          bodyMaterial.color.setHex(person.activeMedia.audio ? 0x5fc8ff : 0xbfd8ee);
        }
        const current = remoteMotionTracks.get(person.participantId) ?? { root: createMotionTrack(), body: createMotionTrack(), head: createMotionTrack() };
        const capturedAtMs = getPresenceCaptureTime(person.updatedAt, Date.now());
        remoteMotionTracks.set(person.participantId, {
          root: pushMotionSample(current.root, { x: person.rootTransform.x, z: person.rootTransform.z, capturedAtMs }),
          body: pushMotionSample(current.body, { x: person.bodyTransform?.x ?? person.rootTransform.x, z: person.bodyTransform?.z ?? person.rootTransform.z, capturedAtMs }),
          head: pushMotionSample(current.head, { x: person.headTransform?.x ?? person.rootTransform.x, z: person.headTransform?.z ?? person.rootTransform.z, capturedAtMs })
        });
        if (entity.body.position.lengthSq() === 0) {
          entity.body.position.set(person.bodyTransform?.x ?? person.rootTransform.x, 0.92, person.bodyTransform?.z ?? person.rootTransform.z);
          entity.head.position.set(person.headTransform?.x ?? person.rootTransform.x, 1.58, person.headTransform?.z ?? person.rootTransform.z);
        }
      }
      for (const [id, mesh] of remoteAvatars.entries()) {
        if (!activeIds.has(id)) {
          input.scene.remove(mesh.body, mesh.head, mesh.leftHand, mesh.rightHand);
          remoteAvatars.delete(id);
          remoteMotionTracks.delete(id);
          remoteAvatarParticipants.delete(id);
        }
      }
      syncDebugState(debugState);
    },
    ingestReliableState(state: RemoteAvatarReliableStateView, debugState: RemoteAvatarDebugState): void {
      if (state.participantId === input.localParticipantId) return;
      ensureParticipantModel(state.participantId).reliableState = state;
      syncDebugState(debugState);
    },
    ingestPoseFrame(participantId: string, frame: CompactPoseFrame, debugState: RemoteAvatarDebugState): void {
      if (participantId === input.localParticipantId) return;
      const participant = ensureParticipantModel(participantId);
      const result = pushAvatarPoseFrame(participant.poseBuffer, frame, Date.now());
      if (!result.accepted) {
        syncDebugState(debugState);
        return;
      }
      participant.poseFrame = {
        participantId,
        seq: frame.seq,
        locomotionMode: frame.locomotion.mode,
        sentAtMs: frame.sentAtMs,
        frame
      };
      syncDebugState(debugState);
    },
    update(delta: number, debugState: RemoteAvatarDebugState): void {
      void delta;
      const nowMs = Date.now();
      for (const [participantId, entity] of remoteAvatars.entries()) {
        const tracks = remoteMotionTracks.get(participantId);
        if (!tracks) continue;
        const participant = remoteAvatarParticipants.get(participantId);
        const playbackDelayMs = participant?.poseBuffer.recommendedPlaybackDelayMs ?? 100;
        const renderAtMs = nowMs - playbackDelayMs;
        const bodySample = sampleMotion(tracks.body, renderAtMs);
        const headSample = sampleMotion(tracks.head, renderAtMs);
        const reliableState = participant?.reliableState ?? null;
        if (participant) {
          pruneAvatarPoseBuffer(participant.poseBuffer, nowMs);
        }
        const poseFrame = participant ? resolveInterpolatedPose(sampleAvatarPoseBuffer(participant.poseBuffer, renderAtMs), renderAtMs) : null;
        const bodyMaterial = entity.body.material;
        if (bodyMaterial instanceof THREE.MeshStandardMaterial) {
          const color = reliableState?.inputMode === "mobile"
            ? 0xffc857
            : reliableState?.inputMode === "vr-controller" || reliableState?.inputMode === "vr-hand"
              ? 0x8be9fd
              : reliableState?.audioActive
                ? 0x5fc8ff
                : 0xbfd8ee;
          bodyMaterial.color.setHex(color);
        }
        if (poseFrame) {
          entity.body.position.lerp(new THREE.Vector3(poseFrame.root.x, 0.92, poseFrame.root.z), 0.35);
          entity.head.position.lerp(new THREE.Vector3(poseFrame.head.x, poseFrame.head.y, poseFrame.head.z), 0.45);
          entity.leftHand.position.lerp(new THREE.Vector3(poseFrame.leftHand.x, poseFrame.leftHand.y, poseFrame.leftHand.z), 0.45);
          entity.rightHand.position.lerp(new THREE.Vector3(poseFrame.rightHand.x, poseFrame.rightHand.y, poseFrame.rightHand.z), 0.45);
          entity.body.lookAt(poseFrame.head.x, 0.92, poseFrame.head.z);
          entity.leftHand.visible = poseFrame.leftHand.gesture > 0;
          entity.rightHand.visible = poseFrame.rightHand.gesture > 0;
          if (participant) {
            participant.leftHandVisible = entity.leftHand.visible;
            participant.rightHandVisible = entity.rightHand.visible;
            participant.lastPoseAppliedAtMs = nowMs;
          }
        } else {
          if (bodySample && headSample) {
            entity.body.position.lerp(new THREE.Vector3(bodySample.x, 0.92, bodySample.z), 0.2);
            entity.head.position.lerp(new THREE.Vector3(headSample.x, 1.58, headSample.z), 0.25);
            entity.body.lookAt(headSample.x, 0.92, headSample.z);
          }
          const lastPoseAppliedAtMs = participant?.lastPoseAppliedAtMs ?? null;
          const keepHandsVisible = lastPoseAppliedAtMs !== null && nowMs - lastPoseAppliedAtMs < 350;
          entity.leftHand.visible = keepHandsVisible && (participant?.leftHandVisible ?? false);
          entity.rightHand.visible = keepHandsVisible && (participant?.rightHandVisible ?? false);
          if (participant && !keepHandsVisible) {
            participant.leftHandVisible = false;
            participant.rightHandVisible = false;
          }
        }
      }
      syncDebugState(debugState);
    },
    reset(debugState: RemoteAvatarDebugState): void {
      for (const mesh of remoteAvatars.values()) {
        input.scene.remove(mesh.body, mesh.head, mesh.leftHand, mesh.rightHand);
      }
      remoteAvatars.clear();
      remoteMotionTracks.clear();
      remoteAvatarParticipants.clear();
      syncDebugState(debugState);
    },
    getParticipantModel(participantId: string): RemoteAvatarParticipantModel | null {
      return remoteAvatarParticipants.get(participantId) ?? null;
    }
  };
}
