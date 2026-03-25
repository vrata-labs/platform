export type UserRole = "guest" | "member" | "host" | "admin";

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
  };
}

export interface StateTokenPayload {
  roomId: string;
  participantId: string;
  role: UserRole;
}

export interface MediaTokenPayload {
  roomId: string;
  participantId: string;
  canPublishAudio: boolean;
  canPublishVideo: boolean;
}
