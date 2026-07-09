export type RoomRole = "guest" | "member" | "host" | "admin";

export type RoomPermission =
  | "room.join"
  | "audio.join"
  | "surface.view"
  | "surface.select"
  | "surface.create-object"
  | "surface.stop-object"
  | "surface.lock"
  | "surface.configure-audio"
  | "surface.input"
  | "screen-share.start"
  | "screen-share.stop"
  | "whiteboard.draw"
  | "whiteboard.clear"
  | "remote-browser.open-url"
  | "remote-browser.input"
  | "remote-browser.stop"
  | "markdown-board.view"
  | "markdown-board.edit"
  | "document.view"
  | "document.download"
  | "document.upload"
  | "document.delete"
  | "notes.view"
  | "notes.edit"
  | "room.session-control"
  | "room.admin";

export interface RoomAccessDebugState {
  role: RoomRole;
  permissions: RoomPermission[];
  canStartScreenShare: boolean;
  canCreateWhiteboard: boolean;
  canCreateMarkdownBoard: boolean;
  canEditMarkdownBoard: boolean;
  canCreateRemoteBrowser: boolean;
  canControlSurface: boolean;
  canConfigureSurfaceAudio: boolean;
  canManageRoomSession: boolean;
}

const roomRoles = new Set<RoomRole>(["guest", "member", "host", "admin"]);

const rolePermissions: Record<RoomRole, readonly RoomPermission[]> = {
  guest: ["room.join", "audio.join", "surface.view", "markdown-board.view", "notes.view"],
  member: ["room.join", "audio.join", "surface.view", "surface.input", "whiteboard.draw", "markdown-board.view", "markdown-board.edit", "document.view", "document.download", "notes.view", "notes.edit"],
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
    "whiteboard.clear",
    "remote-browser.open-url",
    "remote-browser.input",
    "remote-browser.stop",
    "markdown-board.view",
    "markdown-board.edit",
    "document.view",
    "document.download",
    "document.upload",
    "document.delete",
    "notes.view",
    "notes.edit",
    "room.session-control"
  ],
  admin: [
    "room.join",
    "audio.join",
    "surface.view",
    "surface.select",
    "surface.create-object",
    "surface.stop-object",
    "surface.lock",
    "surface.configure-audio",
    "surface.input",
    "screen-share.start",
    "screen-share.stop",
    "whiteboard.draw",
    "whiteboard.clear",
    "remote-browser.open-url",
    "remote-browser.input",
    "remote-browser.stop",
    "markdown-board.view",
    "markdown-board.edit",
    "document.view",
    "document.download",
    "document.upload",
    "document.delete",
    "notes.view",
    "notes.edit",
    "room.session-control",
    "room.admin"
  ]
};

const roomPermissions = new Set<RoomPermission>(Object.values(rolePermissions).flat());

export function isRoomRole(input: unknown): input is RoomRole {
  return typeof input === "string" && roomRoles.has(input as RoomRole);
}

export function parseRoomRole(input: unknown, fallback: RoomRole = "guest"): RoomRole {
  return isRoomRole(input) ? input : fallback;
}

export function getRoomPermissions(role: RoomRole): RoomPermission[] {
  return [...rolePermissions[role]];
}

export function isRoomPermission(input: unknown): input is RoomPermission {
  return typeof input === "string" && roomPermissions.has(input as RoomPermission);
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
    canCreateMarkdownBoard: hasRoomPermission(permissions, "surface.create-object") && hasRoomPermission(permissions, "markdown-board.edit"),
    canEditMarkdownBoard: hasRoomPermission(permissions, "markdown-board.edit"),
    canCreateRemoteBrowser: hasRoomPermission(permissions, "surface.create-object") && hasRoomPermission(permissions, "remote-browser.open-url"),
    canControlSurface: hasRoomPermission(permissions, "surface.lock") || hasRoomPermission(permissions, "surface.stop-object"),
    canConfigureSurfaceAudio: hasRoomPermission(permissions, "surface.configure-audio"),
    canManageRoomSession: hasRoomPermission(permissions, "room.session-control")
  };
}
