import {
  DEFAULT_MEDIA_SURFACE_ID,
  SURFACE_TEST_CARD_TYPE,
  createDefaultRoomMediaObjectsState,
  getRoomPermissions,
  hasRoomPermission,
  parseRoomRole,
  type MediaObjectCommandBlockedReason,
  type MediaObjectCommandResult,
  type MediaObjectInstance,
  type RoomMediaObjectsState,
  type RoomPermission,
  type RoomRole,
  type SurfaceTestCardPatch,
  type SurfaceTestCardState
} from "@noah/shared-types";

import type { PresenceState, TransformState } from "./schema.js";

export type ParticipantState = PresenceState;

export type SeatOccupancyState = Record<string, string>;

export interface RoomState {
  roomId: string;
  participants: ParticipantState[];
  seatOccupancy: SeatOccupancyState;
  mediaObjects: RoomMediaObjectsState;
}

export interface SeatClaimResult {
  room: RoomState;
  accepted: boolean;
  seatId: string;
  occupantId: string | null;
  previousSeatId: string | null;
}

export interface SeatReleaseResult {
  room: RoomState;
  releasedSeatId: string | null;
}

export interface ParticipantAccessState {
  role: RoomRole;
  permissions?: RoomPermission[];
}

export interface CreateMediaObjectInput {
  commandId: string;
  surfaceId: string;
  objectType: string;
  objectId: string;
  nowMs: number;
}

export interface StopMediaObjectInput {
  commandId: string;
  surfaceId: string;
  objectId: string;
}

export interface PatchMediaObjectInput {
  commandId: string;
  surfaceId: string;
  objectId: string;
  expectedRevision: number;
  patch: unknown;
  nowMs: number;
}

export interface MediaObjectMutationResult {
  room: RoomState;
  result: MediaObjectCommandResult;
}

function mergeTransformState(current: TransformState | undefined, next: TransformState | undefined): TransformState | undefined {
  if (!current && !next) {
    return undefined;
  }
  if (!next) {
    return current ? { ...current } : undefined;
  }
  return {
    x: next?.x ?? current?.x ?? 0,
    y: next?.y ?? current?.y ?? 0,
    z: next?.z ?? current?.z ?? 0,
    yaw: next?.yaw ?? current?.yaw ?? 0,
    pitch: next?.pitch ?? current?.pitch ?? 0,
    roll: next?.roll ?? current?.roll ?? 0
  };
}

function applyParticipantAccess(participant: ParticipantState, access?: ParticipantAccessState): ParticipantState {
  const role = parseRoomRole(access?.role, participant.role ?? "guest");
  return {
    ...participant,
    role,
    permissions: getRoomPermissions(role)
  };
}

export function createParticipantState(participantId: string, access?: ParticipantAccessState): ParticipantState {
  const role = parseRoomRole(access?.role, "guest");
  return {
    participantId,
    displayName: participantId,
    role,
    permissions: getRoomPermissions(role),
    mode: "desktop",
    rootTransform: { x: 0, y: 0, z: 0, yaw: 0 },
    bodyTransform: { x: 0, y: 0.92, z: 0, yaw: 0 },
    headTransform: { x: 0, y: 1.58, z: 0, yaw: 0, pitch: 0 },
    muted: true,
    activeMedia: {
      audio: false,
      screenShare: false
    },
    seq: 0,
    clientTimeMs: 0,
    updatedAt: new Date(0).toISOString()
  };
}

