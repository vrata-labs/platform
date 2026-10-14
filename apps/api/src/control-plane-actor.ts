import type { RoomPermission, RoomRole } from "@vrata/shared-types";
import type { RoomSessionRoleSource } from "@vrata/shared-types/session-token";

export interface ControlPlaneActor {
  actorType: "admin-token" | "room-session";
  actorId: string;
  role: RoomRole;
  roleSource?: RoomSessionRoleSource;
  tenantId?: string;
  roomId?: string;
  participantId?: string;
  sessionId?: string;
  permissions?: RoomPermission[];
  identityProtocolVersion?: 2;
  identityId?: string;
  authEpoch?: number;
  isOwner?: boolean;
  expiresAtSeconds?: number;
}
