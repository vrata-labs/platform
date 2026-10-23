import type { RoomIdentityCredential } from "@vrata/shared-types/identity-credential";
import { activeIdentity } from "./authority.js";
import { IdentityStorageError, type IdentityTransaction, type RoomIdentityRecord } from "./contracts.js";

export class PersonalOwnerRoomBlocked extends IdentityStorageError {
  constructor(readonly reason: "room_disabled" | "session_ended") {
    super("room_blocked"); this.name = "PersonalOwnerRoomBlocked";
  }
}

/** The API supplies MAC-verified RI2 claims, never an RS2 or public owner ID.
 * Credential expiry is recovery refusal, distinct from renewable session expiry. */
export function assertPersonalOwnerResponse(state: IdentityTransaction | null, proof: RoomIdentityCredential,
  nowMs: number): RoomIdentityRecord {
  if (!state || state.minimumProtocol < 2 || state.room.tenantId !== proof.tenantId
    || state.room.roomId !== proof.roomId || state.room.roomType !== "personal") {
    throw new IdentityStorageError("room_not_found");
  }
  if (state.room.status === "disabled" || state.room.disabledAt) throw new PersonalOwnerRoomBlocked("room_disabled");
  if (state.authority.lifecycle.endedAt) throw new PersonalOwnerRoomBlocked("session_ended");
  const identity = activeIdentity(state, proof);
  if (state.authority.ownerIdentityId !== identity.identityId) throw new IdentityStorageError("identity_forbidden");
  if (proof.version !== 2 || proof.purpose !== "room-identity" || !Number.isSafeInteger(proof.expiresAtSeconds)
    || !Number.isSafeInteger(nowMs) || nowMs < 0 || nowMs >= proof.expiresAtSeconds * 1000) {
    throw new IdentityStorageError("identity_not_active");
  }
  return identity;
}