export function mergeParticipantState(current: ParticipantState, nextState: Partial<ParticipantState>): ParticipantState {
  if (typeof nextState.seq === "number" && typeof current.seq === "number" && nextState.seq < current.seq) {
    return current;
  }

  return {
    participantId: current.participantId,
    displayName: nextState.displayName ?? current.displayName,
    role: current.role,
    permissions: [...current.permissions],
    mode: nextState.mode ?? current.mode,
    rootTransform: mergeTransformState(current.rootTransform, nextState.rootTransform) ?? current.rootTransform,
    bodyTransform: mergeTransformState(current.bodyTransform, nextState.bodyTransform),
    headTransform: mergeTransformState(current.headTransform, nextState.headTransform),
    muted: nextState.muted ?? current.muted,
    activeMedia: {
      audio: nextState.activeMedia?.audio ?? current.activeMedia.audio,
      screenShare: nextState.activeMedia?.screenShare ?? current.activeMedia.screenShare
    },
    seq: nextState.seq ?? current.seq,
    clientTimeMs: nextState.clientTimeMs ?? current.clientTimeMs,
    serverTimeMs: nextState.serverTimeMs ?? current.serverTimeMs,
    updatedAt: nextState.updatedAt ?? current.updatedAt
  };
}

export function createRoomState(roomId: string): RoomState {
  return {
    roomId,
    participants: [],
    seatOccupancy: {},
    mediaObjects: createDefaultRoomMediaObjectsState(roomId)
  };
}

function cloneObjectState<State>(state: State): State {
  if (!state || typeof state !== "object" || Array.isArray(state)) {
    return state;
  }
  return { ...(state as Record<string, unknown>) } as State;
}

function cloneMediaObjectsState(mediaObjects: RoomMediaObjectsState): RoomMediaObjectsState {
  return {
    surfaces: Object.fromEntries(Object.entries(mediaObjects.surfaces).map(([surfaceId, surface]) => [surfaceId, { ...surface, allowedObjectTypes: [...surface.allowedObjectTypes] }])),
    objects: Object.fromEntries(Object.entries(mediaObjects.objects).map(([objectId, object]) => [objectId, { ...object, state: cloneObjectState(object.state) }]))
  };
}

function ensureMediaObjectsState(state: RoomState): RoomMediaObjectsState {
  const current = state.mediaObjects ?? createDefaultRoomMediaObjectsState(state.roomId);
  if (current.surfaces[DEFAULT_MEDIA_SURFACE_ID]) {
    return cloneMediaObjectsState(current);
  }
  const defaults = createDefaultRoomMediaObjectsState(state.roomId);
  return cloneMediaObjectsState({
    surfaces: { ...defaults.surfaces, ...current.surfaces },
    objects: current.objects ?? {}
  });
}

function createSurfaceTestCardState(): SurfaceTestCardState {
  return {
    clickCount: 0,
    lastInputEventId: null
  };
}

function isSurfaceTestCardPatch(input: unknown): input is SurfaceTestCardPatch {
  return Boolean(input)
    && typeof input === "object"
    && (input as { type?: unknown }).type === "increment-click-count"
    && typeof (input as { inputEventId?: unknown }).inputEventId === "string"
    && (input as { inputEventId: string }).inputEventId.trim().length > 0;
}

function getParticipantAccess(state: RoomState, participantId: string): { role: RoomRole; permissions: RoomPermission[] } {
  const participant = state.participants.find((item) => item.participantId === participantId);
  const role = participant?.role ?? "guest";
  return {
    role,
    permissions: participant?.permissions ?? getRoomPermissions(role)
  };
}

function createMediaObjectCommandResult(input: {
  accepted: boolean;
  commandId: string;
  role: RoomRole;
  permission: RoomPermission;
  blockedReason: MediaObjectCommandBlockedReason | null;
  surfaceId?: string | null;
  objectId?: string | null;
  objectType?: string | null;
  revision?: number | null;
}): MediaObjectCommandResult {
  return {
    accepted: input.accepted,
    commandId: input.commandId,
    role: input.role,
    permission: input.permission,
    blockedReason: input.blockedReason,
    surfaceId: input.surfaceId ?? null,
    objectId: input.objectId ?? null,
    objectType: input.objectType ?? null,
    revision: input.revision ?? null
  };
}

