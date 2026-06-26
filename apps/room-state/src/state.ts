import {
  REMOTE_BROWSER_OBJECT_TYPE,
  SCREEN_SHARE_OBJECT_TYPE,
  WHITEBOARD_ALLOWED_COLORS,
  WHITEBOARD_ALLOWED_WIDTHS,
  WHITEBOARD_MAX_POINTS_PER_STROKE,
  WHITEBOARD_MAX_STROKES,
  createDefaultRoomMediaObjectsState,
  getMediaObjectDefinition,
  getRoomPermissions,
  hasRoomPermission,
  isMediaObjectDefinitionAvailable,
  isMediaObjectDefinitionEnabled,
  parseRoomRole,
  type MediaObjectCommandBlockedReason,
  type MediaObjectCommandResult,
  type MediaObjectInstance,
  type MediaObjectStateKind,
  type RemoteBrowserErrorCode,
  type RemoteBrowserExecutorInputState,
  type RemoteBrowserMediaSourceRect,
  type RemoteBrowserObjectState,
  type RemoteBrowserPatch,
  type RoomMediaObjectsState,
  type RoomPermission,
  type RoomRole,
  type ScreenShareErrorCode,
  type ScreenShareObjectState,
  type ScreenSharePatch,
  type SurfaceTestCardPatch,
  type SurfaceTestCardState,
  type SurfaceInputEvent,
  type WhiteboardPatch,
  type WhiteboardPoint,
  type WhiteboardState,
  type WhiteboardStroke
} from "@vrata/shared-types";

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

export interface PatchRemoteBrowserExecutorInput {
  commandId: string;
  surfaceId: string;
  objectId: string;
  executorSessionId: string;
  patch: unknown;
  nowMs: number;
}

export interface SetSurfaceMediaAudioInput {
  commandId: string;
  surfaceId: string;
  enabled: boolean;
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
    audioJoined: false,
    muted: true,
    speaking: false,
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
    audioJoined: nextState.audioJoined ?? current.audioJoined,
    muted: nextState.muted ?? current.muted,
    speaking: nextState.speaking ?? current.speaking,
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
    surfaces: Object.fromEntries(Object.entries(mediaObjects.surfaces).map(([surfaceId, surface]) => [surfaceId, {
      ...surface,
      mediaAudioEnabled: surface.mediaAudioEnabled ?? false,
      allowedObjectTypes: [...surface.allowedObjectTypes]
    }])),
    objects: Object.fromEntries(Object.entries(mediaObjects.objects).map(([objectId, object]) => [objectId, { ...object, state: cloneObjectState(object.state) }]))
  };
}

function ensureMediaObjectsState(state: RoomState): RoomMediaObjectsState {
  const current = state.mediaObjects ?? createDefaultRoomMediaObjectsState(state.roomId);
  const defaults = createDefaultRoomMediaObjectsState(state.roomId);
  const mergedSurfaces = { ...defaults.surfaces, ...current.surfaces };
  for (const [surfaceId, defaultSurface] of Object.entries(defaults.surfaces)) {
    const surface = mergedSurfaces[surfaceId] ?? defaultSurface;
    mergedSurfaces[surfaceId] = {
      ...surface,
      allowedObjectTypes: Array.from(new Set([...surface.allowedObjectTypes, ...defaultSurface.allowedObjectTypes]))
    };
  }
  return cloneMediaObjectsState({
    surfaces: mergedSurfaces,
    objects: current.objects ?? {}
  });
}

function createSurfaceTestCardState(): SurfaceTestCardState {
  return {
    clickCount: 0,
    lastInputEventId: null
  };
}

function createScreenShareState(ownerParticipantId: string, surfaceId: string): ScreenShareObjectState {
  return {
    status: "idle",
    ownerParticipantId,
    surfaceId
  };
}

function createWhiteboardState(): WhiteboardState {
  return {
    status: "active",
    strokes: [],
    revision: 0,
    lastInputEventId: null
  };
}

function createRemoteBrowserState(ownerParticipantId: string, surfaceId: string): RemoteBrowserObjectState {
  return {
    status: "idle",
    ownerParticipantId,
    surfaceId,
    lastInputEventId: null
  };
}

function createInitialMediaObjectState(stateKind: MediaObjectStateKind, ownerParticipantId: string, surfaceId: string): SurfaceTestCardState | ScreenShareObjectState | WhiteboardState | RemoteBrowserObjectState {
  if (stateKind === "screen-share") {
    return createScreenShareState(ownerParticipantId, surfaceId);
  }
  if (stateKind === "whiteboard") {
    return createWhiteboardState();
  }
  if (stateKind === "remote-browser") {
    return createRemoteBrowserState(ownerParticipantId, surfaceId);
  }
  return createSurfaceTestCardState();
}

function getAvailableMediaObjectStateKind(objectType: string): MediaObjectStateKind | null {
  const definition = getMediaObjectDefinition(objectType);
  return definition && isMediaObjectDefinitionAvailable(definition) ? definition.stateKind : null;
}

