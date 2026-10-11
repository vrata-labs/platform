import { getRoomPermissions, hasRoomPermission, isRoomRole, type RoomPermission, type RoomRole } from "@vrata/shared-types";
import { activeIdentity, assertActorSession, assertRoomActive } from "./authority.js";
import { IdentityStorageError, type IdentityTransaction, type RoomIdentityProof } from "./contracts.js";

export interface RoomEffectGuard extends RoomIdentityProof {
  permission: RoomPermission;
  expiresAtSeconds: number;
  ownerOnly?: boolean;
  hostOrOwner?: boolean;
  roomWrite?: boolean;
  /** Exact current role and ownership of the original proof, when set; false is enforced, never treated as unset. */
  expectedRole?: RoomRole;
  expectedIsOwner?: boolean;
}

/** Valid only while the callback holds its room fence; never cache this actor. */
export type RoomEffectActor = { identity: RoomIdentityProof; role: RoomRole; permissions: RoomPermission[]; isOwner: boolean };

export function assertCurrentEffect(guard: RoomEffectGuard, current: RoomEffectActor | null,
  nowMs = Date.now()): RoomEffectActor {
  // Malformed pins are typed invalid input before any comparison; an unset pin compares nothing.
  if (guard.expectedRole !== undefined && !isRoomRole(guard.expectedRole)
    || guard.expectedIsOwner !== undefined && typeof guard.expectedIsOwner !== "boolean") {
    throw new IdentityStorageError("invalid_identity_input");
  }
  if (!current || current.identity.tenantId !== guard.tenantId || current.identity.roomId !== guard.roomId
    || current.identity.identityId !== guard.identityId || current.identity.participantId !== guard.participantId
    || current.identity.authEpoch !== guard.authEpoch) {
    throw new IdentityStorageError("identity_not_active");
  }
  assertActorSession({ actorType: "room-session", proof: guard, expiresAtSeconds: guard.expiresAtSeconds }, nowMs);
  // Drift from the pinned proof is recoverable, unlike a missing permission.
  if (guard.expectedRole !== undefined && current.role !== guard.expectedRole
    || guard.expectedIsOwner !== undefined && current.isOwner !== guard.expectedIsOwner) {
    throw new IdentityStorageError("identity_role_changed");
  }
  if (!hasRoomPermission(current.permissions, guard.permission) || guard.ownerOnly && !current.isOwner
    || guard.hostOrOwner && current.role !== "host" && !current.isOwner) {
    throw new IdentityStorageError("identity_forbidden");
  }
  return current;
}

/** The in-memory adapter runs the check synchronously, before invoking a
 * callback that immediately performs its in-memory DB mutation. */
export function assertMemoryEffect(state: IdentityTransaction, guard: RoomEffectGuard, nowMs = Date.now()): RoomEffectActor {
  assertRoomActive(state);
  const identity = activeIdentity(state, guard);
  const role = state.authority.hostIdentityId === identity.identityId ? "host"
    : state.authority.presenterIdentityId === identity.identityId ? "presenter" : identity.baseRole;
  return assertCurrentEffect(guard, { identity, role,
    permissions: getRoomPermissions(role), isOwner: state.authority.ownerIdentityId === identity.identityId }, nowMs);
}
