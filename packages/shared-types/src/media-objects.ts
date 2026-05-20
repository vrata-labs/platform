import type { RoomPermission, RoomRole } from "./access.js";
import type { SurfaceInputEvent } from "./surface-input.js";

export const DEFAULT_MEDIA_SURFACE_ID = "debug-main";
export const SURFACE_TEST_CARD_TYPE = "surface-test-card";
export const SCREEN_SHARE_OBJECT_TYPE = "screen-share";
export const WHITEBOARD_OBJECT_TYPE = "whiteboard";
export const REMOTE_BROWSER_OBJECT_TYPE = "remote-browser";
export const WHITEBOARD_MAX_STROKES = 500;
export const WHITEBOARD_MAX_POINTS_PER_STROKE = 256;
export const WHITEBOARD_ALLOWED_COLORS = ["#111827", "#2563eb", "#dc2626"] as const;
export const WHITEBOARD_ALLOWED_WIDTHS = [2, 4, 8] as const;

export type MediaObjectType = typeof SURFACE_TEST_CARD_TYPE | typeof SCREEN_SHARE_OBJECT_TYPE | typeof WHITEBOARD_OBJECT_TYPE | typeof REMOTE_BROWSER_OBJECT_TYPE | string;

export type MediaObjectStatus = "active" | "stopped" | "failed";

export interface MediaSurface {
  surfaceId: string;
  roomId: string;
  widthPx: number;
  heightPx: number;
  inputEnabled: boolean;
  mediaAudioEnabled: boolean;
  visible: boolean;
  allowedObjectTypes: string[];
  activeObjectId: string | null;
  lockedByParticipantId: string | null;
}

export interface MediaObjectInstance<State = unknown> {
  objectId: string;
  type: MediaObjectType;
  roomId: string;
  surfaceId: string;
  ownerParticipantId: string;
  state: State;
  status: MediaObjectStatus;
  revision: number;
  createdAtMs: number;
  updatedAtMs: number;
}

export interface RoomMediaObjectsState {
  surfaces: Record<string, MediaSurface>;
  objects: Record<string, MediaObjectInstance>;
}

export interface SurfaceTestCardState {
  clickCount: number;
  lastInputEventId: string | null;
}

export type ScreenShareObjectStatus = "idle" | "selecting" | "publishing" | "active" | "stopping" | "stopped" | "failed";

export type ScreenShareErrorCode =
  | "display_capture_unsupported"
  | "display_capture_denied"
  | "display_capture_failed"
  | "media_network_blocked"
  | "track_unpublished"
  | "unknown";

export interface ScreenShareObjectState {
  status: ScreenShareObjectStatus;
  ownerParticipantId: string;
  surfaceId: string;
  mediaTrackSid?: string;
  startedAtMs?: number;
  stoppedAtMs?: number;
  errorCode?: ScreenShareErrorCode;
}

export type WhiteboardStatus = "active" | "locked" | "failed";
export type WhiteboardTool = "pen";
export type WhiteboardColor = typeof WHITEBOARD_ALLOWED_COLORS[number];
export type WhiteboardWidth = typeof WHITEBOARD_ALLOWED_WIDTHS[number];

export interface WhiteboardPoint {
  u: number;
  v: number;
  t: number;
  pressure?: number;
}

export interface WhiteboardStroke {
  strokeId: string;
  participantId: string;
  tool: WhiteboardTool;
  color: WhiteboardColor;
  width: WhiteboardWidth;
  points: WhiteboardPoint[];
}

export interface WhiteboardState {
  status: WhiteboardStatus;
  strokes: WhiteboardStroke[];
  revision: number;
  lastInputEventId: string | null;
}

export type RemoteBrowserStatus = "idle" | "starting" | "loading" | "publishing" | "active" | "stopping" | "stopped" | "failed";

export type RemoteBrowserErrorCode =
  | "url_not_allowed"
  | "url_resolution_blocked"
  | "redirect_not_allowed"
  | "executor_unavailable"
  | "executor_crashed"
  | "executor_timeout"
  | "navigation_failed"
  | "viewport_capture_unsupported"
  | "viewport_capture_denied"
  | "viewport_capture_failed"
  | "audio_track_missing"
  | "video_track_missing"
  | "livekit_token_failed"
  | "livekit_publish_failed"
  | "input_rejected"
  | "stream_failed"
  | "unknown";

