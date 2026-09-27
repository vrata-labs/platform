import { IdentityStorageError, type IdentityPersistence, type IdentityRoomBinding, type IdentitySelection, type IdentityTransaction, type RoomIdentityAuthority, type RoomIdentityRecord, type RoomIdentityRecovery, type RoomIdentityScope } from "./contracts.js";
import { createRoomIdentityStorage, emptyIdentityAuthority } from "./store.js";

export function createMemoryRoomIdentities(getRoom: (roomId: string) => IdentityRoomBinding | undefined, now = Date.now) {
  const identities = new Map<string, Map<string, RoomIdentityRecord>>();
  const authorities = new Map<string, RoomIdentityAuthority>();
  const recoveries = new Map<string, Map<string, RoomIdentityRecovery>>();
  const snapshot = (scope: RoomIdentityScope, selection: IdentitySelection): IdentityTransaction | null => {
    const room = getRoom(scope.roomId);
    if (!room || room.tenantId !== scope.tenantId) return null;
    if (authorities.has(scope.roomId) && authorities.get(scope.roomId)!.tenantId !== scope.tenantId) return null;
    const recovery = selection.recoveryId ? recoveries.get(scope.roomId)?.get(selection.recoveryId) ?? null : null;
    const participantId = selection.participantId ?? recovery?.targetParticipantId;
    const selected = new Set([...(selection.identityIds ?? []), ...(recovery?.targetIdentityId ? [recovery.targetIdentityId] : [])]);
    return structuredClone({ room, authority: authorities.get(scope.roomId) ?? emptyIdentityAuthority(scope), recovery,
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
      return result;
    }
  };
  return {
    storage: createRoomIdentityStorage(persistence, now),
    hasRoomBindings(roomId: string) { return authorities.has(roomId); },
    deleteRoom(roomId: string) { identities.delete(roomId); authorities.delete(roomId); recoveries.delete(roomId); }
  };
}