function isAllowedRemoteBrowserUrlCandidate(input: string): boolean {
  try {
    const url = new URL(input);
    return url.protocol === "https:" || url.protocol === "http:";
  } catch {
    return false;
  }
}

function isSurfaceTestCardPatch(input: unknown): input is SurfaceTestCardPatch {
  return Boolean(input)
    && typeof input === "object"
    && (input as { type?: unknown }).type === "increment-click-count"
    && typeof (input as { inputEventId?: unknown }).inputEventId === "string"
    && (input as { inputEventId: string }).inputEventId.trim().length > 0;
}

function isScreenShareErrorCode(input: unknown): input is ScreenShareErrorCode {
  return input === "display_capture_unsupported"
    || input === "display_capture_denied"
    || input === "display_capture_failed"
    || input === "media_network_blocked"
    || input === "track_unpublished"
    || input === "unknown";
}

function isScreenSharePatch(input: unknown): input is ScreenSharePatch {
  if (!input || typeof input !== "object") {
    return false;
  }
  const patch = input as { type?: unknown; mediaTrackSid?: unknown; errorCode?: unknown };
  if (patch.type === "mark-selecting" || patch.type === "mark-publishing" || patch.type === "mark-stopped") {
    return true;
  }
  if (patch.type === "mark-active") {
    return typeof patch.mediaTrackSid === "string" && patch.mediaTrackSid.trim().length > 0;
  }
  if (patch.type === "mark-failed") {
    return isScreenShareErrorCode(patch.errorCode);
  }
  return false;
}

function isRemoteBrowserErrorCode(input: unknown): input is RemoteBrowserErrorCode {
  return input === "url_not_allowed"
    || input === "url_resolution_blocked"
    || input === "redirect_not_allowed"
    || input === "executor_unavailable"
    || input === "executor_crashed"
    || input === "executor_timeout"
    || input === "navigation_failed"
    || input === "viewport_capture_unsupported"
    || input === "viewport_capture_denied"
    || input === "viewport_capture_failed"
    || input === "audio_track_missing"
    || input === "video_track_missing"
    || input === "livekit_token_failed"
    || input === "livekit_publish_failed"
    || input === "input_rejected"
    || input === "stream_failed"
    || input === "unknown";
}

function isNonEmptyString(input: unknown): input is string {
  return typeof input === "string" && input.trim().length > 0;
}

function isSurfaceInputEvent(input: unknown): input is SurfaceInputEvent {
  if (!input || typeof input !== "object") {
    return false;
  }
  const event = input as { eventId?: unknown; surfaceId?: unknown; kind?: unknown; source?: unknown; uv?: { u?: unknown; v?: unknown } };
  return typeof event.eventId === "string"
    && typeof event.surfaceId === "string"
    && typeof event.kind === "string"
    && typeof event.source === "string"
    && typeof event.uv?.u === "number"
    && Number.isFinite(event.uv.u)
    && event.uv.u >= 0
    && event.uv.u <= 1
    && typeof event.uv.v === "number"
    && Number.isFinite(event.uv.v)
    && event.uv.v >= 0
    && event.uv.v <= 1;
}

function isRemoteBrowserInputEventId(input: unknown): input is string {
  return typeof input === "string" && input.trim().length > 0;
}

function isRemoteBrowserMediaSourceRect(input: unknown): input is RemoteBrowserMediaSourceRect {
  if (!input || typeof input !== "object") {
    return false;
  }
  const rect = input as Partial<RemoteBrowserMediaSourceRect>;
  return typeof rect.x === "number"
    && Number.isFinite(rect.x)
    && typeof rect.y === "number"
    && Number.isFinite(rect.y)
    && typeof rect.width === "number"
    && Number.isFinite(rect.width)
    && rect.width > 0
    && typeof rect.height === "number"
    && Number.isFinite(rect.height)
    && rect.height > 0
    && typeof rect.viewportWidth === "number"
    && Number.isFinite(rect.viewportWidth)
    && rect.viewportWidth > 0
    && typeof rect.viewportHeight === "number"
    && Number.isFinite(rect.viewportHeight)
    && rect.viewportHeight > 0;
}

function normalizeRemoteBrowserMediaSourceRect(input: RemoteBrowserMediaSourceRect | undefined): RemoteBrowserMediaSourceRect | undefined {
  if (!input || !isRemoteBrowserMediaSourceRect(input)) {
    return undefined;
  }
  return {
    x: Number(input.x.toFixed(2)),
    y: Number(input.y.toFixed(2)),
    width: Number(input.width.toFixed(2)),
    height: Number(input.height.toFixed(2)),
    viewportWidth: Number(input.viewportWidth.toFixed(2)),
    viewportHeight: Number(input.viewportHeight.toFixed(2))
  };
}

