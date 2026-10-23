import { getRoomPermissions } from "@vrata/shared-types";
import { activeIdentity, assertRoomActive } from "./authority.js";
import { IdentityStorageError, type IdentityTransaction, type RoomScreenSourceAuthority } from "./contracts.js";

export function projectScreenSourceAuthority(state: IdentityTransaction): RoomScreenSourceAuthority | null {
  if (state.minimumProtocol < 2) return null;
  let roomActive = true;
  try { assertRoomActive(state); }
  catch (error) {
    if (!(error instanceof IdentityStorageError)) throw error;
    roomActive = false;
  }
  const publishers = new Set<string>();
  if (roomActive) {
    for (const [role, identityId] of [["host", state.authority.hostIdentityId], ["presenter", state.authority.presenterIdentityId]] as const) {
      if (!identityId) continue;
      const identity = state.identities.get(identityId);
      if (!identity) throw new Error("media_screen_authority_incomplete");
      try {
        activeIdentity(state, { tenantId: state.room.tenantId, roomId: state.room.roomId,
          identityId: identity.identityId, participantId: identity.participantId, authEpoch: identity.authEpoch });
        if (getRoomPermissions(role).includes("screen-share.start")) publishers.add(identity.participantId);
      } catch (error) {
        if (!(error instanceof IdentityStorageError)) throw error;
      }
    }
  }
  return Object.freeze({ revision: state.authority.revision, roomActive,
    publisherParticipantIds: Object.freeze([...publishers].sort()),
    removedParticipantIds: Object.freeze(Object.keys(state.authority.lifecycle.removedParticipants).sort()),
    ...(state.roomObservationVersion ? { observationVersion: state.roomObservationVersion } : {}) });
}
