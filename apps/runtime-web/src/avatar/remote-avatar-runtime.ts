import * as THREE from "three";

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
}

interface RemoteAvatarParticipantModel {
  participantId: string;
  reliableState: RemoteAvatarReliableStateView | null;
  poseFrame: RemoteAvatarPoseFrameView | null;
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
        reliableState: null,
        poseFrame: null
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
      ensureParticipantModel(participantId).poseFrame = {
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
      const renderAtMs = Date.now() - 120;
      for (const [participantId, entity] of remoteAvatars.entries()) {
        const tracks = remoteMotionTracks.get(participantId);
        if (!tracks) continue;
        const bodySample = sampleMotion(tracks.body, renderAtMs);
        const headSample = sampleMotion(tracks.head, renderAtMs);
        if (!bodySample || !headSample) continue;
        entity.body.position.set(bodySample.x, 0.92, bodySample.z);
        entity.head.position.set(headSample.x, 1.58, headSample.z);
        entity.body.lookAt(headSample.x, 0.92, headSample.z);
        const participant = remoteAvatarParticipants.get(participantId);
        const reliableState = participant?.reliableState ?? null;
        const poseFrame = participant?.poseFrame?.frame ?? null;
        const bodyMaterial = entity.body.material;
        if (bodyMaterial instanceof THREE.MeshStandardMaterial) {
          const color = reliableState?.inputMode === "mobile" ? 0xffc857 : reliableState?.inputMode === "vr-controller" || reliableState?.inputMode === "vr-hand" ? 0x8be9fd : reliableState?.audioActive ? 0x5fc8ff : 0xbfd8ee;
          bodyMaterial.color.setHex(color);
        }
        if (poseFrame) {
          entity.head.position.set(poseFrame.head.x, poseFrame.head.y, poseFrame.head.z);
          entity.leftHand.position.set(poseFrame.leftHand.x, poseFrame.leftHand.y, poseFrame.leftHand.z);
          entity.rightHand.position.set(poseFrame.rightHand.x, poseFrame.rightHand.y, poseFrame.rightHand.z);
          entity.leftHand.visible = poseFrame.leftHand.gesture > 0;
          entity.rightHand.visible = poseFrame.rightHand.gesture > 0;
        } else {
          entity.leftHand.visible = false;
          entity.rightHand.visible = false;
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