function rejectMediaObjectCommand(state: RoomState, input: {
  commandId: string;
  role: RoomRole;
  permission: RoomPermission;
  blockedReason: MediaObjectCommandBlockedReason;
  surfaceId?: string | null;
  objectId?: string | null;
  objectType?: string | null;
  revision?: number | null;
}): MediaObjectMutationResult {
  return {
    room: state,
    result: createMediaObjectCommandResult({
      accepted: false,
      ...input
    })
  };
}

export function createMediaObject(state: RoomState, participantId: string, input: CreateMediaObjectInput): MediaObjectMutationResult {
  const access = getParticipantAccess(state, participantId);
  const permission: RoomPermission = "surface.create-object";
  if (!hasRoomPermission(access.permissions, permission)) {
    return rejectMediaObjectCommand(state, { commandId: input.commandId, role: access.role, permission, blockedReason: "missing-permission", surfaceId: input.surfaceId, objectType: input.objectType });
  }

  const mediaObjects = ensureMediaObjectsState(state);
  const surface = mediaObjects.surfaces[input.surfaceId];
  if (!surface) {
    return rejectMediaObjectCommand(state, { commandId: input.commandId, role: access.role, permission, blockedReason: "missing-surface", surfaceId: input.surfaceId, objectType: input.objectType });
  }
  if (input.objectType !== SURFACE_TEST_CARD_TYPE) {
    return rejectMediaObjectCommand(state, { commandId: input.commandId, role: access.role, permission, blockedReason: "unknown-object-type", surfaceId: input.surfaceId, objectType: input.objectType });
  }
  if (!surface.allowedObjectTypes.includes(input.objectType)) {
    return rejectMediaObjectCommand(state, { commandId: input.commandId, role: access.role, permission, blockedReason: "unknown-object-type", surfaceId: input.surfaceId, objectType: input.objectType });
  }
  if (surface.activeObjectId) {
    return rejectMediaObjectCommand(state, { commandId: input.commandId, role: access.role, permission, blockedReason: "surface-occupied", surfaceId: input.surfaceId, objectId: surface.activeObjectId, objectType: input.objectType });
  }

  const object: MediaObjectInstance<SurfaceTestCardState> = {
    objectId: input.objectId,
    type: input.objectType,
    roomId: state.roomId,
    surfaceId: input.surfaceId,
    ownerParticipantId: participantId,
    state: createSurfaceTestCardState(),
    status: "active",
    revision: 0,
    createdAtMs: input.nowMs,
    updatedAtMs: input.nowMs
  };
  const nextMediaObjects: RoomMediaObjectsState = {
    surfaces: {
      ...mediaObjects.surfaces,
      [input.surfaceId]: {
        ...surface,
        activeObjectId: object.objectId
      }
    },
    objects: {
      ...mediaObjects.objects,
      [object.objectId]: object
    }
  };
  return {
    room: { ...state, mediaObjects: nextMediaObjects },
    result: createMediaObjectCommandResult({
      accepted: true,
      commandId: input.commandId,
      role: access.role,
      permission,
      blockedReason: null,
      surfaceId: input.surfaceId,
      objectId: object.objectId,
      objectType: object.type,
      revision: object.revision
    })
  };
}

