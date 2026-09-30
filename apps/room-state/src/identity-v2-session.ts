import { getRoomPermissions, isRoomPermission, isRoomRole, type RoomRole, type RoomPermission } from "@vrata/shared-types";
import { SocketAuthorityError, type ReadIdentityProtocolPolicy } from "./identity-boundary.js";
import type { ParticipantAccessState } from "./state.js";

export interface VerifiedRoomSessionV2 {
  tenantId: string;
  roomId: string;
  identityId: string;
  participantId: string;
  displayName: string;
  authEpoch: number;
  sessionId: string;
  expiresAtSeconds: number;
  authorityRevision: number;
  role: RoomRole;
  permissions: RoomPermission[];
  sceneMediaSurfaces?: ParticipantAccessState["sceneMediaSurfaces"];
  roomTemplate?: ParticipantAccessState["roomTemplate"];
}

/** Concurrent poll and command checks must never restore an older grant. */
export function latestVerifiedRoomSession(previous: VerifiedRoomSessionV2 | null, incoming: VerifiedRoomSessionV2): VerifiedRoomSessionV2 {
  if (!previous) return incoming;
  if (incoming.identityId !== previous.identityId || incoming.participantId !== previous.participantId
    || incoming.authEpoch !== previous.authEpoch || incoming.sessionId !== previous.sessionId) {
    throw new SocketAuthorityError(1008, "invalid_session_token");
  }
  if (incoming.authorityRevision < previous.authorityRevision) return previous;
  if (incoming.authorityRevision === previous.authorityRevision
    && (incoming.role !== previous.role || JSON.stringify(incoming.permissions) !== JSON.stringify(previous.permissions))) {
    throw new SocketAuthorityError(1013, "identity_authority_unavailable");
  }
  return incoming;
}

function validSession(value: unknown, roomId: string, participantId: string): value is VerifiedRoomSessionV2 {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const result = value as VerifiedRoomSessionV2;
  const permissions = isRoomRole(result.role) ? getRoomPermissions(result.role) : null;
  return result.roomId === roomId && result.participantId === participantId
    && typeof result.tenantId === "string" && result.tenantId.length > 0
    && typeof result.identityId === "string" && result.identityId.length > 0
    && typeof result.sessionId === "string" && result.sessionId.length > 0
    && Number.isInteger(result.authEpoch) && result.authEpoch >= 1
    && Number.isInteger(result.authorityRevision) && result.authorityRevision >= 0
    && Number.isSafeInteger(result.expiresAtSeconds) && result.expiresAtSeconds > Math.floor(Date.now() / 1000)
    && typeof result.displayName === "string" && result.displayName.length <= 80
    && Array.isArray(result.permissions) && result.permissions.length <= 40
    && result.permissions.every(isRoomPermission) && permissions !== null
    && result.permissions.length === permissions.length && permissions.every(permission => result.permissions.includes(permission));
}

/** A verified session is resolved by API storage; the room-state never trusts JWT role claims. */
export function createRoomSessionV2Verifier(input: {
  baseUrl: string; internalToken: string | null; readPolicy: ReadIdentityProtocolPolicy; fetch?: typeof fetch;
}) {
  return async (roomId: string, participantId: string, sessionToken: string, includeSceneContext = false): Promise<VerifiedRoomSessionV2> => {
    const policy = await input.readPolicy(roomId);
    if (policy.minimumProtocolVersion < 2) throw new SocketAuthorityError(4406, "identity_upgrade_required");
    if (!sessionToken.startsWith("rs2.") || sessionToken.length > 4096) throw new SocketAuthorityError(1008, "invalid_session_token");
    if (!input.internalToken) throw new SocketAuthorityError(1013, "identity_authority_unavailable");
    const response = await (input.fetch ?? fetch)(new URL("/api/internal/identity-session/verify", input.baseUrl), {
      method: "POST", headers: { "content-type": "application/json", "x-vrata-internal-token": input.internalToken },
      body: JSON.stringify({ roomId, participantId, sessionToken, includeSceneContext }), signal: AbortSignal.timeout(5000), cache: "no-store"
    });
    if (response.status === 401 || response.status === 403) throw new SocketAuthorityError(1008, "invalid_session_token");
    if (response.status === 409) throw new SocketAuthorityError(4406, "identity_upgrade_required");
    if (!response.ok) throw new SocketAuthorityError(1013, "identity_authority_unavailable");
    const value: unknown = await response.json();
    if (!validSession(value, roomId, participantId)) throw new SocketAuthorityError(1013, "identity_authority_unavailable");
    return value;
  };
}
