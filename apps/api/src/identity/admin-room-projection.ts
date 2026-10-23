import type { RoomRecord, Storage } from "../storage-contracts.js";
import type { RoomIdentityAuthority, RoomIdentityScope } from "./contracts.js";

/** Current identity authority, independent of the frozen legacy owner column. */
export async function currentRoomOwner(storage: Pick<Storage, "roomIdentities">, scope: RoomIdentityScope):
  Promise<{ authority: RoomIdentityAuthority; ownerParticipantId: string | null }> {
  const authority = await storage.roomIdentities.authority(scope);
  if (!authority) throw new Error("room_identity_authority_unavailable");
  const owner = authority.ownerIdentityId ? await storage.roomIdentities.get(scope, authority.ownerIdentityId) : null;
  if (authority.ownerIdentityId && !owner) throw new Error("room_identity_authority_unavailable");
  return { authority, ownerParticipantId: owner?.participantId ?? null };
}

/** Read-only admin item presentation; never an identity or ownership grant. */
export async function adminCurrentOwnerParticipantId(storage: Pick<Storage, "roomIdentities">,
  room: Pick<RoomRecord, "tenantId" | "roomId" | "ownerParticipantId">, minimumProtocol: number): Promise<string | null> {
  if (minimumProtocol < 2) return room.ownerParticipantId ?? null;
  return (await currentRoomOwner(storage, { tenantId: room.tenantId, roomId: room.roomId })).ownerParticipantId;
}
