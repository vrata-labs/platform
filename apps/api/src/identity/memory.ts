import { randomUUID } from "node:crypto";
import { IdentityStorageError, type IdentityPersistence, type IdentityRoomBinding, type IdentitySelection, type IdentityTransaction, type RoomIdentityActor, type RoomIdentityAuthority, type RoomIdentityPending, type RoomIdentityRecord, type RoomIdentityRecovery, type RoomIdentityScope } from "./contracts.js";
import type { RoomInviteRecord, WaitingRoomRequestRecord } from "../storage-contracts.js";
import { createRoomIdentityStorage, emptyIdentityAuthority } from "./store.js";
import { admissionWindows, assertAdmissionLimitInput, type AdmissionLimitInput } from "./admission-limits.js";
import { assertMemoryEffect, type RoomEffectGuard } from "./effect-write-guard.js";
import { assertActorSession } from "./authority.js";
import { assertPersonalOwnerResponse } from "./personal-owner-response.js";
import type { RoomIdentityCredential } from "@vrata/shared-types/identity-credential";

export function createMemoryRoomIdentities(getRoom: (roomId: string) => IdentityRoomBinding | undefined, now = Date.now,
  getInviteByHash: (hash: string) => RoomInviteRecord | undefined = () => undefined, getMinimumProtocol = () => 1,
  getInviteById: (id: string) => RoomInviteRecord | undefined = () => undefined,
  getWaitingRequest: (id: string) => WaitingRoomRequestRecord | undefined = () => undefined,
  saveWaitingRequest: (request: WaitingRoomRequestRecord) => void = () => undefined) {
  const identities = new Map<string, Map<string, RoomIdentityRecord>>();
  const authorities = new Map<string, RoomIdentityAuthority>();
  const recoveries = new Map<string, Map<string, RoomIdentityRecovery>>();
  const pendingByRoom = new Map<string, Map<string, RoomIdentityPending>>();
  const snapshot = (scope: RoomIdentityScope, selection: IdentitySelection): IdentityTransaction | null => {
    const room = getRoom(scope.roomId);
    if (!room || room.tenantId !== scope.tenantId) return null;
    if (authorities.has(scope.roomId) && authorities.get(scope.roomId)!.tenantId !== scope.tenantId) return null;
    const recovery = selection.recoveryId ? recoveries.get(scope.roomId)?.get(selection.recoveryId) ?? null : null;
    const pending = selection.pendingId ? pendingByRoom.get(scope.roomId)?.get(selection.pendingId) ?? null : null;
    const participantId = selection.participantId ?? recovery?.targetParticipantId;
    const selected = new Set([...(selection.identityIds ?? []), ...(recovery?.targetIdentityId ? [recovery.targetIdentityId] : [])]);
    const invite = selection.inviteTokenHash ? getInviteByHash(selection.inviteTokenHash) ?? null
      : pending ? getInviteById(pending.inviteId) ?? null : null;
    const waitingRequest = pending ? getWaitingRequest(pending.requestId) ?? null : null;
    const open = invite && selection.inviteTokenHash
      ? [...(pendingByRoom.get(scope.roomId)?.values() ?? [])].filter(value => !value.activatedAt && Date.parse(value.expiresAt) > now()) : null;
    const pendingCapacity = open ? { room: open.length, invite: open.filter(value => value.inviteId === invite!.inviteId).length,
      lifetimeRoom: pendingByRoom.get(scope.roomId)?.size ?? 0 } : null;
    return structuredClone({ room, minimumProtocol: getMinimumProtocol(), authority: authorities.get(scope.roomId) ?? emptyIdentityAuthority(scope, room.sessionControl), recovery, invite, pending, waitingRequest, waitingRequestNew: false, pendingCapacity,
      identityCount: selection.admissionCount ? identities.get(scope.roomId)?.size ?? 0 : null,
      identities: new Map([...(identities.get(scope.roomId) ?? new Map<string, RoomIdentityRecord>())].filter(([id, identity]) =>
        selected.has(id) || (participantId !== undefined && identity.participantId === participantId))) });
  };
  const persistence: IdentityPersistence = {
    async read(scope, selection) { return snapshot(scope, selection); },
    async transact(scope, selection, apply) {
      // The whole read/reduce/commit is synchronous: no await can interleave a
      // room delete, another recovery or a role transfer in this adapter.
      const state = snapshot(scope, selection);
      if (!state) throw new IdentityStorageError("room_not_found");
      const result = apply(state);
      const roomIdentities = identities.get(scope.roomId) ?? new Map<string, RoomIdentityRecord>();
      for (const record of state.identities.values()) {
        const existing = [...roomIdentities.values()].find(item => item.participantId === record.participantId && item.identityId !== record.identityId);
        if (existing) throw new IdentityStorageError("identity_conflict");
      }
      for (const record of state.identities.values()) roomIdentities.set(record.identityId, structuredClone(record));
      identities.set(scope.roomId, roomIdentities);
      authorities.set(scope.roomId, structuredClone(state.authority));
      if (state.recovery) {
        const roomRecoveries = recoveries.get(scope.roomId) ?? new Map<string, RoomIdentityRecovery>();
        roomRecoveries.set(state.recovery.recoveryId, structuredClone(state.recovery));
        recoveries.set(scope.roomId, roomRecoveries);
      }
      if (state.waitingRequestNew && state.waitingRequest) saveWaitingRequest(structuredClone(state.waitingRequest));
      if (state.pending) {
        const pending = pendingByRoom.get(scope.roomId) ?? new Map<string, RoomIdentityPending>();
        pending.set(state.pending.pendingId, structuredClone(state.pending));
        pendingByRoom.set(scope.roomId, pending);
      }
      return result;
    }
  };
  return {
    storage: createRoomIdentityStorage(persistence, now),
    assertPersonalOwnerResponse(proof: RoomIdentityCredential) {
      return assertPersonalOwnerResponse(snapshot(proof, { identityIds: [proof.identityId] }), proof, now());
    },
    assertCurrentEffect(guard: RoomEffectGuard) {
      const room = getRoom(guard.roomId);
      const state = room && snapshot(room, { identityIds: [guard.identityId] });
      if (!state || state.minimumProtocol < 2) throw new IdentityStorageError("room_not_found");
      return assertMemoryEffect(state, guard, now());
    },
    authorizeInvite(roomId: string, actor: RoomIdentityActor, create: (atMs: number) => RoomInviteRecord): RoomInviteRecord {
      const room = getRoom(roomId);
      if (!room || getMinimumProtocol() < 2 || room.status === "disabled" || room.disabledAt) throw new IdentityStorageError("room_blocked");
      const state = snapshot(room, { identityIds: actor.actorType === "room-session" ? [actor.proof.identityId] : [] });
      if (!state || state.authority.lifecycle.endedAt) throw new IdentityStorageError("room_blocked");
      const at = now();
      assertActorSession(actor, at);
      if (actor.actorType === "room-session") {
        const proof = actor.proof;
        const identity = state.identities.get(proof.identityId);
        if (!identity || identity.revokedAt || identity.tenantId !== room.tenantId || identity.roomId !== roomId
          || identity.participantId !== proof.participantId || identity.authEpoch !== proof.authEpoch
          || ![state.authority.hostIdentityId, state.authority.ownerIdentityId].includes(identity.identityId)) throw new IdentityStorageError("identity_forbidden");
      } else if (actor.role !== "admin" || !actor.actorId) throw new IdentityStorageError("identity_forbidden");
      return create(at);
    },
    bootstrapOwner(room: IdentityRoomBinding, participantId: string, displayName: string): RoomIdentityRecord {
      if (room.roomType !== "personal" || room.ownerParticipantId !== participantId || authorities.has(room.roomId)
        || identities.has(room.roomId) || !Number.isSafeInteger(now()) || displayName.length > 80) {
        throw new IdentityStorageError("identity_forbidden");
      }
      const identity: RoomIdentityRecord = {
        tenantId: room.tenantId, roomId: room.roomId, identityId: randomUUID(), participantId,
        displayName, authEpoch: 1, baseRole: "member", provenance: { kind: "personal-owner" },
        createdAt: new Date(now()).toISOString(), revokedAt: null
      };
      identities.set(room.roomId, new Map([[identity.identityId, structuredClone(identity)]]));
      authorities.set(room.roomId, { ...emptyIdentityAuthority(room, room.sessionControl), hostIdentityId: identity.identityId,
        ownerIdentityId: identity.identityId, revision: 1 });
      return structuredClone(identity);
    },
    hasRoomBindings(roomId: string) { return authorities.has(roomId); },
    deleteRoom(roomId: string) { identities.delete(roomId); authorities.delete(roomId); recoveries.delete(roomId); pendingByRoom.delete(roomId); }
  };
}
