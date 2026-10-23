import { validateRoomPluginArtifact } from "@vrata/room-plugin-sdk/artifact";
import type { Storage } from "../storage-contracts.js";
import { RoomPluginBlobWriteUncertain, type RoomPluginBlobStorage } from "./blob-storage.js";
import { RoomPluginStorageError, type RoomPluginPackage, type RoomPluginScope, type RoomPluginStorage } from "./contracts.js";
import { RoomPluginBlobConfigurationError } from "./blob-errors.js";

export class RoomPluginOperationPending extends Error {
  constructor(readonly packageId: string, cause: unknown) { super("plugin_operation_pending", { cause }); this.name = "RoomPluginOperationPending"; }
}

/** Internal library only. T05 must supply fresh author/session authority at each metadata transition. */
export function createRoomPluginPackageService(storage: RoomPluginStorage, blobs: RoomPluginBlobStorage) {
  function sameBackend(value: RoomPluginPackage): void {
    if (!value.backendFingerprint || value.backendFingerprint !== blobs.backendFingerprint) {
      throw new RoomPluginBlobConfigurationError("plugin_blob_backend_mismatch");
    }
  }
  async function cleanup(scope: RoomPluginScope, value: RoomPluginPackage): Promise<void> {
    if (value.state === "deleted") return;
    if (value.state !== "cleanup-pending") throw new RoomPluginStorageError("plugin_upload_pending");
    if (!value.uploadSettled) throw new RoomPluginStorageError("plugin_upload_pending");
    sameBackend(value);
    // Keep the key and intent until the idempotent delete is acknowledged; no IO inside the DB fence.
    await blobs.delete(scope, value.storageKey);
    await storage.confirmPackageDeletion(scope, value.packageId);
  }
  return {
    async savePackage(scope: RoomPluginScope, originalBytes: Uint8Array): Promise<RoomPluginPackage> {
      scope = { tenantId: scope.tenantId, roomId: scope.roomId };
      const validated = validateRoomPluginArtifact(originalBytes);
      const reservation = await storage.reservePackage(scope, validated.bytes, blobs.backendFingerprint);
      sameBackend(reservation.package);
      if (!reservation.created) return reservation.package;
      const value = reservation.package;
      try { await blobs.put(scope, value.storageKey, validated.bytes); }
      catch (error) {
        // Do not delete a key after a lost remote acknowledgement: the single PUT may still be running.
        if (error instanceof RoomPluginBlobWriteUncertain) throw new RoomPluginOperationPending(value.packageId, error);
        try {
          const failed = await storage.failPackageUpload(scope, value.packageId);
          if (failed.state === "ready") return failed;
          await cleanup(scope, failed);
        } catch (compensationError) { throw new RoomPluginOperationPending(value.packageId, compensationError); }
        throw error;
      }
      let published: RoomPluginPackage;
      try {
        // Persist PUT completion before publication so a restart cannot replace settlement with a GET guess.
        await storage.confirmPackageUpload(scope, value.packageId);
        published = await storage.publishPackage(scope, value.packageId);
      }
      catch (error) { throw new RoomPluginOperationPending(value.packageId, error); }
      if (published.state === "cleanup-pending") {
        try { await cleanup(scope, published); }
        catch (error) { throw new RoomPluginOperationPending(value.packageId, error); }
        throw new RoomPluginStorageError("room_plugin_cleanup_pending");
      }
      return published;
    },
    async deletePackage(scope: RoomPluginScope, id: string): Promise<void> {
      scope = { tenantId: scope.tenantId, roomId: scope.roomId };
      await cleanup(scope, await storage.beginPackageDeletion(scope, id));
    },
    async readPackage(scope: RoomPluginScope, id: string): Promise<Uint8Array> {
      scope = { tenantId: scope.tenantId, roomId: scope.roomId };
      const value = await storage.getPackage(scope, id);
      if (!value) throw new RoomPluginStorageError("plugin_package_not_found");
      if (value.state !== "ready") throw new RoomPluginStorageError("plugin_package_not_ready");
      sameBackend(value);
      return validateRoomPluginArtifact(await blobs.read(scope, value.storageKey), value.artifactSha256).bytes;
    },
    async reconcileUpload(scope: RoomPluginScope, id: string): Promise<RoomPluginPackage> {
      scope = { tenantId: scope.tenantId, roomId: scope.roomId };
      const value = await storage.getPackage(scope, id);
      if (!value) throw new RoomPluginStorageError("plugin_package_not_found");
      if (value.state !== "reserved") return value;
      // A read, even with the exact checksum, cannot settle the original writer. Retain the reservation
      // until its trusted owner records a terminal outcome; never launch another PUT or guess a timeout.
      if (!value.uploadSettled) throw new RoomPluginStorageError("plugin_upload_pending");
      sameBackend(value);
      validateRoomPluginArtifact(await blobs.read(scope, value.storageKey), value.artifactSha256);
      const published = await storage.publishPackage(scope, id);
      if (published.state === "cleanup-pending") await cleanup(scope, published);
      return (await storage.getPackage(scope, id))!;
    },
    async cleanupRoom(scope: RoomPluginScope): Promise<{ deletionId: string }> {
      scope = { tenantId: scope.tenantId, roomId: scope.roomId };
      const intent = await storage.beginRoomDeletion(scope);
      for (const value of intent.packages) if (value.state === "cleanup-pending") await cleanup(scope, value);
      if (intent.packages.some(value => value.state === "reserved")) throw new RoomPluginStorageError("plugin_upload_pending");
      return { deletionId: intent.deletionId };
    }
  };
}

export async function deleteRoomWithPluginCleanup(storage: Storage, scope: RoomPluginScope,
  getBlobs: () => RoomPluginBlobStorage): Promise<boolean> {
  scope = { tenantId: scope.tenantId, roomId: scope.roomId };
  // Resolve configuration lazily: ordinary legacy rooms must not need object-storage credentials to delete.
  let resolved: RoomPluginBlobStorage | undefined;
  const backend = () => resolved ??= getBlobs();
  const lazy: RoomPluginBlobStorage = {
    get backendFingerprint() { return backend().backendFingerprint; },
    put: (...args) => backend().put(...args), read: (...args) => backend().read(...args), delete: (...args) => backend().delete(...args)
  };
  const intent = await createRoomPluginPackageService(storage.roomPlugins, lazy).cleanupRoom(scope);
  return storage.deleteRoom(scope.roomId, { tenantId: scope.tenantId, deletionId: intent.deletionId });
}