function isRemoteBrowserExecutorInputState(input: unknown): input is RemoteBrowserExecutorInputState {
  if (!input || typeof input !== "object") {
    return false;
  }
  const state = input as Partial<RemoteBrowserExecutorInputState>;
  return isRemoteBrowserInputEventId(state.inputEventId)
    && (state.inputType === "pointer" || state.inputType === "scroll" || state.inputType === "keyboard")
    && typeof state.eventKind === "string"
    && state.eventKind.trim().length > 0
    && typeof state.x === "number"
    && Number.isFinite(state.x)
    && state.x >= 0
    && typeof state.y === "number"
    && Number.isFinite(state.y)
    && state.y >= 0
    && typeof state.receivedAtMs === "number"
    && Number.isFinite(state.receivedAtMs)
    && state.receivedAtMs >= 0
    && typeof state.appliedAtMs === "number"
    && Number.isFinite(state.appliedAtMs)
    && state.appliedAtMs >= 0
    && (state.status === "applied" || state.status === "failed")
    && typeof state.pageClosed === "boolean"
    && (state.pageUrl === undefined || typeof state.pageUrl === "string")
    && (state.targetDetail === undefined || typeof state.targetDetail === "string")
    && (state.errorDetail === undefined || typeof state.errorDetail === "string");
}

function normalizeRemoteBrowserExecutorInputState(input: RemoteBrowserExecutorInputState | undefined): RemoteBrowserExecutorInputState | undefined {
  if (!input || !isRemoteBrowserExecutorInputState(input)) {
    return undefined;
  }
  return {
    inputEventId: input.inputEventId.trim().slice(0, 200),
    inputType: input.inputType,
    eventKind: input.eventKind,
    x: Number(input.x.toFixed(2)),
    y: Number(input.y.toFixed(2)),
    receivedAtMs: Math.round(input.receivedAtMs),
    appliedAtMs: Math.round(input.appliedAtMs),
    status: input.status,
    pageUrl: input.pageUrl?.trim().slice(0, 500) || undefined,
    pageClosed: input.pageClosed,
    targetDetail: input.targetDetail?.replace(/[\r\n\t]+/g, " ").trim().slice(0, 500) || undefined,
    errorDetail: normalizeRemoteBrowserErrorDetail(input.errorDetail)
  };
}

function isRemoteBrowserPatch(input: unknown): input is RemoteBrowserPatch {
  if (!input || typeof input !== "object") {
    return false;
  }
  const patch = input as { type?: unknown; url?: unknown; event?: unknown; input?: unknown; inputEventId?: unknown; errorCode?: unknown; errorDetail?: unknown; mediaParticipantId?: unknown; mediaTrackSid?: unknown; audioTrackSid?: unknown; mediaSourceRect?: unknown };
  if (!isRemoteBrowserInputEventId(patch.inputEventId)) {
    return false;
  }
  if (patch.type === "open-url") {
    return typeof patch.url === "string" && isAllowedRemoteBrowserUrlCandidate(patch.url);
  }
  if (patch.type === "mark-publishing") {
    return isNonEmptyString(patch.mediaParticipantId);
  }
  if (patch.type === "mark-active") {
    return isNonEmptyString(patch.mediaParticipantId)
      && isNonEmptyString(patch.mediaTrackSid)
      && isNonEmptyString(patch.audioTrackSid)
      && (patch.mediaSourceRect === undefined || isRemoteBrowserMediaSourceRect(patch.mediaSourceRect));
  }
  if (patch.type === "mark-source-rect") {
    return isRemoteBrowserMediaSourceRect(patch.mediaSourceRect);
  }
  if (patch.type === "mark-input-applied") {
    return isRemoteBrowserExecutorInputState(patch.input);
  }
  if (patch.type === "mark-stopped") {
    return true;
  }
  if (patch.type === "pointer" || patch.type === "scroll" || patch.type === "keyboard") {
    return isSurfaceInputEvent(patch.event);
  }
  if (patch.type === "take-control" || patch.type === "release-control") {
    return true;
  }
  if (patch.type === "mark-failed") {
    return isRemoteBrowserErrorCode(patch.errorCode) && (patch.errorDetail === undefined || typeof patch.errorDetail === "string");
  }
  return false;
}

function normalizeRemoteBrowserErrorDetail(input: string | undefined): string | undefined {
  const normalized = input?.replace(/[\r\n\t]+/g, " ").trim().slice(0, 500);
  return normalized || undefined;
}

function isRemoteBrowserRealtimeInputPatch(input: unknown): input is Extract<RemoteBrowserPatch, { type: "pointer" | "scroll" | "keyboard" }> {
  if (!input || typeof input !== "object") {
    return false;
  }
  const patch = input as { type?: unknown };
  return patch.type === "pointer" || patch.type === "scroll" || patch.type === "keyboard";
}

function isRemoteBrowserExecutorPatch(input: unknown): input is Extract<RemoteBrowserPatch, { type: "mark-publishing" | "mark-active" | "mark-source-rect" | "mark-input-applied" | "mark-failed" | "mark-stopped" }> {
  if (!isRemoteBrowserPatch(input)) {
    return false;
  }
  return input.type === "mark-publishing" || input.type === "mark-active" || input.type === "mark-source-rect" || input.type === "mark-input-applied" || input.type === "mark-failed" || input.type === "mark-stopped";
}

function isWhiteboardColor(input: unknown): input is WhiteboardStroke["color"] {
  return typeof input === "string" && (WHITEBOARD_ALLOWED_COLORS as readonly string[]).includes(input);
}

