import { getRoomPermissions, hasRoomPermission, type RoomPermission } from "@vrata/shared-types";
import { activeIdentity, assertRoomActive } from "./authority.js";
import { IdentityStorageError, type IdentityTransaction, type RoomIdentityProof } from "./contracts.js";

export interface RoomEffectGuard extends RoomIdentityProof {
  permission: RoomPermission;
  expiresAtSeconds: number;
  ownerOnly?: boolean;
}

type CurrentEffectActor = { identity: RoomIdentityProof; permissions: RoomPermission[]; isOwner: boolean };

export function assertCurrentEffect(guard: RoomEffectGuard, current: CurrentEffectActor | null,
  nowMs = Date.now()): void {
  if (!current || current.identity.tenantId !== guard.tenantId || current.identity.roomId !== guard.roomId
    || current.identity.identityId !== guard.identityId || current.identity.participantId !== guard.participantId
    || current.identity.authEpoch !== guard.authEpoch || nowMs >= guard.expiresAtSeconds * 1000) {
    throw new IdentityStorageError("identity_not_active");
  }
  if (!hasRoomPermission(current.permissions, guard.permission) || guard.ownerOnly && !current.isOwner) {
    throw new IdentityStorageError("identity_forbidden");
  }
}

/** The in-memory adapter runs the check synchronously, before invoking a
 * callback that immediately performs its in-memory DB mutation. */
export function assertMemoryEffect(state: IdentityTransaction, guard: RoomEffectGuard, nowMs = Date.now()): void {
  assertRoomActive(state);
  const identity = activeIdentity(state, guard);
  const role = state.authority.hostIdentityId === identity.identityId ? "host"
    : state.authority.presenterIdentityId === identity.identityId ? "presenter" : identity.baseRole;
  assertCurrentEffect(guard, { identity,
    permissions: getRoomPermissions(role), isOwner: state.authority.ownerIdentityId === identity.identityId }, nowMs);
}
