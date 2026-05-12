import type { RoomPermission, RoomRole } from "./access.js";

export const DEFAULT_MEDIA_SURFACE_ID = "debug-main";
export const SURFACE_TEST_CARD_TYPE = "surface-test-card";
export const SCREEN_SHARE_OBJECT_TYPE = "screen-share";

export type MediaObjectType = typeof SURFACE_TEST_CARD_TYPE | typeof SCREEN_SHARE_OBJECT_TYPE | string;

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
        allowedObjectTypes: [SURFACE_TEST_CARD_TYPE, SCREEN_SHARE_OBJECT_TYPE],
        activeObjectId: null,
        lockedByParticipantId: null
      }
    },
    objects: {}
  };
}
