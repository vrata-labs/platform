export type RoomRole = "guest" | "member" | "host" | "admin";

export type RoomPermission =
  | "room.join"
  | "audio.join"
  | "surface.view"
  | "surface.select"
  | "surface.create-object"
  | "surface.stop-object"
  | "surface.lock"
  | "surface.input"
  | "screen-share.start"
  | "screen-share.stop"
  | "whiteboard.draw"
  | "whiteboard.clear"
  | "remote-browser.open-url"
  | "remote-browser.input"
  | "room.admin";

export interface RoomAccessDebugState {
  role: RoomRole;
  permissions: RoomPermission[];
  canStartScreenShare: boolean;
  canCreateWhiteboard: boolean;
  canControlSurface: boolean;
}

const roomRoles = new Set<RoomRole>(["guest", "member", "host", "admin"]);

const rolePermissions: Record<RoomRole, readonly RoomPermission[]> = {
  guest: ["room.join", "audio.join", "surface.view"],
  member: ["room.join", "audio.join", "surface.view", "surface.input", "whiteboard.draw"],
  host: [
    "room.join",
    "audio.join",
    "surface.view",
    "surface.select",
    "surface.create-object",
    "surface.stop-object",
    "surface.lock",
    "surface.input",
    "screen-share.start",
    "screen-share.stop",
    "whiteboard.draw",
    "whiteboard.clear"
  ],
  admin: [
    "room.join",
    "audio.join",
    "surface.view",
    "surface.select",
    "surface.create-object",
    "surface.stop-object",
    "surface.lock",
    "surface.input",
    "screen-share.start",
    "screen-share.stop",
    "whiteboard.draw",
    "whiteboard.clear",
    "room.admin"
  ]
};

export function isRoomRole(input: unknown): input is RoomRole {
  return typeof input === "string" && roomRoles.has(input as RoomRole);
}

export function parseRoomRole(input: unknown, fallback: RoomRole = "guest"): RoomRole {
  return isRoomRole(input) ? input : fallback;
}

export function getRoomPermissions(role: RoomRole): RoomPermission[] {
  return [...rolePermissions[role]];
}

export function hasRoomPermission(permissions: readonly RoomPermission[], permission: RoomPermission): boolean {
  return permissions.includes(permission);
}

export function createRoomAccessDebugState(role: RoomRole): RoomAccessDebugState {
  const permissions = getRoomPermissions(role);
  return {
    role,
    permissions,
    canStartScreenShare: hasRoomPermission(permissions, "screen-share.start"),
    canCreateWhiteboard: hasRoomPermission(permissions, "surface.create-object") && hasRoomPermission(permissions, "whiteboard.draw"),
    canControlSurface: hasRoomPermission(permissions, "surface.lock") || hasRoomPermission(permissions, "surface.stop-object")
  };
}
