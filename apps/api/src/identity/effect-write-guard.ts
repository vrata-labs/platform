import { getRoomPermissions, hasRoomPermission, isRoomPermission, isRoomRole, type RoomPermission, type RoomRole } from "@vrata/shared-types";
import { activeIdentity, assertActorSession, assertRoomActive } from "./authority.js";
import { IdentityStorageError, type IdentityTransaction, type RoomIdentityProof } from "./contracts.js";

export interface RoomEffectGuard extends RoomIdentityProof {
  permission: RoomPermission;
  /** Effects with multiple granted capabilities must hold each permission on the same authority snapshot. */
  alsoRequired?: readonly RoomPermission[];
  expiresAtSeconds: number;
  ownerOnly?: boolean;
  hostOrOwner?: boolean;
  roomWrite?: boolean;
  /** Exact current role and ownership of the original proof, when set; false is enforced, never treated as unset. */
  expectedRole?: RoomRole;
  expectedIsOwner?: boolean;
  /** Media issuance: the boundary and room generation the prepared grant names. The fence holds the
   * policy row FOR SHARE, so a codec raise waits for it and a grant naming a retired codec is refused. */
  media?: MediaGrantPin;
}

export interface MediaGrantPin { readonly codec: 2 | 3; readonly namespace: string; readonly incarnation?: string }

/** The prepared media grant names a boundary or room generation that is no longer current; a retry re-prepares it. */
export class MediaBoundaryChanged extends Error {
  constructor() { super("media_boundary_changed"); this.name = "MediaBoundaryChanged"; }
}

/** Codec 3 names exactly one room incarnation; codec 2 names none. */
export function assertMediaGrantPin(pin: MediaGrantPin | undefined,
  current: { codec: unknown; namespace: unknown; incarnation: unknown }): void {
  if (!pin) return;
  if ((pin.codec !== 2 && pin.codec !== 3) || typeof pin.namespace !== "string"
    || (pin.codec === 3) !== (typeof pin.incarnation === "string")) throw new IdentityStorageError("invalid_identity_input");
  if (current.codec !== pin.codec || current.namespace !== pin.namespace
    || pin.codec === 3 && current.incarnation !== pin.incarnation) throw new MediaBoundaryChanged();
}

/** Valid only while the callback holds its room fence; never cache this actor. */
export type RoomEffectActor = { identity: RoomIdentityProof; role: RoomRole; permissions: RoomPermission[]; isOwner: boolean };

export function assertCurrentEffect(guard: RoomEffectGuard, current: RoomEffectActor | null,
  nowMs = Date.now()): RoomEffectActor {
  // Malformed pins are typed invalid input before any comparison; an unset pin compares nothing.
  if (guard.expectedRole !== undefined && !isRoomRole(guard.expectedRole)
    || guard.expectedIsOwner !== undefined && typeof guard.expectedIsOwner !== "boolean"
    || guard.alsoRequired !== undefined && (!Array.isArray(guard.alsoRequired) || guard.alsoRequired.length > 16
      || guard.alsoRequired.some(permission => !isRoomPermission(permission)))) {
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
    || guard.alsoRequired?.some(permission => !hasRoomPermission(current.permissions, permission))
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
