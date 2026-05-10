import * as THREE from "three";

import { applyProceduralMouthState, createProceduralAvatarHead } from "./avatar-instance.js";
import type { AvatarLipsyncSourceState, AvatarLipsyncState } from "./avatar-lipsync.js";
import { createAvatarPoseBuffer, pushAvatarPoseFrame, pruneAvatarPoseBuffer, sampleAvatarPoseBuffer, type AvatarPoseBuffer } from "./avatar-pose-buffer.js";
import { createMotionTrack, pushMotionSample, sampleMotion, type MotionTrack } from "../motion-state.js";
import type { PresenceState } from "../index.js";
import type { CompactPoseFrame } from "./avatar-types.js";
import { normalizePoseTransform } from "../pose.js";

export interface RemoteAvatarReliableStateView {
  participantId: string;
  avatarId: string;
  inputMode: string;
  updatedAt: string;
  audioActive: boolean;
  seated: boolean;
  seatId?: string;
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
  remoteParticipants: Array<{
    participantId: string;
    mode: PresenceState["mode"];
    root: { x: number; y: number; z: number; yaw: number };
    head: { x: number; y: number; z: number; yaw: number; pitch: number };
    lastSeq: number;
    staleMs: number;
    updateHz: number;
    interpolationDelayMs: number;
    maxObservedJumpM: number;
    muted: boolean;
    activeAudio: boolean;
    hasVisualEntity: boolean;
    hasAudioNode: boolean;
    appliedRootYaw: number;
    appliedHeadYaw: number;
  }>;
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
    mouthAmount: number;
    speakingActive: boolean;
    lipsyncSourceState: AvatarLipsyncSourceState | null;
  }>;
}

interface RemoteAvatarParticipantModel {
  participantId: string;
  presenceSeen: boolean;
  reliableState: RemoteAvatarReliableStateView | null;
  poseFrame: RemoteAvatarPoseFrameView | null;
  presenceState: PresenceState | null;
  poseBuffer: AvatarPoseBuffer;
  leftHandVisible: boolean;
  rightHandVisible: boolean;
  lastPoseAppliedAtMs: number | null;
  presenceUpdateTimesMs: number[];
  maxObservedJumpM: number;
  lastPresenceRoot: { x: number; y: number; z: number } | null;
  lipsync: AvatarLipsyncState;
}

