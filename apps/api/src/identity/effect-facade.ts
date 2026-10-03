import type { RoomEffectDatabase, RoomIdentityEffectStorage } from "../storage-contracts.js";

/** Expose only DB-only operations. Memory rechecks each operation/release so
 * an await gap cannot preserve legacy authority across a protocol change. */
export function createRoomEffectFacade(database: RoomEffectDatabase, options: {
  check?: () => void; roomWrite?: boolean;
}): RoomIdentityEffectStorage {
  let released = false;
  const invoke = <T>(operation: () => T, roomWrite = false, required = "room_write_fence_required"): T => {
    options.check?.();
    if (released) throw new Error("room_effect_response_released");
    if (roomWrite && !options.roomWrite) throw new Error(required);
    return operation();
  };
  return {
    upsertRoomNote: (...args) => invoke(() => database.upsertRoomNote(...args)),
    deleteRoomNote: (...args) => invoke(() => database.deleteRoomNote(...args)),
    restoreRoomNoteVersion: (...args) => invoke(() => database.restoreRoomNoteVersion(...args)),
    createRoomDocument: (...args) => invoke(() => database.createRoomDocument(...args)),
    markRoomDocumentDeleted: (...args) => invoke(() => database.markRoomDocumentDeleted(...args)),
    updateRoomDocumentSurface: (...args) => invoke(() => database.updateRoomDocumentSurface(...args)),
    getRoomDocument: (...args) => invoke(() => database.getRoomDocument(...args)),
    getRoom: (...args) => invoke(() => database.getRoom(...args)),
    getPersonalRoomState: (...args) => invoke(() => database.getPersonalRoomState(...args)),
    updatePersonalRoomState: (...args) => invoke(() => database.updatePersonalRoomState(...args), true, "personal_state_requires_room_write_fence"),
    setRoomSceneBundleUrl: (...args) => invoke(() => database.setRoomSceneBundleUrl(...args), true, "scene_binding_requires_room_write_fence"),
    listRoomInvites: (...args) => invoke(() => database.listRoomInvites(...args)),
    revokeRoomInvite: (...args) => invoke(() => database.revokeRoomInvite(...args)),
    listWaitingRoomRequests: (...args) => invoke(() => database.listWaitingRoomRequests(...args)),
    updateWaitingRoomRequest: (...args) => invoke(() => database.updateWaitingRoomRequest(...args)),
    releaseResponse: send => invoke(() => { released = true; send(); })
  };
}