function isWhiteboardWidth(input: unknown): input is WhiteboardStroke["width"] {
  return typeof input === "number" && (WHITEBOARD_ALLOWED_WIDTHS as readonly number[]).includes(input);
}

function normalizeWhiteboardNumber(value: number): number {
  return Number(value.toFixed(4));
}

function isValidWhiteboardPoint(input: unknown): input is WhiteboardPoint {
  if (!input || typeof input !== "object") {
    return false;
  }
  const point = input as { u?: unknown; v?: unknown; t?: unknown; pressure?: unknown };
  const validPressure = point.pressure === undefined || (typeof point.pressure === "number" && Number.isFinite(point.pressure) && point.pressure >= 0 && point.pressure <= 1);
  return typeof point.u === "number"
    && Number.isFinite(point.u)
    && point.u >= 0
    && point.u <= 1
    && typeof point.v === "number"
    && Number.isFinite(point.v)
    && point.v >= 0
    && point.v <= 1
    && typeof point.t === "number"
    && Number.isFinite(point.t)
    && validPressure;
}

function normalizeWhiteboardStroke(input: unknown, participantId: string): WhiteboardStroke | null {
  if (!input || typeof input !== "object") {
    return null;
  }
  const stroke = input as { strokeId?: unknown; tool?: unknown; color?: unknown; width?: unknown; points?: unknown };
  if (typeof stroke.strokeId !== "string" || stroke.strokeId.trim().length === 0 || stroke.tool !== "pen" || !isWhiteboardColor(stroke.color) || !isWhiteboardWidth(stroke.width) || !Array.isArray(stroke.points)) {
    return null;
  }
  if (stroke.points.length < 1 || stroke.points.length > WHITEBOARD_MAX_POINTS_PER_STROKE || !stroke.points.every(isValidWhiteboardPoint)) {
    return null;
  }
  return {
    strokeId: stroke.strokeId.trim(),
    participantId,
    tool: "pen",
    color: stroke.color,
    width: stroke.width,
    points: stroke.points.map((point) => ({
      u: normalizeWhiteboardNumber((point as WhiteboardPoint).u),
      v: normalizeWhiteboardNumber((point as WhiteboardPoint).v),
      t: Math.max(0, Math.floor((point as WhiteboardPoint).t)),
      ...((point as WhiteboardPoint).pressure === undefined ? {} : { pressure: normalizeWhiteboardNumber((point as WhiteboardPoint).pressure!) })
    }))
  };
}

function isWhiteboardInputEventId(input: unknown): input is string {
  return typeof input === "string" && input.trim().length > 0;
}

function getWhiteboardPatchPermission(input: unknown): RoomPermission | null {
  if (!input || typeof input !== "object") {
    return null;
  }
  const patch = input as { type?: unknown };
  if (patch.type === "append-stroke") {
    return "whiteboard.draw";
  }
  if (patch.type === "clear") {
    return "whiteboard.clear";
  }
  return null;
}

function getRemoteBrowserPatchPermission(input: unknown): RoomPermission | null {
  if (!input || typeof input !== "object") {
    return null;
  }
  const patch = input as { type?: unknown };
  if (patch.type === "open-url") {
    return "remote-browser.open-url";
  }
  if (patch.type === "pointer" || patch.type === "scroll" || patch.type === "keyboard" || patch.type === "take-control" || patch.type === "release-control") {
    return "remote-browser.input";
  }
  if (patch.type === "mark-publishing" || patch.type === "mark-active" || patch.type === "mark-stopped" || patch.type === "mark-failed") {
    return "remote-browser.stop";
  }
  return null;
}

function reduceWhiteboardState(state: WhiteboardState, patch: WhiteboardPatch, participantId: string): WhiteboardState | null {
  if (!isWhiteboardInputEventId(patch.inputEventId)) {
    return null;
  }
  if (state.lastInputEventId === patch.inputEventId) {
    return state;
  }
  if (patch.type === "clear") {
    return {
      ...state,
      strokes: [],
      revision: state.revision + 1,
      lastInputEventId: patch.inputEventId
    };
  }
  const stroke = normalizeWhiteboardStroke(patch.stroke, participantId);
  if (!stroke) {
    return null;
  }
  return {
    ...state,
    strokes: [...state.strokes, stroke].slice(-WHITEBOARD_MAX_STROKES),
    revision: state.revision + 1,
    lastInputEventId: patch.inputEventId
  };
}

function reduceScreenShareState(current: ScreenShareObjectState, patch: ScreenSharePatch, nowMs: number): ScreenShareObjectState {
  if (patch.type === "mark-selecting") {
    return {
      ownerParticipantId: current.ownerParticipantId,
      surfaceId: current.surfaceId,
      status: "selecting"
    };
  }
  if (patch.type === "mark-publishing") {
    return {
      ...current,
      status: "publishing",
      errorCode: undefined
    };
  }
  if (patch.type === "mark-active") {
    return {
      ...current,
      status: "active",
      mediaTrackSid: patch.mediaTrackSid.trim(),
      startedAtMs: current.startedAtMs ?? nowMs,
      stoppedAtMs: undefined,
      errorCode: undefined
    };
  }
  if (patch.type === "mark-failed") {
    return {
      ...current,
      status: "failed",
      errorCode: patch.errorCode
    };
  }
  return {
    ...current,
    status: "stopped",
    stoppedAtMs: nowMs
  };
}

