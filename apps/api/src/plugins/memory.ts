import { RoomPluginStorageError, type RoomPluginPackage, type RoomPluginRoomState, type RoomPluginScope,
  type RoomPluginTransaction, type StoredRoomPluginBinding } from "./contracts.js";
import { createRoomPluginStorage } from "./storage.js";

interface MemoryRoomPlugins extends RoomPluginRoomState {
  packages: Map<string, RoomPluginPackage>;
  bindings: Map<string, StoredRoomPluginBinding>;
}
interface MemoryRoomLock { tail: Promise<void>; readers: Set<Promise<void>>; writers: number }

export function createMemoryRoomPlugins(getRoom: (roomId: string) => { tenantId: string } | undefined) {
  const rooms = new Map<string, MemoryRoomPlugins>();
  const locks = new Map<string, MemoryRoomLock>();
  const key = (scope: RoomPluginScope) => JSON.stringify([scope.tenantId, scope.roomId]);
  const storage = createRoomPluginStorage({
    async transaction(scope, operation, options) {
      const id = key(scope);
      const lock = locks.get(id) ?? { tail: Promise.resolve(), readers: new Set<Promise<void>>(), writers: 0 };
      locks.set(id, lock);
      // Reads share the preceding writer fence. A later writer waits for all already-admitted reads,
      // and reads admitted behind that writer wait for it, preserving queue order without starvation.
      const previous = options?.readOnly ? lock.tail : Promise.all([lock.tail, ...lock.readers]).then(() => undefined);
      let release!: () => void;
      const held = new Promise<void>(resolve => { release = resolve; });
      if (options?.readOnly) lock.readers.add(held);
      else { lock.writers++; lock.tail = previous.then(() => held); }
      await previous;
      try {
        if (getRoom(scope.roomId)?.tenantId !== scope.tenantId) throw new RoomPluginStorageError("room_not_found");
        // Work on a private copy so a validation/error rolls back all metadata, like Postgres.
        const data: MemoryRoomPlugins = structuredClone(rooms.get(id) ?? { revision: 0, deleting: false, deletionId: null,
          cleanupPackageIds: [], packages: new Map(), bindings: new Map() });
        const writing = () => { if (options?.readOnly) throw new Error("plugin_read_only_transaction"); };
        const tx: RoomPluginTransaction = {
          state: data,
          async saveState() { writing(); },
          async findVersion(pluginId, version) { return [...data.packages.values()].find(value => value.pluginId === pluginId && value.version === version) ?? null; },
          async getPackage(packageId) { return data.packages.get(packageId) ?? null; },
          async listPackages(includeDeleted = false) { return [...data.packages.values()].filter(value => includeDeleted || value.state !== "deleted").sort((a, b) => a.packageId.localeCompare(b.packageId)); },
          async quota() { const values = [...data.packages.values()].filter(value => value.state !== "deleted"); return { count: values.length, bytes: values.reduce((sum, value) => sum + value.byteLength, 0), lifetimeCount: data.packages.size }; },
          async insertPackage(value) { writing(); data.packages.set(value.packageId, value); },
          async setPackageState(packageId, state) { writing(); data.packages.get(packageId)!.state = state; },
          async setUploadSettled(packageId) { writing(); data.packages.get(packageId)!.uploadSettled = true; },
          async listBindings() { return [...data.bindings.values()].sort((a, b) => a.pluginId < b.pluginId ? -1 : a.pluginId > b.pluginId ? 1 : 0); },
          async getBinding(pluginId) { return data.bindings.get(pluginId) ?? null; },
          async saveBinding(value) { writing(); data.bindings.set(value.pluginId, value); },
          async deleteBinding(pluginId) { writing(); if (pluginId === undefined) data.bindings.clear(); else data.bindings.delete(pluginId); }
        };
        const result = await operation(tx);
        if (getRoom(scope.roomId)?.tenantId !== scope.tenantId) throw new RoomPluginStorageError("room_not_found");
        if (!options?.readOnly) rooms.set(id, structuredClone(data));
        return structuredClone(result);
      } finally {
        release();
        if (options?.readOnly) lock.readers.delete(held);
        else lock.writers--;
        if (!lock.readers.size && !lock.writers) locks.delete(id);
      }
    }
  });
  return {
    storage,
    /** Synchronous room-delete guard; never yields between inspection and the caller's map deletion. */
    assertRoomDeletable(scope: RoomPluginScope, deletionId?: string) {
      const id = key(scope);
      if (locks.has(id)) throw new RoomPluginStorageError("room_plugin_cleanup_pending");
      const data = rooms.get(id);
      if (deletionId !== undefined && data?.deletionId !== deletionId) throw new RoomPluginStorageError("room_plugin_cleanup_pending");
      if (data && ([...data.packages.values()].some(value => value.state !== "deleted") || data.bindings.size)) {
        throw new RoomPluginStorageError("room_plugin_cleanup_pending");
      }
      rooms.delete(id);
    }
  };
}
