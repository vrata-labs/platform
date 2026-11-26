import { IMAGE_VIEWER_OBJECT_TYPE, PDF_PRESENTATION_OBJECT_TYPE, REMOTE_BROWSER_OBJECT_TYPE, VIDEO_PLAYER_OBJECT_TYPE, WHITEBOARD_OBJECT_TYPE } from "./media-objects.js";

export const ROOM_MEDIA_MODE_KEYS = ["whiteboard", "remoteBrowser", "pdf", "video"] as const;
export type RoomMediaModes = Record<(typeof ROOM_MEDIA_MODE_KEYS)[number], boolean>;

export const DEFAULT_PRIVATE_ROOM_MEDIA_MODES: Readonly<RoomMediaModes> = Object.freeze({
  whiteboard: true,
  remoteBrowser: false,
  pdf: false,
  video: false
});

export interface RoomMediaPolicy {
  revision: number;
  modes: RoomMediaModes;
}

export function isRoomMediaModes(value: unknown): value is RoomMediaModes {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const modes = value as Record<string, unknown>;
  return Object.keys(modes).length === ROOM_MEDIA_MODE_KEYS.length
    && ROOM_MEDIA_MODE_KEYS.every(key => Object.hasOwn(modes, key) && typeof modes[key] === "boolean");
}

export function isRoomMediaPolicy(value: unknown): value is RoomMediaPolicy {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const candidate = value as Partial<RoomMediaPolicy>;
  return typeof candidate.revision === "number" && Number.isSafeInteger(candidate.revision)
    && candidate.revision >= 0 && isRoomMediaModes(candidate.modes);
}

export function roomAllowsMediaObject(modes: RoomMediaModes | undefined, objectType: string): boolean {
  if (!modes) return true;
  switch (objectType) {
    case WHITEBOARD_OBJECT_TYPE: return modes.whiteboard;
    case REMOTE_BROWSER_OBJECT_TYPE: return modes.remoteBrowser;
    case PDF_PRESENTATION_OBJECT_TYPE: return modes.pdf;
    case VIDEO_PLAYER_OBJECT_TYPE: return modes.video;
    case IMAGE_VIEWER_OBJECT_TYPE: return false;
    default: return true;
  }
}