interface RemoteAvatarEntity {
  body: THREE.Mesh;
  head: THREE.Mesh;
  mouth: THREE.Mesh;
  leftHand: THREE.Mesh;
  rightHand: THREE.Mesh;
  direction: THREE.Mesh;
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

function makeHeadVisual(headGeometry: THREE.BufferGeometry, color: number): { head: THREE.Mesh; mouth: THREE.Mesh } {
  const headVisual = createProceduralAvatarHead({
    skinColor: color,
    accentColor: 0x4f6a8a
  });
  headVisual.head.geometry.dispose();
  headVisual.head.geometry = headGeometry;
  const headMaterial = headVisual.head.material;
  if (headMaterial instanceof THREE.MeshStandardMaterial) {
    headMaterial.roughness = 0.3;
    headMaterial.metalness = 0.05;
  }
  return {
    head: headVisual.head,
    mouth: headVisual.mouth
  };
}

function makeHand(color: number): THREE.Mesh {
  return new THREE.Mesh(
    new THREE.SphereGeometry(0.09, 16, 16),
    new THREE.MeshStandardMaterial({ color, roughness: 0.35, metalness: 0.04 })
  );
}

function makeDirectionIndicator(): THREE.Mesh {
  return new THREE.Mesh(
    new THREE.BoxGeometry(0.04, 0.04, 0.45),
    new THREE.MeshStandardMaterial({ color: 0x9cff8f, roughness: 0.4, metalness: 0.02 })
  );
}

function roundNumber(value: number, decimals = 3): number {
  const scale = 10 ** decimals;
  return Math.round(value * scale) / scale;
}

function distance3(a: { x: number; y: number; z: number }, b: { x: number; y: number; z: number }): number {
  return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
}

function lerpPosePoint(a: { x: number; y: number; z: number }, b: { x: number; y: number; z: number }, alpha: number): { x: number; y: number; z: number } {
  return {
    x: THREE.MathUtils.lerp(a.x, b.x, alpha),
    y: THREE.MathUtils.lerp(a.y, b.y, alpha),
    z: THREE.MathUtils.lerp(a.z, b.z, alpha)
  };
}

function lerpAngleRadians(current: number, target: number, alpha: number): number {
  const delta = Math.atan2(Math.sin(target - current), Math.cos(target - current));
  return current + delta * alpha;
}

function yawFromQuaternion(rotation: { qx: number; qy: number; qz: number; qw: number }): number {
  const sinyCosp = 2 * (rotation.qw * rotation.qy + rotation.qx * rotation.qz);
  const cosyCosp = 1 - 2 * (rotation.qy * rotation.qy + rotation.qz * rotation.qz);
  return Math.atan2(sinyCosp, cosyCosp);
}

function eulerFromQuaternion(rotation: { qx: number; qy: number; qz: number; qw: number }): { yaw: number; pitch: number } {
  const euler = new THREE.Euler(0, 0, 0, "YXZ");
  euler.setFromQuaternion(new THREE.Quaternion(rotation.qx, rotation.qy, rotation.qz, rotation.qw), "YXZ");
  return {
    yaw: euler.y,
    pitch: euler.x
  };
}

function updateDirectionIndicator(entity: RemoteAvatarEntity, yaw: number, pitch: number): void {
  const forward = new THREE.Vector3(Math.sin(yaw), -Math.sin(pitch), Math.cos(yaw)).normalize();
  entity.direction.position.copy(entity.head.position).addScaledVector(forward, 0.34);
  entity.direction.rotation.set(pitch, yaw, 0);
  entity.direction.visible = entity.head.visible;
}

function computeUpdateHz(updateTimesMs: number[], nowMs: number): number {
  while (updateTimesMs.length > 0 && nowMs - updateTimesMs[0]! > 5000) {
    updateTimesMs.shift();
  }
  if (updateTimesMs.length < 2) {
    return 0;
  }
  const spanMs = updateTimesMs[updateTimesMs.length - 1]! - updateTimesMs[0]!;
  if (spanMs <= 0) {
    return 0;
  }
  return (updateTimesMs.length - 1) / (spanMs / 1000);
}

function resolvePlaybackDelayMs(recommendedPlaybackDelayMs: number, inputMode: string | null | undefined): number {
  if (inputMode === "desktop") {
    return Math.max(130, recommendedPlaybackDelayMs);
  }
  return recommendedPlaybackDelayMs;
}

function resolveRemoteBodyY(inputMode: string | null | undefined): number {
  return inputMode === "vr-controller" || inputMode === "vr-hand" ? 0.76 : 0.92;
}

function resolveRemoteBodyWorldY(rootY: number, inputMode: string | null | undefined): number {
  return rootY + resolveRemoteBodyY(inputMode);
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
  if (sample.previous && latest.sentAtMs > sample.previous.sentAtMs && renderAtMs > latest.sentAtMs) {
    const intervalMs = latest.sentAtMs - sample.previous.sentAtMs;
    const extrapolationAlpha = THREE.MathUtils.clamp((renderAtMs - latest.sentAtMs) / intervalMs, 0, 1) * 0.7;
    const extrapolatePoint = (
      previous: { x: number; y: number; z: number },
      next: { x: number; y: number; z: number }
    ): { x: number; y: number; z: number } => ({
      x: next.x + (next.x - previous.x) * extrapolationAlpha,
      y: next.y + (next.y - previous.y) * extrapolationAlpha,
      z: next.z + (next.z - previous.z) * extrapolationAlpha
    });
    return {
      ...latest,
      sentAtMs: renderAtMs,
      root: {
        ...latest.root,
        ...extrapolatePoint(sample.previous.root, latest.root),
        yaw: latest.root.yaw + (latest.root.yaw - sample.previous.root.yaw) * extrapolationAlpha,
        vx: latest.root.vx + (latest.root.vx - sample.previous.root.vx) * extrapolationAlpha,
        vz: latest.root.vz + (latest.root.vz - sample.previous.root.vz) * extrapolationAlpha
      },
      head: {
        ...latest.head,
        ...extrapolatePoint(sample.previous.head, latest.head)
      },
      leftHand: {
        ...latest.leftHand,
        ...extrapolatePoint(sample.previous.leftHand, latest.leftHand),
        gesture: latest.leftHand.gesture
      },
      rightHand: {
        ...latest.rightHand,
        ...extrapolatePoint(sample.previous.rightHand, latest.rightHand),
        gesture: latest.rightHand.gesture
      },
      locomotion: {
        mode: latest.locomotion.mode,
        speed: latest.locomotion.speed + (latest.locomotion.speed - sample.previous.locomotion.speed) * extrapolationAlpha,
        angularVelocity: latest.locomotion.angularVelocity + (latest.locomotion.angularVelocity - sample.previous.locomotion.angularVelocity) * extrapolationAlpha
      }
    };
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
        presenceState: null,
        poseBuffer: createAvatarPoseBuffer(),
        leftHandVisible: false,
        rightHandVisible: false,
        lastPoseAppliedAtMs: null,
        presenceUpdateTimesMs: [],
        maxObservedJumpM: 0,
        lastPresenceRoot: null,
        lipsync: {
          mouthAmount: 0,
          speakingActive: false,
          sourceState: "idle"
        }
      };
      remoteAvatarParticipants.set(participantId, model);
    }
    return model;
  }

  function ensureRemoteAvatar(participant: PresenceState): RemoteAvatarEntity {
    let entity = remoteAvatars.get(participant.participantId);
    if (!entity) {
      const body = makeBody(input.bodyGeometry, participant.activeMedia.audio ? 0x5fc8ff : 0xbfd8ee);
      const headVisual = makeHeadVisual(input.headGeometry, 0xf6fbff);
      const head = headVisual.head;
      const mouth = headVisual.mouth;
      const leftHand = makeHand(0xf2b3a0);
      const rightHand = makeHand(0xf2b3a0);
      const direction = makeDirectionIndicator();
      input.scene.add(body, head, leftHand, rightHand, direction);
      entity = { body, head, mouth, leftHand, rightHand, direction };
      remoteAvatars.set(participant.participantId, entity);
      const root = normalizePoseTransform(participant.rootTransform);
      const bodyTransform = normalizePoseTransform(participant.bodyTransform, { x: root.x, y: 0.92, z: root.z, yaw: root.yaw });
      const headTransform = normalizePoseTransform(participant.headTransform, { x: root.x, y: 1.58, z: root.z, yaw: root.yaw, pitch: 0 });
      remoteMotionTracks.set(participant.participantId, {
        root: pushMotionSample(createMotionTrack(), { x: root.x, z: root.z, yaw: root.yaw, capturedAtMs: getPresenceCaptureTime(participant.updatedAt, Date.now()) }),
        body: pushMotionSample(createMotionTrack(), { x: bodyTransform.x, z: bodyTransform.z, yaw: bodyTransform.yaw, capturedAtMs: getPresenceCaptureTime(participant.updatedAt, Date.now()) }),
        head: pushMotionSample(createMotionTrack(), { x: headTransform.x, z: headTransform.z, yaw: headTransform.yaw, pitch: headTransform.pitch, capturedAtMs: getPresenceCaptureTime(participant.updatedAt, Date.now()) })
      });
    }
    return entity;
  }

  function syncDebugState(debugState: RemoteAvatarDebugState): void {
    const nowMs = Date.now();
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
    debugState.remoteParticipants = Array.from(remoteAvatarParticipants.values())
      .filter((participant) => participant.presenceState !== null || remoteAvatars.has(participant.participantId))
      .sort((a, b) => a.participantId.localeCompare(b.participantId))
      .map((participant) => {
        const entity = remoteAvatars.get(participant.participantId);
        const presence = participant.presenceState;
        const root = normalizePoseTransform(presence?.rootTransform);
        const head = normalizePoseTransform(presence?.headTransform, {
          x: root.x,
          y: 1.58,
          z: root.z,
          yaw: root.yaw,
          pitch: 0
        });
        const poseFrame = participant.poseFrame?.frame ?? null;
        const poseHead = poseFrame ? eulerFromQuaternion(poseFrame.head) : null;
        const debugRoot = poseFrame
          ? { x: poseFrame.root.x, y: poseFrame.root.y, z: poseFrame.root.z, yaw: poseFrame.root.yaw }
          : root;
        const debugHead = poseFrame && poseHead
          ? { x: poseFrame.head.x, y: poseFrame.head.y, z: poseFrame.head.z, yaw: poseHead.yaw, pitch: poseHead.pitch }
          : head;
        const playbackDelayMs = resolvePlaybackDelayMs(participant.poseBuffer.recommendedPlaybackDelayMs, participant.reliableState?.inputMode ?? null);
        const captureTimeMs = presence ? getPresenceCaptureTime(presence.updatedAt, nowMs) : participant.poseFrame?.sentAtMs ?? nowMs;
        return {
          participantId: participant.participantId,
          mode: presence?.mode ?? "desktop",
          root: {
            x: roundNumber(debugRoot.x),
            y: roundNumber(debugRoot.y),
            z: roundNumber(debugRoot.z),
            yaw: roundNumber(debugRoot.yaw)
          },
          head: {
            x: roundNumber(debugHead.x),
            y: roundNumber(debugHead.y),
            z: roundNumber(debugHead.z),
            yaw: roundNumber(debugHead.yaw),
            pitch: roundNumber(debugHead.pitch)
          },
          lastSeq: Math.max(presence?.seq ?? 0, participant.poseBuffer.lastSeq ?? 0),
          staleMs: Math.max(0, nowMs - captureTimeMs),
          updateHz: roundNumber(computeUpdateHz(participant.presenceUpdateTimesMs, nowMs), 2),
          interpolationDelayMs: playbackDelayMs,
          maxObservedJumpM: roundNumber(participant.maxObservedJumpM),
          muted: presence?.muted ?? participant.reliableState?.audioActive === false,
          activeAudio: presence?.activeMedia.audio ?? participant.reliableState?.audioActive ?? false,
          hasVisualEntity: Boolean(entity),
          hasAudioNode: false,
          appliedRootYaw: roundNumber(entity?.body.rotation.y ?? root.yaw),
          appliedHeadYaw: roundNumber(entity?.head.rotation.y ?? head.yaw)
        };
      });
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
          playbackDelayMs: resolvePlaybackDelayMs(participant.poseBuffer.recommendedPlaybackDelayMs, participant.reliableState?.inputMode ?? null),
          mouthAmount: Number(participant.lipsync.mouthAmount.toFixed(3)),
          speakingActive: participant.lipsync.speakingActive,
          lipsyncSourceState: participant.lipsync.sourceState
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
        const model = ensureParticipantModel(person.participantId);
        const previousPresence = model.presenceState;
        model.presenceSeen = true;
        model.presenceState = person;
        const entity = ensureRemoteAvatar(person);
        const bodyMaterial = entity.body.material;
        if (bodyMaterial instanceof THREE.MeshStandardMaterial) {
          bodyMaterial.color.setHex(person.activeMedia.audio ? 0x5fc8ff : 0xbfd8ee);
        }
        const current = remoteMotionTracks.get(person.participantId) ?? { root: createMotionTrack(), body: createMotionTrack(), head: createMotionTrack() };
        const capturedAtMs = getPresenceCaptureTime(person.updatedAt, Date.now());
        if (model.presenceUpdateTimesMs[model.presenceUpdateTimesMs.length - 1] !== capturedAtMs) {
          model.presenceUpdateTimesMs.push(capturedAtMs);
        }
        const root = normalizePoseTransform(person.rootTransform);
        const bodyTransform = normalizePoseTransform(person.bodyTransform, { x: root.x, y: 0.92, z: root.z, yaw: root.yaw });
        const headTransform = normalizePoseTransform(person.headTransform, { x: root.x, y: 1.58, z: root.z, yaw: root.yaw, pitch: 0 });
        const nextRoot = { x: root.x, y: root.y, z: root.z };
        if (model.lastPresenceRoot && (previousPresence?.seq ?? 0) > 0 && (person.seq ?? 0) > 0) {
          model.maxObservedJumpM = Math.max(model.maxObservedJumpM, distance3(model.lastPresenceRoot, nextRoot));
        }
        model.lastPresenceRoot = nextRoot;
        remoteMotionTracks.set(person.participantId, {
          root: pushMotionSample(current.root, { x: root.x, z: root.z, yaw: root.yaw, capturedAtMs }),
          body: pushMotionSample(current.body, { x: bodyTransform.x, z: bodyTransform.z, yaw: bodyTransform.yaw, capturedAtMs }),
          head: pushMotionSample(current.head, { x: headTransform.x, z: headTransform.z, yaw: headTransform.yaw, pitch: headTransform.pitch, capturedAtMs })
        });
        if (entity.body.position.lengthSq() === 0) {
          entity.body.position.set(bodyTransform.x, bodyTransform.y, bodyTransform.z);
          entity.head.position.set(headTransform.x, headTransform.y, headTransform.z);
          entity.body.rotation.y = bodyTransform.yaw;
          entity.head.rotation.y = headTransform.yaw;
          entity.head.rotation.x = headTransform.pitch;
          updateDirectionIndicator(entity, headTransform.yaw, headTransform.pitch);
        }
      }
      for (const [id, mesh] of remoteAvatars.entries()) {
        if (!activeIds.has(id)) {
          input.scene.remove(mesh.body, mesh.head, mesh.leftHand, mesh.rightHand, mesh.direction);
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
    setParticipantLipsync(participantId: string, lipsync: AvatarLipsyncState, debugState: RemoteAvatarDebugState): void {
      if (participantId === input.localParticipantId) return;
      const participant = ensureParticipantModel(participantId);
      participant.lipsync = lipsync;
      syncDebugState(debugState);
    },
    update(delta: number, debugState: RemoteAvatarDebugState): void {
      void delta;
      const nowMs = Date.now();
      for (const [participantId, entity] of remoteAvatars.entries()) {
        const tracks = remoteMotionTracks.get(participantId);
        if (!tracks) continue;
        const participant = remoteAvatarParticipants.get(participantId);
        const playbackDelayMs = resolvePlaybackDelayMs(
          participant?.poseBuffer.recommendedPlaybackDelayMs ?? 100,
          participant?.reliableState?.inputMode ?? null
        );
        const renderAtMs = nowMs - playbackDelayMs;
        const bodySample = sampleMotion(tracks.body, renderAtMs);
        const headSample = sampleMotion(tracks.head, renderAtMs);
        const rootSample = sampleMotion(tracks.root, renderAtMs);
        const reliableState = participant?.reliableState ?? null;
        const lipsync = participant?.lipsync ?? { mouthAmount: 0, speakingActive: false, sourceState: "idle" as const };
        const bodyYOffset = resolveRemoteBodyY(reliableState?.inputMode ?? null);
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
          bodyMaterial.emissive.setHex(lipsync.speakingActive ? 0x193247 : 0x000000);
          bodyMaterial.emissiveIntensity = lipsync.speakingActive ? 0.35 : 0;
        }
        applyProceduralMouthState(entity.mouth, lipsync.mouthAmount);
        entity.mouth.visible = true;
        if (poseFrame) {
          entity.body.position.lerp(
            new THREE.Vector3(poseFrame.root.x, resolveRemoteBodyWorldY(poseFrame.root.y, reliableState?.inputMode ?? null), poseFrame.root.z),
            0.35
          );
          entity.head.position.lerp(new THREE.Vector3(poseFrame.head.x, poseFrame.head.y, poseFrame.head.z), 0.45);
          entity.leftHand.position.lerp(new THREE.Vector3(poseFrame.leftHand.x, poseFrame.leftHand.y, poseFrame.leftHand.z), 0.45);
          entity.rightHand.position.lerp(new THREE.Vector3(poseFrame.rightHand.x, poseFrame.rightHand.y, poseFrame.rightHand.z), 0.45);
          entity.body.rotation.y = lerpAngleRadians(entity.body.rotation.y, poseFrame.root.yaw, 0.35);
          const headEuler = eulerFromQuaternion(poseFrame.head);
          entity.head.rotation.y = lerpAngleRadians(entity.head.rotation.y, headEuler.yaw, 0.45);
          entity.head.rotation.x = lerpAngleRadians(entity.head.rotation.x, headEuler.pitch, 0.45);
          entity.head.rotation.z = 0;
          entity.body.rotation.x = 0;
          entity.body.rotation.z = 0;
          updateDirectionIndicator(entity, entity.head.rotation.y, entity.head.rotation.x);
          const forceVrHandsVisible = reliableState?.inputMode === "vr-controller" || reliableState?.inputMode === "vr-hand";
          entity.leftHand.visible = forceVrHandsVisible || poseFrame.leftHand.gesture > 0;
          entity.rightHand.visible = forceVrHandsVisible || poseFrame.rightHand.gesture > 0;
          if (participant) {
            participant.leftHandVisible = entity.leftHand.visible;
            participant.rightHandVisible = entity.rightHand.visible;
            participant.lastPoseAppliedAtMs = nowMs;
          }
        } else {
          if (bodySample && headSample) {
            const fallbackBodyY = participant ? participant.poseFrame?.frame.root.y ?? entity.body.position.y : entity.body.position.y;
            entity.body.position.lerp(
              new THREE.Vector3(bodySample.x, resolveRemoteBodyWorldY(fallbackBodyY, reliableState?.inputMode ?? null), bodySample.z),
              0.2
            );
            entity.head.position.lerp(new THREE.Vector3(headSample.x, 1.58, headSample.z), 0.25);
            entity.body.rotation.x = 0;
            entity.body.rotation.z = 0;
            const fallbackBodyYaw = rootSample?.yaw ?? bodySample.yaw ?? Math.atan2(headSample.x - bodySample.x, headSample.z - bodySample.z);
            entity.body.rotation.y = lerpAngleRadians(
              entity.body.rotation.y,
              fallbackBodyYaw,
              0.25
            );
            entity.head.rotation.y = lerpAngleRadians(entity.head.rotation.y, headSample.yaw ?? fallbackBodyYaw, 0.25);
            entity.head.rotation.x = lerpAngleRadians(entity.head.rotation.x, headSample.pitch ?? 0, 0.25);
            entity.head.rotation.z = 0;
            updateDirectionIndicator(entity, entity.head.rotation.y, entity.head.rotation.x);
          }
          entity.leftHand.visible = participant?.leftHandVisible ?? false;
          entity.rightHand.visible = participant?.rightHandVisible ?? false;
        }
      }
      syncDebugState(debugState);
    },
    reset(debugState: RemoteAvatarDebugState): void {
      for (const mesh of remoteAvatars.values()) {
        input.scene.remove(mesh.body, mesh.head, mesh.leftHand, mesh.rightHand, mesh.direction);
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
