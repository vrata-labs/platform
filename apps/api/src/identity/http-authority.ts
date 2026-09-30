import type { RoomPermission, RoomRole } from "@vrata/shared-types";
import type { RoomIdentityAuthority, RoomIdentityRecord } from "./contracts.js";
import type { RoomRecord, RoomSessionControlState, Storage } from "../storage-contracts.js";
import { createRoomIdentityService } from "./service.js";

export interface VerifiedRoomRequestV2 {
  room: RoomRecord;
  identity: RoomIdentityRecord;
  authority: RoomIdentityAuthority;
  role: RoomRole;
  permissions: RoomPermission[];
  isOwner: boolean;
  sessionId: string;
  expiresAtSeconds: number;
}

/** Untrusted scope is only a bounded lookup hint; MAC and persisted scope follow. */
export function untrustedSessionRoom(token: unknown): string | null {
  if (typeof token !== "string" || token.length > 4096) return null;
  const match = /^rs2\.([A-Za-z0-9_-]{1,3000})\.[A-Za-z0-9_-]{43}$/.exec(token);
  if (!match) return null;
  try {
    const bytes = Buffer.from(match[1], "base64url");
    if (bytes.toString("base64url") !== match[1]) return null;
    const room: unknown = JSON.parse(bytes.toString("utf8"))?.roomId;
    return typeof room === "string" && room.length > 0 && room.length <= 200 && !/[\u0000-\u001f]/.test(room) ? room : null;
  } catch { return null; }
}

/** Every successful call resolves current role and epoch from the storage. */
export async function resolveRoomRequestV2(input: {
  storage: Storage; secret: string; token: unknown; expectedRoomId?: string; participantId?: string;
}): Promise<VerifiedRoomRequestV2 | null> {
  const roomId = untrustedSessionRoom(input.token);
  if (!roomId || (input.expectedRoomId !== undefined && roomId !== input.expectedRoomId)) return null;
  const room = await input.storage.getRoom(roomId);
  if (!room) return null;
  const current = await createRoomIdentityService(input.storage.roomIdentities, input.secret).resolveSession(input.token,
    { tenantId: room.tenantId, roomId: room.roomId });
  if (!current || (input.participantId !== undefined && current.identity.participantId !== input.participantId)) return null;
  return { room, identity: current.identity, authority: current.authority, role: current.role,
    permissions: current.permissions, isOwner: current.isOwner, sessionId: current.sessionId, expiresAtSeconds: current.expiresAtSeconds };
}

/** Read-only projection for existing UI DTOs; legacy JSON is never a writer. */
export async function currentSessionControlV2(storage: Storage, room: RoomRecord): Promise<RoomSessionControlState> {
  const scope = { tenantId: room.tenantId, roomId: room.roomId };
  const authority = await storage.roomIdentities.authority(scope);
  if (!authority) throw new Error("room_identity_authority_unavailable");
  const host = authority.hostIdentityId ? await storage.roomIdentities.get(scope, authority.hostIdentityId) : null;
  const presenter = authority.presenterIdentityId ? await storage.roomIdentities.get(scope, authority.presenterIdentityId) : null;
  if ((authority.hostIdentityId && !host) || (authority.presenterIdentityId && !presenter)) throw new Error("room_identity_authority_unavailable");
  return { ...structuredClone(authority.lifecycle),
    hostParticipantId: host?.participantId ?? null, presenterParticipantId: presenter?.participantId ?? null };
}