export function stopMediaObject(state: RoomState, participantId: string, input: StopMediaObjectInput): MediaObjectMutationResult {
  const access = getParticipantAccess(state, participantId);
  const permission: RoomPermission = "surface.stop-object";
  if (!hasRoomPermission(access.permissions, permission)) {
    return rejectMediaObjectCommand(state, { commandId: input.commandId, role: access.role, permission, blockedReason: "missing-permission", surfaceId: input.surfaceId, objectId: input.objectId });
  }

  const mediaObjects = ensureMediaObjectsState(state);
  const surface = mediaObjects.surfaces[input.surfaceId];
  if (!surface) {
    return rejectMediaObjectCommand(state, { commandId: input.commandId, role: access.role, permission, blockedReason: "missing-surface", surfaceId: input.surfaceId, objectId: input.objectId });
  }
  const object = mediaObjects.objects[input.objectId];
  if (!object) {
    return rejectMediaObjectCommand(state, { commandId: input.commandId, role: access.role, permission, blockedReason: "missing-object", surfaceId: input.surfaceId, objectId: input.objectId });
  }
  if (object.surfaceId !== input.surfaceId || surface.activeObjectId !== input.objectId) {
    return rejectMediaObjectCommand(state, { commandId: input.commandId, role: access.role, permission, blockedReason: "object-surface-mismatch", surfaceId: input.surfaceId, objectId: input.objectId, objectType: object.type, revision: object.revision });
  }

  const nextObjects = { ...mediaObjects.objects };
  delete nextObjects[input.objectId];
  const nextMediaObjects: RoomMediaObjectsState = {
    surfaces: {
      ...mediaObjects.surfaces,
      [input.surfaceId]: {
        ...surface,
        activeObjectId: null
      }
    },
    objects: nextObjects
  };
  return {
    room: { ...state, mediaObjects: nextMediaObjects },
    result: createMediaObjectCommandResult({
      accepted: true,
      commandId: input.commandId,
      role: access.role,
      permission,
      blockedReason: null,
      surfaceId: input.surfaceId,
      objectId: input.objectId,
      objectType: object.type,
      revision: object.revision
    })
  };
}

export function patchMediaObjectState(state: RoomState, participantId: string, input: PatchMediaObjectInput): MediaObjectMutationResult {
  const access = getParticipantAccess(state, participantId);
  const permission: RoomPermission = "surface.input";
  if (!hasRoomPermission(access.permissions, permission)) {
    return rejectMediaObjectCommand(state, { commandId: input.commandId, role: access.role, permission, blockedReason: "missing-permission", surfaceId: input.surfaceId, objectId: input.objectId });
  }

  const mediaObjects = ensureMediaObjectsState(state);
  const surface = mediaObjects.surfaces[input.surfaceId];
  if (!surface) {
    return rejectMediaObjectCommand(state, { commandId: input.commandId, role: access.role, permission, blockedReason: "missing-surface", surfaceId: input.surfaceId, objectId: input.objectId });
  }
  const object = mediaObjects.objects[input.objectId];
  if (!object) {
    return rejectMediaObjectCommand(state, { commandId: input.commandId, role: access.role, permission, blockedReason: "missing-object", surfaceId: input.surfaceId, objectId: input.objectId });
  }
  if (object.surfaceId !== input.surfaceId || surface.activeObjectId !== input.objectId) {
    return rejectMediaObjectCommand(state, { commandId: input.commandId, role: access.role, permission, blockedReason: "object-surface-mismatch", surfaceId: input.surfaceId, objectId: input.objectId, objectType: object.type, revision: object.revision });
  }
  if (object.revision !== input.expectedRevision) {
    return rejectMediaObjectCommand(state, { commandId: input.commandId, role: access.role, permission, blockedReason: "revision-mismatch", surfaceId: input.surfaceId, objectId: input.objectId, objectType: object.type, revision: object.revision });
  }
  if (object.type !== SURFACE_TEST_CARD_TYPE || !isSurfaceTestCardPatch(input.patch)) {
    return rejectMediaObjectCommand(state, { commandId: input.commandId, role: access.role, permission, blockedReason: "invalid-patch", surfaceId: input.surfaceId, objectId: input.objectId, objectType: object.type, revision: object.revision });
  }

  const currentState = object.state as SurfaceTestCardState;
  if (currentState.lastInputEventId === input.patch.inputEventId) {
    return rejectMediaObjectCommand(state, { commandId: input.commandId, role: access.role, permission, blockedReason: "duplicate-input-event", surfaceId: input.surfaceId, objectId: input.objectId, objectType: object.type, revision: object.revision });
  }

  const nextObject: MediaObjectInstance<SurfaceTestCardState> = {
    ...object,
    state: {
      clickCount: currentState.clickCount + 1,
      lastInputEventId: input.patch.inputEventId
    },
    revision: object.revision + 1,
    updatedAtMs: input.nowMs
  };
  const nextMediaObjects: RoomMediaObjectsState = {
    surfaces: mediaObjects.surfaces,
    objects: {
      ...mediaObjects.objects,
      [input.objectId]: nextObject
    }
  };
  return {
    room: { ...state, mediaObjects: nextMediaObjects },
    result: createMediaObjectCommandResult({
      accepted: true,
      commandId: input.commandId,
      role: access.role,
      permission,
      blockedReason: null,
      surfaceId: input.surfaceId,
      objectId: input.objectId,
      objectType: object.type,
      revision: nextObject.revision
    })
  };
}