export interface RemoteBrowserObjectState {
  status: RemoteBrowserStatus;
  ownerParticipantId: string;
  surfaceId: string;
  controllerParticipantId?: string;
  executorSessionId?: string;
  frameStreamId?: string;
  mediaParticipantId?: string;
  mediaTrackSid?: string;
  audioTrackSid?: string;
  mediaSourceRect?: RemoteBrowserMediaSourceRect;
  currentUrl?: string;
  title?: string;
  loadedAtMs?: number;
  lastFrameAtMs?: number;
  streamStartedAtMs?: number;
  streamUpdatedAtMs?: number;
  stoppedAtMs?: number;
  streamErrorCode?: RemoteBrowserErrorCode;
  errorDetail?: string;
  lastInputSeq?: number;
  lastExecutorInput?: RemoteBrowserExecutorInputState;
  lastInputEventId: string | null;
  errorCode?: RemoteBrowserErrorCode;
}

export interface RemoteBrowserExecutorInputState {
  inputEventId: string;
  inputType: "pointer" | "scroll" | "keyboard";
  eventKind: SurfaceInputEvent["kind"];
  x: number;
  y: number;
  receivedAtMs: number;
  appliedAtMs: number;
  status: "applied" | "failed";
  pageUrl?: string;
  pageClosed: boolean;
  errorDetail?: string;
}

export interface RemoteBrowserMediaSourceRect {
  x: number;
  y: number;
  width: number;
  height: number;
  viewportWidth: number;
  viewportHeight: number;
}

export type SurfaceTestCardPatch = {
  type: "increment-click-count";
  inputEventId: string;
};

export type ScreenSharePatch =
  | { type: "mark-selecting" }
  | { type: "mark-publishing" }
  | { type: "mark-active"; mediaTrackSid: string }
  | { type: "mark-failed"; errorCode: ScreenShareErrorCode }
  | { type: "mark-stopped" };

export type WhiteboardPatch =
  | { type: "append-stroke"; stroke: WhiteboardStroke; inputEventId: string }
  | { type: "clear"; inputEventId: string };

export type RemoteBrowserPatch =
  | { type: "open-url"; url: string; inputEventId: string }
  | { type: "mark-publishing"; mediaParticipantId: string; inputEventId: string }
  | { type: "mark-active"; mediaParticipantId: string; mediaTrackSid: string; audioTrackSid: string; mediaSourceRect?: RemoteBrowserMediaSourceRect; inputEventId: string }
  | { type: "mark-source-rect"; mediaSourceRect: RemoteBrowserMediaSourceRect; inputEventId: string }
  | { type: "mark-input-applied"; input: RemoteBrowserExecutorInputState; inputEventId: string }
  | { type: "mark-stopped"; inputEventId: string }
  | { type: "pointer"; event: SurfaceInputEvent; inputEventId: string }
  | { type: "scroll"; event: SurfaceInputEvent; inputEventId: string }
  | { type: "keyboard"; event: SurfaceInputEvent; inputEventId: string }
  | { type: "take-control"; inputEventId: string }
  | { type: "release-control"; inputEventId: string }
  | { type: "mark-failed"; errorCode: RemoteBrowserErrorCode; errorDetail?: string; inputEventId: string };

export type MediaObjectCommandBlockedReason =
  | "missing-permission"
  | "missing-surface"
  | "missing-object"
  | "unknown-object-type"
  | "surface-occupied"
  | "object-surface-mismatch"
  | "revision-mismatch"
  | "invalid-patch"
  | "duplicate-input-event";

export interface MediaObjectCommandResult {
  accepted: boolean;
  commandId: string;
  role: RoomRole;
  permission: RoomPermission;
  blockedReason: MediaObjectCommandBlockedReason | null;
  surfaceId: string | null;
  objectId: string | null;
  objectType: string | null;
  revision: number | null;
}

export function createDefaultRoomMediaObjectsState(roomId: string): RoomMediaObjectsState {
  return {
    surfaces: {
      [DEFAULT_MEDIA_SURFACE_ID]: {
        surfaceId: DEFAULT_MEDIA_SURFACE_ID,
        roomId,
        widthPx: 1920,
        heightPx: 1080,
        inputEnabled: true,
        mediaAudioEnabled: false,
        visible: true,
        allowedObjectTypes: [SURFACE_TEST_CARD_TYPE, SCREEN_SHARE_OBJECT_TYPE, WHITEBOARD_OBJECT_TYPE, REMOTE_BROWSER_OBJECT_TYPE],
        activeObjectId: null,
        lockedByParticipantId: null
      }
    },
    objects: {}
  };
}
