import { getRoomPermissions } from "@vrata/shared-types";
import { activeIdentity, assertRoomActive, identityWasRemoved } from "./authority.js";
import { IdentityStorageError, type IdentityTransaction, type RoomMediaParticipantState, type RoomScreenSourceAuthority } from "./contracts.js";

export function projectScreenSourceAuthority(state: IdentityTransaction, participantIds?: readonly string[]): RoomScreenSourceAuthority | null {
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
  let participants: Record<string, RoomMediaParticipantState> | undefined;
  if (participantIds) {
    const byParticipant = new Map([...state.identities.values()].map(identity => [identity.participantId, identity]));
    // Own data properties only: any valid ID, "__proto__" included, is a key, never a prototype write.
    participants = Object.fromEntries([...new Set(participantIds)].sort().flatMap(participantId => {
      const identity = byParticipant.get(participantId);
      return identity ? [[participantId, Object.freeze({ epoch: identity.authEpoch,
        active: !identity.revokedAt && !identityWasRemoved(state, participantId) })]] : [];
    }));
  }
  return Object.freeze({ revision: state.authority.revision, roomActive, roomEnded: state.authority.lifecycle.endedAt != null,
    publisherParticipantIds: Object.freeze([...publishers].sort()),
    removedParticipantIds: Object.freeze(Object.keys(state.authority.lifecycle.removedParticipants).sort()),
    ...(state.roomObservationVersion ? { observationVersion: state.roomObservationVersion } : {}),
    ...(state.mediaIncarnation ? { mediaIncarnation: state.mediaIncarnation } : {}),
    ...(participants ? { participants: Object.freeze(participants) } : {}) });
}
