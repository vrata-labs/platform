import { getRoomPermissions } from "@vrata/shared-types";
import { activeIdentity, assertRoomActive, identityWasRemoved } from "./authority.js";
import { IdentityAuthorityViewUnavailable, IdentityStorageError, type IdentityTransaction, type RoomIdentityProof, type RoomIdentityView } from "./contracts.js";

export function projectParticipantView(state: IdentityTransaction, proof: RoomIdentityProof): RoomIdentityView | null {
  let identity: RoomIdentityView["identity"];
  try { assertRoomActive(state); identity = activeIdentity(state, proof); }
  catch (error) { if (error instanceof IdentityStorageError) return null; throw error; }
  const slot = (id: string | null) => {
    if (!id) return null;
    const participant = state.identities.get(id);
    if (!participant || participant.identityId !== id || participant.revokedAt || identityWasRemoved(state, participant.participantId)
      || participant.tenantId !== proof.tenantId || participant.roomId !== proof.roomId) throw new IdentityAuthorityViewUnavailable();
    return { participantId: participant.participantId, displayName: participant.displayName };
  };
  const role = state.authority.hostIdentityId === identity.identityId ? "host"
    : state.authority.presenterIdentityId === identity.identityId ? "presenter" : identity.baseRole;
  return { identity, authority: state.authority, role, permissions: getRoomPermissions(role),
    isOwner: state.authority.ownerIdentityId === identity.identityId,
    slots: { host: slot(state.authority.hostIdentityId), presenter: slot(state.authority.presenterIdentityId), owner: slot(state.authority.ownerIdentityId) } };
}
