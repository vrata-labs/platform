import type { RoomSessionControlState } from "../storage-contracts.js";
import { IdentityStorageError, type IdentityTransaction, type RoomIdentityActor, type RoomIdentityLifecycle, type RoomIdentityProof, type RoomIdentityRecord } from "./contracts.js";

export function fail(code: ConstructorParameters<typeof IdentityStorageError>[0]): never { throw new IdentityStorageError(code); }
export const validId = (value: unknown): value is string => typeof value === "string" && value.length > 0 && value.length <= 200 && !/[\u0000-\u001f]/.test(value);
export const validCounter = (value: unknown): value is number => Number.isInteger(value) && Number(value) >= 0 && Number(value) <= 2_147_483_647;

export function identityLifecycle(input?: RoomSessionControlState | null): RoomIdentityLifecycle {
  const removed = input?.removedParticipants ?? {};
  if (typeof removed !== "object" || Array.isArray(removed) || !Object.keys(removed).every(validId)) fail("invalid_identity_input");
  return {
    lockedAt: input?.lockedAt ?? null, lockedBy: input?.lockedBy ?? null,
    endedAt: input?.endedAt ?? null, endedBy: input?.endedBy ?? null,
    presenterGrantedAt: input?.presenterGrantedAt ?? null, presenterGrantedBy: input?.presenterGrantedBy ?? null,
    presenterRevokedAt: input?.presenterRevokedAt ?? null, presenterRevokedBy: input?.presenterRevokedBy ?? null,
    removedParticipants: structuredClone(removed)
  };
}

export function identityWasRemoved(state: IdentityTransaction, participantId: string): boolean {
  return Object.hasOwn(state.authority.lifecycle.removedParticipants, participantId);
}

export function assertRoomActive(state: IdentityTransaction): void {
  if (state.room.status === "disabled" || state.room.disabledAt || state.authority.lifecycle.endedAt) fail("room_blocked");
}

/** The authenticated session deadline is separate from the durable identity.
 * Sample after lock waits and before mutation; expiry is renewable, not revoke. */
export function assertActorSession(actor: RoomIdentityActor, nowMs: number): void {
  if (actor?.actorType !== "room-session") return;
  if (!Number.isSafeInteger(actor.expiresAtSeconds) || actor.expiresAtSeconds <= 0
    || !Number.isSafeInteger(nowMs) || nowMs < 0 || nowMs >= actor.expiresAtSeconds * 1000) {
    fail("identity_session_expired");
  }
}

export function activeIdentity(state: IdentityTransaction, proof: RoomIdentityProof): RoomIdentityRecord {
  const identity = state.identities.get(proof.identityId);
  if (!identity || identity.tenantId !== proof.tenantId || identity.roomId !== proof.roomId
    || identity.participantId !== proof.participantId || identity.authEpoch !== proof.authEpoch || identity.revokedAt
    || identityWasRemoved(state, identity.participantId)) fail("identity_not_active");
  return identity;
}

export function checkRevision(state: IdentityTransaction, expected: number): void {
  if (!validCounter(expected) || state.authority.revision !== expected) fail("authority_conflict");
}

export function bumpAuthority(state: IdentityTransaction): void {
  if (!validCounter(state.authority.revision) || state.authority.revision === 2_147_483_647) fail("authority_conflict");
  state.authority.revision++;
}