function reduceRemoteBrowserState(current: RemoteBrowserObjectState, patch: RemoteBrowserPatch, participantId: string, objectId: string, nowMs: number): RemoteBrowserObjectState | null {
  if (current.lastInputEventId === patch.inputEventId) {
    return current;
  }
  if (patch.type === "take-control") {
    if (current.controllerParticipantId && current.controllerParticipantId !== participantId) {
      return null;
    }
    return {
      ...current,
      controllerParticipantId: participantId,
      lastInputEventId: patch.inputEventId
    };
  }
  if (patch.type === "release-control") {
    if (current.controllerParticipantId && current.controllerParticipantId !== participantId) {
      return null;
    }
    return {
      ...current,
      controllerParticipantId: undefined,
      lastInputEventId: patch.inputEventId
    };
  }
  if (patch.type === "open-url") {
    const executorSessionId = current.executorSessionId ?? `remote-browser:${objectId}`;
    const mediaParticipantId = current.mediaParticipantId ?? executorSessionId;
    return {
      ...current,
      status: "loading",
      controllerParticipantId: current.controllerParticipantId ?? participantId,
      executorSessionId,
      mediaParticipantId,
      mediaTrackSid: undefined,
      audioTrackSid: undefined,
      mediaSourceRect: undefined,
      currentUrl: patch.url,
      errorCode: undefined,
      streamErrorCode: undefined,
      errorDetail: undefined,
      lastExecutorInput: undefined,
      loadedAtMs: undefined,
      streamStartedAtMs: undefined,
      streamUpdatedAtMs: undefined,
      stoppedAtMs: undefined,
      lastInputEventId: patch.inputEventId
    };
  }
  if (patch.type === "mark-publishing") {
    if (!current.executorSessionId) {
      return null;
    }
    return {
      ...current,
      status: "publishing",
      mediaParticipantId: patch.mediaParticipantId.trim(),
      mediaTrackSid: undefined,
      audioTrackSid: undefined,
      mediaSourceRect: undefined,
      errorCode: undefined,
      streamErrorCode: undefined,
      errorDetail: undefined,
      streamUpdatedAtMs: nowMs,
      lastInputEventId: patch.inputEventId
    };
  }
  if (patch.type === "mark-active") {
    if (!current.executorSessionId || current.mediaParticipantId !== patch.mediaParticipantId.trim()) {
      return null;
    }
    return {
      ...current,
      status: "active",
      mediaParticipantId: patch.mediaParticipantId.trim(),
      mediaTrackSid: patch.mediaTrackSid.trim(),
      audioTrackSid: patch.audioTrackSid.trim(),
      mediaSourceRect: normalizeRemoteBrowserMediaSourceRect(patch.mediaSourceRect) ?? current.mediaSourceRect,
      loadedAtMs: current.loadedAtMs ?? nowMs,
      streamStartedAtMs: current.streamStartedAtMs ?? nowMs,
      streamUpdatedAtMs: nowMs,
      stoppedAtMs: undefined,
      errorCode: undefined,
      streamErrorCode: undefined,
      errorDetail: undefined,
      lastInputEventId: patch.inputEventId
    };
  }
  if (patch.type === "mark-source-rect") {
    if (!current.executorSessionId) {
      return null;
    }
    return {
      ...current,
      mediaSourceRect: normalizeRemoteBrowserMediaSourceRect(patch.mediaSourceRect),
      streamUpdatedAtMs: nowMs,
      lastInputEventId: patch.inputEventId
    };
  }
  if (patch.type === "mark-input-applied") {
    if (!current.executorSessionId) {
      return null;
    }
    return {
      ...current,
      lastExecutorInput: normalizeRemoteBrowserExecutorInputState(patch.input),
      lastInputEventId: patch.inputEventId
    };
  }
  if (patch.type === "mark-stopped") {
    return {
      ...current,
      status: "stopped",
      mediaTrackSid: undefined,
      audioTrackSid: undefined,
      mediaSourceRect: undefined,
      stoppedAtMs: nowMs,
      streamUpdatedAtMs: nowMs,
      lastInputEventId: patch.inputEventId
    };
  }
  if (patch.type === "mark-failed") {
    return {
      ...current,
      status: "failed",
      mediaTrackSid: undefined,
      audioTrackSid: undefined,
      mediaSourceRect: undefined,
      errorCode: patch.errorCode,
      streamErrorCode: patch.errorCode,
      errorDetail: normalizeRemoteBrowserErrorDetail(patch.errorDetail),
      streamUpdatedAtMs: nowMs,
      lastInputEventId: patch.inputEventId
    };
  }
  if (current.controllerParticipantId && current.controllerParticipantId !== participantId) {
    return null;
  }
  if (!current.executorSessionId) {
    return null;
  }
  return {
    ...current,
    controllerParticipantId: current.controllerParticipantId ?? participantId,
    lastInputSeq: (current.lastInputSeq ?? 0) + 1,
    lastInputEventId: patch.inputEventId
  };
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
  const definition = getMediaObjectDefinition(input.objectType);
  if (!definition) {
    return rejectMediaObjectCommand(state, { commandId: input.commandId, role: access.role, permission, blockedReason: "unknown-object-type", surfaceId: input.surfaceId, objectType: input.objectType });
  }
  if (!isMediaObjectDefinitionEnabled(definition)) {
    return rejectMediaObjectCommand(state, { commandId: input.commandId, role: access.role, permission, blockedReason: "extension-disabled", surfaceId: input.surfaceId, objectType: input.objectType });
  }
  if (definition.missingCapabilities.length > 0 || definition.validationErrors.length > 0) {
    return rejectMediaObjectCommand(state, { commandId: input.commandId, role: access.role, permission, blockedReason: "missing-extension-capability", surfaceId: input.surfaceId, objectType: input.objectType });
  }
  for (const requiredPermission of definition.requiredPermissions) {
    if (!hasRoomPermission(access.permissions, requiredPermission)) {
      return rejectMediaObjectCommand(state, { commandId: input.commandId, role: access.role, permission: requiredPermission, blockedReason: "missing-permission", surfaceId: input.surfaceId, objectType: input.objectType });
    }
  }
  if (!surface.allowedObjectTypes.includes(input.objectType)) {
    return rejectMediaObjectCommand(state, { commandId: input.commandId, role: access.role, permission, blockedReason: "unknown-object-type", surfaceId: input.surfaceId, objectType: input.objectType });
  }
  if (surface.activeObjectId) {
    return rejectMediaObjectCommand(state, { commandId: input.commandId, role: access.role, permission, blockedReason: "surface-occupied", surfaceId: input.surfaceId, objectId: surface.activeObjectId, objectType: input.objectType });
  }

  const objectState = createInitialMediaObjectState(definition.stateKind, participantId, input.surfaceId);
  const object: MediaObjectInstance<SurfaceTestCardState | ScreenShareObjectState | WhiteboardState | RemoteBrowserObjectState> = {
    objectId: input.objectId,
    type: input.objectType,
    roomId: state.roomId,
    surfaceId: input.surfaceId,
    ownerParticipantId: participantId,
    state: objectState,
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
  let permission: RoomPermission = "surface.input";

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
  const allowRemoteBrowserInputRevisionSkew = object.type === REMOTE_BROWSER_OBJECT_TYPE && isRemoteBrowserRealtimeInputPatch(input.patch);
  if (object.revision !== input.expectedRevision && !allowRemoteBrowserInputRevisionSkew) {
    return rejectMediaObjectCommand(state, { commandId: input.commandId, role: access.role, permission, blockedReason: "revision-mismatch", surfaceId: input.surfaceId, objectId: input.objectId, objectType: object.type, revision: object.revision });
  }
  const stateKind = getAvailableMediaObjectStateKind(object.type);
  if (!stateKind) {
    return rejectMediaObjectCommand(state, { commandId: input.commandId, role: access.role, permission, blockedReason: "unknown-object-type", surfaceId: input.surfaceId, objectId: input.objectId, objectType: object.type, revision: object.revision });
  }
  if (stateKind === "screen-share") {
    permission = "screen-share.start";
    if (!hasRoomPermission(access.permissions, permission)) {
      return rejectMediaObjectCommand(state, { commandId: input.commandId, role: access.role, permission, blockedReason: "missing-permission", surfaceId: input.surfaceId, objectId: input.objectId, objectType: object.type, revision: object.revision });
    }
    if (!isScreenSharePatch(input.patch)) {
      return rejectMediaObjectCommand(state, { commandId: input.commandId, role: access.role, permission, blockedReason: "invalid-patch", surfaceId: input.surfaceId, objectId: input.objectId, objectType: object.type, revision: object.revision });
    }
    const nextObject: MediaObjectInstance<ScreenShareObjectState> = {
      ...object,
      state: reduceScreenShareState(object.state as ScreenShareObjectState, input.patch, input.nowMs),
      status: input.patch.type === "mark-failed" ? "failed" : input.patch.type === "mark-stopped" ? "stopped" : "active",
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
  if (stateKind === "whiteboard") {
    permission = getWhiteboardPatchPermission(input.patch) ?? "whiteboard.draw";
    if (!hasRoomPermission(access.permissions, permission)) {
      return rejectMediaObjectCommand(state, { commandId: input.commandId, role: access.role, permission, blockedReason: "missing-permission", surfaceId: input.surfaceId, objectId: input.objectId, objectType: object.type, revision: object.revision });
    }
    const currentState = object.state as WhiteboardState;
    const patch = input.patch as WhiteboardPatch;
    if (!patch || typeof patch !== "object" || !isWhiteboardInputEventId(patch.inputEventId)) {
      return rejectMediaObjectCommand(state, { commandId: input.commandId, role: access.role, permission, blockedReason: "invalid-patch", surfaceId: input.surfaceId, objectId: input.objectId, objectType: object.type, revision: object.revision });
    }
    if (currentState.lastInputEventId === patch.inputEventId) {
      return rejectMediaObjectCommand(state, { commandId: input.commandId, role: access.role, permission, blockedReason: "duplicate-input-event", surfaceId: input.surfaceId, objectId: input.objectId, objectType: object.type, revision: object.revision });
    }
    const nextState = reduceWhiteboardState(currentState, patch, participantId);
    if (!nextState) {
      return rejectMediaObjectCommand(state, { commandId: input.commandId, role: access.role, permission, blockedReason: "invalid-patch", surfaceId: input.surfaceId, objectId: input.objectId, objectType: object.type, revision: object.revision });
    }
    const nextObject: MediaObjectInstance<WhiteboardState> = {
      ...object,
      state: nextState,
      status: nextState.status === "failed" ? "failed" : "active",
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
  if (stateKind === "remote-browser") {
    permission = getRemoteBrowserPatchPermission(input.patch) ?? "remote-browser.input";
    if (!hasRoomPermission(access.permissions, permission)) {
      return rejectMediaObjectCommand(state, { commandId: input.commandId, role: access.role, permission, blockedReason: "missing-permission", surfaceId: input.surfaceId, objectId: input.objectId, objectType: object.type, revision: object.revision });
    }
    const currentState = object.state as RemoteBrowserObjectState;
    const patch = input.patch as RemoteBrowserPatch;
    if (!isRemoteBrowserPatch(patch)) {
      return rejectMediaObjectCommand(state, { commandId: input.commandId, role: access.role, permission, blockedReason: "invalid-patch", surfaceId: input.surfaceId, objectId: input.objectId, objectType: object.type, revision: object.revision });
    }
    if (isRemoteBrowserExecutorPatch(patch)) {
      return rejectMediaObjectCommand(state, { commandId: input.commandId, role: access.role, permission, blockedReason: "invalid-patch", surfaceId: input.surfaceId, objectId: input.objectId, objectType: object.type, revision: object.revision });
    }
    if (currentState.lastInputEventId === patch.inputEventId) {
      return rejectMediaObjectCommand(state, { commandId: input.commandId, role: access.role, permission, blockedReason: "duplicate-input-event", surfaceId: input.surfaceId, objectId: input.objectId, objectType: object.type, revision: object.revision });
    }
    const nextState = reduceRemoteBrowserState(currentState, patch, participantId, object.objectId, input.nowMs);
    if (!nextState) {
      return rejectMediaObjectCommand(state, { commandId: input.commandId, role: access.role, permission, blockedReason: "invalid-patch", surfaceId: input.surfaceId, objectId: input.objectId, objectType: object.type, revision: object.revision });
    }
    const nextObject: MediaObjectInstance<RemoteBrowserObjectState> = {
      ...object,
      state: nextState,
      status: nextState.status === "failed" ? "failed" : nextState.status === "stopped" ? "stopped" : "active",
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
  permission = "surface.input";
  if (!hasRoomPermission(access.permissions, permission)) {
    return rejectMediaObjectCommand(state, { commandId: input.commandId, role: access.role, permission, blockedReason: "missing-permission", surfaceId: input.surfaceId, objectId: input.objectId, objectType: object.type, revision: object.revision });
  }
  if (stateKind !== "surface-test-card" || !isSurfaceTestCardPatch(input.patch)) {
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

export function patchRemoteBrowserExecutorState(state: RoomState, input: PatchRemoteBrowserExecutorInput): MediaObjectMutationResult {
  const permission: RoomPermission = "remote-browser.stop";
  const mediaObjects = ensureMediaObjectsState(state);
  const surface = mediaObjects.surfaces[input.surfaceId];
  if (!surface) {
    return rejectMediaObjectCommand(state, { commandId: input.commandId, role: "admin", permission, blockedReason: "missing-surface", surfaceId: input.surfaceId, objectId: input.objectId });
  }
  const object = mediaObjects.objects[input.objectId];
  if (!object) {
    return rejectMediaObjectCommand(state, { commandId: input.commandId, role: "admin", permission, blockedReason: "missing-object", surfaceId: input.surfaceId, objectId: input.objectId });
  }
  if (object.type !== REMOTE_BROWSER_OBJECT_TYPE || object.surfaceId !== input.surfaceId || surface.activeObjectId !== input.objectId) {
    return rejectMediaObjectCommand(state, { commandId: input.commandId, role: "admin", permission, blockedReason: "object-surface-mismatch", surfaceId: input.surfaceId, objectId: input.objectId, objectType: object.type, revision: object.revision });
  }

  const currentState = object.state as RemoteBrowserObjectState;
  if (currentState.executorSessionId !== input.executorSessionId) {
    return rejectMediaObjectCommand(state, { commandId: input.commandId, role: "admin", permission, blockedReason: "invalid-patch", surfaceId: input.surfaceId, objectId: input.objectId, objectType: object.type, revision: object.revision });
  }
  if (!isRemoteBrowserExecutorPatch(input.patch)) {
    return rejectMediaObjectCommand(state, { commandId: input.commandId, role: "admin", permission, blockedReason: "invalid-patch", surfaceId: input.surfaceId, objectId: input.objectId, objectType: object.type, revision: object.revision });
  }
  if (currentState.lastInputEventId === input.patch.inputEventId) {
    return rejectMediaObjectCommand(state, { commandId: input.commandId, role: "admin", permission, blockedReason: "duplicate-input-event", surfaceId: input.surfaceId, objectId: input.objectId, objectType: object.type, revision: object.revision });
  }
  const nextState = reduceRemoteBrowserState(currentState, input.patch, object.ownerParticipantId, object.objectId, input.nowMs);
  if (!nextState) {
    return rejectMediaObjectCommand(state, { commandId: input.commandId, role: "admin", permission, blockedReason: "invalid-patch", surfaceId: input.surfaceId, objectId: input.objectId, objectType: object.type, revision: object.revision });
  }
  const nextObject: MediaObjectInstance<RemoteBrowserObjectState> = {
    ...object,
    state: nextState,
    status: nextState.status === "failed" ? "failed" : nextState.status === "stopped" ? "stopped" : "active",
    revision: object.revision + 1,
    updatedAtMs: input.nowMs
  };
  return {
    room: {
      ...state,
      mediaObjects: {
        surfaces: mediaObjects.surfaces,
        objects: {
          ...mediaObjects.objects,
          [input.objectId]: nextObject
        }
      }
    },
    result: createMediaObjectCommandResult({
      accepted: true,
      commandId: input.commandId,
      role: "admin",
      permission,
      blockedReason: null,
      surfaceId: input.surfaceId,
      objectId: input.objectId,
      objectType: object.type,
      revision: nextObject.revision
    })
  };
}

export function setSurfaceMediaAudioEnabled(state: RoomState, participantId: string, input: SetSurfaceMediaAudioInput): MediaObjectMutationResult {
  const access = getParticipantAccess(state, participantId);
  const permission: RoomPermission = "surface.configure-audio";
  if (!hasRoomPermission(access.permissions, permission)) {
    return rejectMediaObjectCommand(state, { commandId: input.commandId, role: access.role, permission, blockedReason: "missing-permission", surfaceId: input.surfaceId });
  }

  const mediaObjects = ensureMediaObjectsState(state);
  const surface = mediaObjects.surfaces[input.surfaceId];
  if (!surface) {
    return rejectMediaObjectCommand(state, { commandId: input.commandId, role: access.role, permission, blockedReason: "missing-surface", surfaceId: input.surfaceId });
  }

  const nextMediaObjects: RoomMediaObjectsState = {
    surfaces: {
      ...mediaObjects.surfaces,
      [input.surfaceId]: {
        ...surface,
        mediaAudioEnabled: input.enabled
      }
    },
    objects: mediaObjects.objects
  };
  return {
    room: { ...state, mediaObjects: nextMediaObjects },
    result: createMediaObjectCommandResult({
      accepted: true,
      commandId: input.commandId,
      role: access.role,
      permission,
      blockedReason: null,
      surfaceId: input.surfaceId
    })
  };
}

export function joinRoom(state: RoomState, participantId: string, access?: ParticipantAccessState): RoomState {
  const mediaObjects = ensureMediaObjectsState(state);
  if (state.participants.some((item) => item.participantId === participantId)) {
    return {
      ...state,
      mediaObjects,
      participants: state.participants.map((item) => item.participantId === participantId ? applyParticipantAccess(item, access) : item)
    };
  }
  return {
    ...state,
    mediaObjects,
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
  const mediaObjects = ensureMediaObjectsState(state);
  const nextObjects = { ...mediaObjects.objects };
  const nextSurfaces = { ...mediaObjects.surfaces };
  let mediaObjectsChanged = false;
  for (const [objectId, object] of Object.entries(mediaObjects.objects)) {
    if ((object.type === SCREEN_SHARE_OBJECT_TYPE || object.type === REMOTE_BROWSER_OBJECT_TYPE) && object.ownerParticipantId === participantId) {
      delete nextObjects[objectId];
      const surface = nextSurfaces[object.surfaceId];
      if (surface?.activeObjectId === objectId) {
        nextSurfaces[object.surfaceId] = { ...surface, activeObjectId: null };
      }
      mediaObjectsChanged = true;
      continue;
    }
    if (object.type === REMOTE_BROWSER_OBJECT_TYPE && (object.state as RemoteBrowserObjectState).controllerParticipantId === participantId) {
      nextObjects[objectId] = {
        ...object,
        state: {
          ...(object.state as RemoteBrowserObjectState),
          controllerParticipantId: undefined
        }
      };
      mediaObjectsChanged = true;
    }
  }
  return {
    ...state,
    participants: state.participants.filter((item) => item.participantId !== participantId),
    seatOccupancy: nextSeatOccupancy,
    mediaObjects: mediaObjectsChanged ? { surfaces: nextSurfaces, objects: nextObjects } : state.mediaObjects
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