export function joinRoom(state: RoomState, participantId: string, access?: ParticipantAccessState): RoomState {
  if (state.participants.some((item) => item.participantId === participantId)) {
    return {
      ...state,
      participants: state.participants.map((item) => item.participantId === participantId ? applyParticipantAccess(item, access) : item)
    };
  }
  return {
    ...state,
    participants: [...state.participants, createParticipantState(participantId, access)]
  };
}

export function leaveRoom(state: RoomState, participantId: string): RoomState {
  const nextSeatOccupancy = { ...state.seatOccupancy };
  for (const [seatId, occupantId] of Object.entries(nextSeatOccupancy)) {
    if (occupantId === participantId) {
      delete nextSeatOccupancy[seatId];
    }
  }
  return {
    ...state,
    participants: state.participants.filter((item) => item.participantId !== participantId),
    seatOccupancy: nextSeatOccupancy
  };
}

export function findParticipantSeatId(state: RoomState, participantId: string): string | null {
  for (const [seatId, occupantId] of Object.entries(state.seatOccupancy)) {
    if (occupantId === participantId) {
      return seatId;
    }
  }
  return null;
}

export function claimSeat(state: RoomState, participantId: string, seatId: string): SeatClaimResult {
  const occupantId = state.seatOccupancy[seatId] ?? null;
  const previousSeatId = findParticipantSeatId(state, participantId);
  if (occupantId && occupantId !== participantId) {
    return {
      room: state,
      accepted: false,
      seatId,
      occupantId,
      previousSeatId
    };
  }

  const nextSeatOccupancy = { ...state.seatOccupancy };
  if (previousSeatId && previousSeatId !== seatId) {
    delete nextSeatOccupancy[previousSeatId];
  }
  nextSeatOccupancy[seatId] = participantId;
  return {
    room: {
      ...state,
      seatOccupancy: nextSeatOccupancy
    },
    accepted: true,
    seatId,
    occupantId: participantId,
    previousSeatId
  };
}

export function releaseSeat(state: RoomState, participantId: string, seatId?: string): SeatReleaseResult {
  const targetSeatId = seatId ?? findParticipantSeatId(state, participantId);
  if (!targetSeatId || state.seatOccupancy[targetSeatId] !== participantId) {
    return {
      room: state,
      releasedSeatId: null
    };
  }
  const nextSeatOccupancy = { ...state.seatOccupancy };
  delete nextSeatOccupancy[targetSeatId];
  return {
    room: {
      ...state,
      seatOccupancy: nextSeatOccupancy
    },
    releasedSeatId: targetSeatId
  };
}

export function updateParticipantState(state: RoomState, nextState: Partial<ParticipantState> & { participantId: string }): RoomState {
  const current = state.participants.find((item) => item.participantId === nextState.participantId);
  const merged = mergeParticipantState(current ?? createParticipantState(nextState.participantId), nextState);

  if (!current) {
    return {
      ...state,
      participants: [...state.participants, merged]
    };
  }

  return {
    ...state,
    participants: state.participants.map((item) => item.participantId === nextState.participantId ? merged : item)
  };
}

export function serializeRoomState(state: RoomState): RoomState {
  const mediaObjects = ensureMediaObjectsState(state);
  return {
    roomId: state.roomId,
    participants: state.participants.map((item) => ({ ...item })),
    seatOccupancy: { ...state.seatOccupancy },
    mediaObjects
  };
}
