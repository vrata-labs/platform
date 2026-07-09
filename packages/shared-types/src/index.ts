export type { RoomAccessDebugState, RoomPermission, RoomRole as UserRole, RoomRole } from "./access.js";

export type ClientMode = "desktop" | "mobile" | "vr";

export interface RoomManifest {
  schemaVersion: number;
  tenantId: string;
  roomId: string;
  template: string;
  features: {
    voice: boolean;
    spatialAudio: boolean;
    screenShare: boolean;
  };
  quality: {
    default: "mobile-lite" | "desktop-standard" | "xr";
    mobile: "mobile-lite";
    xr: "xr";
  };
  access: {
    joinMode: "link";
    guestAllowed: boolean;
    roleQueryAllowed: boolean;
    visibility: "public" | "unlisted" | "private";
  };
}

export interface StateTokenPayload {
  tenantId: string;
  roomId: string;
  participantId: string;
  displayName: string;
  role: import("./access.js").RoomRole;
  permissions: import("./access.js").RoomPermission[];
  sessionId: string;
  iat: number;
  exp: number;
  jti: string;
}

export interface MediaTokenPayload {
  roomId: string;
  participantId: string;
  canPublishAudio: boolean;
  canPublishVideo: boolean;
}

export * from "./avatar.js";
export * from "./avatar-recipe.js";
export * from "./avatar-transport.js";
export * from "./access.js";
export * from "./surface-input.js";
export * from "./media-objects.js";
